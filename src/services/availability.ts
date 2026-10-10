import { Types } from "mongoose";
import { Accommodation } from "../models/Accommodation";
import { Booking } from "../models/Booking";
import { Event } from "../models/Event";
import { notFound } from "../utils/AppError";
import { DAY } from "../utils/helpers";

/** Bookings that currently occupy / reserve a unit. Unpaid ones only block while their hold is valid. */
export const blockingFilter = (now = new Date()) => ({
  $or: [{ status: { $in: ["active", "awaiting_confirmation"] } }, { status: "pending_payment", holdExpiresAt: { $gt: now } }],
});

export function findConflicts(accommodationId: Types.ObjectId | string, start: Date, end: Date, excludeBookingId?: Types.ObjectId | string) {
  return Booking.find({
    accommodation: accommodationId,
    startDate: { $lt: end },
    endDate: { $gt: start },
    ...(excludeBookingId ? { _id: { $ne: excludeBookingId } } : {}),
    ...blockingFilter(),
  });
}

type Span = { startDate: Date; endDate: Date };

/** Highest number of simultaneous bookings at any moment inside [from, to). */
export function maxConcurrent(spans: Span[], from: Date, to: Date) {
  const points: [number, number][] = [];
  for (const s of spans) {
    const a = Math.max(s.startDate.getTime(), from.getTime());
    const b = Math.min(s.endDate.getTime(), to.getTime());
    if (a < b) points.push([a, 1], [b, -1]);
  }
  points.sort((x, y) => x[0] - y[0] || x[1] - y[1]); // at the same instant, check-outs free a unit before check-ins take one
  let cur = 0;
  let max = 0;
  for (const [, d] of points) {
    cur += d;
    if (cur > max) max = cur;
  }
  return max;
}

/** Time segments in which all `total` units are taken. */
export function fullSegments(spans: Span[], total: number, from: Date, to: Date) {
  const points: [number, number][] = [];
  for (const s of spans) {
    const a = Math.max(s.startDate.getTime(), from.getTime());
    const b = Math.min(s.endDate.getTime(), to.getTime());
    if (a < b) points.push([a, 1], [b, -1]);
  }
  points.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: { start: Date; end: Date }[] = [];
  let cur = 0;
  let openedAt: number | null = null;
  for (const [t, d] of points) {
    cur += d;
    if (cur >= total && openedAt === null) openedAt = t;
    if (cur < total && openedAt !== null) {
      if (t > openedAt) out.push({ start: new Date(openedAt), end: new Date(t) });
      openedAt = null;
    }
  }
  return out;
}

export interface Occupancy {
  totalUnits: number;
  used: number;
  unitsLeft: number;
  isFull: boolean;
}

/** How many units are free for the whole of [start, end) (i.e. the tightest moment in that window). */
export async function occupancy(accommodationId: Types.ObjectId | string, start: Date, end: Date, opts: { totalUnits?: number; excludeBookingId?: Types.ObjectId | string } = {}): Promise<Occupancy> {
  const total = opts.totalUnits ?? (await Accommodation.findById(accommodationId).select("totalUnits").lean())?.totalUnits ?? 1;
  const bookings = await findConflicts(accommodationId, start, end, opts.excludeBookingId).select("startDate endDate").lean();
  const used = maxConcurrent(bookings as Span[], start, end);
  const unitsLeft = Math.max(total - used, 0);
  return { totalUnits: total, used, unitsLeft, isFull: unitsLeft <= 0 };
}

/** Units free right now for many accommodations at once (used by listings). */
export async function unitsLeftNow(accs: { _id: Types.ObjectId; totalUnits?: number }[]) {
  const now = new Date();
  const taken = await Booking.aggregate([
    { $match: { accommodation: { $in: accs.map((a) => a._id) }, startDate: { $lte: now }, endDate: { $gt: now }, ...blockingFilter(now) } },
    { $group: { _id: "$accommodation", n: { $sum: 1 } } },
  ]);
  const map = new Map<string, number>(taken.map((t: { _id: Types.ObjectId; n: number }) => [String(t._id), t.n]));
  return (a: { _id: Types.ObjectId; totalUnits?: number }) => {
    const total = a.totalUnits ?? 1;
    const left = Math.max(total - (map.get(String(a._id)) ?? 0), 0);
    return { totalUnits: total, unitsLeft: left, isFull: left <= 0 };
  };
}

export interface Quote {
  accommodationId: string;
  startDate: Date;
  endDate: Date;
  durationDays: number;
  days: { date: Date; price: number; source: "base" | "event"; event?: string }[];
  total: number;
  available: boolean;
  isFull: boolean;
  totalUnits: number;
  unitsLeft: number;
  reasons: string[];
}

/**
 * Price + availability for a stay.
 * - Each 24h block is priced at the accommodation's base price, unless an active event covers it:
 *   then the accommodation must be opened for that event and the event price applies.
 * - A stay is possible only if at least one unit is free for the whole period.
 * - Locked/deleted accommodations are reported as not found so they stay invisible to visitors.
 */
export async function quote(accommodationId: string, startDate: Date, durationDays: number, opts: { excludeBookingId?: string } = {}): Promise<Quote> {
  if (!Types.ObjectId.isValid(accommodationId)) throw notFound("Accommodation");
  const acc = await Accommodation.findOne({ _id: accommodationId, deletedAt: null, isLocked: false });
  if (!acc) throw notFound("Accommodation");

  const endDate = new Date(startDate.getTime() + durationDays * DAY);
  const events = await Event.find({ isActive: true, startDate: { $lt: endDate }, endDate: { $gt: startDate } }).lean();

  const reasons = new Set<string>();
  const days: Quote["days"] = [];
  for (let i = 0; i < durationDays; i++) {
    const wStart = new Date(startDate.getTime() + i * DAY);
    const wEnd = new Date(wStart.getTime() + DAY);
    const covering = events.filter((e) => e.startDate < wEnd && e.endDate > wStart);
    if (!covering.length) {
      days.push({ date: wStart, price: acc.basePricePerDay, source: "base" });
      continue;
    }
    let price = 0;
    for (const ev of covering) {
      const entry = ev.accommodations.find((a: { accommodation: Types.ObjectId }) => a.accommodation.equals(acc._id));
      if (!entry || !entry.isAvailable) reasons.add(`Not available during "${ev.name}"`);
      else price = Math.max(price, entry.pricePerDay);
    }
    days.push({ date: wStart, price, source: "event", event: covering.map((e) => e.name).join(", ") });
  }

  const occ = await occupancy(acc._id, startDate, endDate, { totalUnits: acc.totalUnits ?? 1, excludeBookingId: opts.excludeBookingId });
  if (occ.isFull) reasons.add("Fully booked for part of the selected period");

  return {
    accommodationId: acc.id,
    startDate,
    endDate,
    durationDays,
    days,
    total: days.reduce((s, d) => s + d.price, 0),
    available: reasons.size === 0,
    isFull: occ.isFull,
    totalUnits: occ.totalUnits,
    unitsLeft: occ.unitsLeft,
    reasons: [...reasons],
  };
}

/** Ranges (next ~6 months) in which an accommodation can't be booked — used to grey out calendars. */
export async function blockedRanges(accommodationId: string, from = new Date(), days = 180) {
  const to = new Date(from.getTime() + days * DAY);
  const [acc, bookings, events] = await Promise.all([
    Accommodation.findById(accommodationId).select("totalUnits").lean(),
    Booking.find({ accommodation: accommodationId, startDate: { $lt: to }, endDate: { $gt: from }, ...blockingFilter() })
      .select("startDate endDate")
      .lean(),
    Event.find({ isActive: true, startDate: { $lt: to }, endDate: { $gt: from } }).lean(),
  ]);
  const ranges: { start: Date; end: Date; reason: "full" | "event" }[] = fullSegments(bookings as Span[], acc?.totalUnits ?? 1, from, to).map((s) => ({ ...s, reason: "full" }));
  for (const ev of events) {
    const open = ev.accommodations.find((a: { accommodation: Types.ObjectId; isAvailable: boolean }) => a.accommodation.toString() === accommodationId && a.isAvailable);
    if (!open) ranges.push({ start: ev.startDate, end: ev.endDate, reason: "event" });
  }
  return ranges.sort((a, b) => a.start.getTime() - b.start.getTime());
}
