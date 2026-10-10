import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireRole } from "../middleware/auth";
import teamRoutes from "./team";
import { Accommodation, ACCOMMODATION_TYPES } from "../models/Accommodation";
import { ApiKey } from "../models/ApiKey";
import { Booking, BOOKING_STATUSES } from "../models/Booking";
import { Event } from "../models/Event";
import { Notification } from "../models/Notification";
import { Payment } from "../models/Payment";
import { getSettings, Settings } from "../models/Settings";
import { occupancy } from "../services/availability";
import { adminExtend, cancelBooking, checkoutBooking, createBooking, finalizePayment, rejectPayment } from "../services/booking";
import { AppError, conflict, notFound } from "../utils/AppError";
import { DAY, escapeRegex, randomToken, sha256 } from "../utils/helpers";
import { createBookingBody, dateStr, objectId, pageSchema, visitorSchema } from "../utils/schemas";

const r = Router();
r.use(requireAdmin);

/** zod defaults would otherwise overwrite untouched fields on PATCH: keep only keys present in the request body. */
const sent = <T extends Record<string, unknown>>(parsed: T, raw: unknown): Partial<T> =>
  Object.fromEntries(Object.entries(parsed).filter(([k]) => raw && typeof raw === "object" && k in (raw as object))) as Partial<T>;

const ok = (res: any, data: unknown, meta?: unknown, status = 200) => res.status(status).json({ success: true, data, meta });
const LIVE_BOOKING = { $or: [{ status: { $in: ["active", "awaiting_confirmation"] } }, { status: "pending_payment", holdExpiresAt: { $gt: new Date() } }] };

// ---- dashboard ---------------------------------------------------------------------------------
r.get("/dashboard", async (_req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const stay = { status: "active", checkedOutAt: { $exists: false } };
  const [accDocs, stayCounts, totalAcc, lockedAcc, occupiedIds, expiringSoon, overdue, awaiting, upcoming, revenue, recent, unread] = await Promise.all([
    Accommodation.find({ deletedAt: null, isLocked: false }).select("totalUnits").lean(),
    Booking.aggregate([{ $match: { status: "active", checkedOutAt: { $exists: false }, startDate: { $lte: now } } }, { $group: { _id: "$accommodation", n: { $sum: 1 } } }]),
    Accommodation.countDocuments({ deletedAt: null }),
    Accommodation.countDocuments({ deletedAt: null, isLocked: true }),
    Booking.distinct("accommodation", { ...stay, startDate: { $lte: now } }),
    Booking.countDocuments({ ...stay, endDate: { $gt: now, $lte: new Date(now.getTime() + DAY) } }),
    Booking.countDocuments({ ...stay, endDate: { $lte: now } }),
    Payment.countDocuments({ status: "submitted" }),
    Booking.countDocuments({ ...stay, startDate: { $gt: now } }),
    Payment.aggregate([{ $match: { status: "success", needsRefund: false, paidAt: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
    Booking.find().sort({ createdAt: -1 }).limit(6).populate("accommodation", "name"),
    Notification.countDocuments({ read: false }),
  ]);
  const used = new Map<string, number>(stayCounts.map((s: any) => [String(s._id), s.n]));
  const fullCount = accDocs.filter((d: any) => (used.get(String(d._id)) ?? 0) >= (d.totalUnits ?? 1)).length;
  const unitsTotal = accDocs.reduce((s: number, d: any) => s + (d.totalUnits ?? 1), 0);
  const unitsUsed = accDocs.reduce((s: number, d: any) => s + Math.min(used.get(String(d._id)) ?? 0, d.totalUnits ?? 1), 0);
  ok(res, {
    accommodations: {
      total: totalAcc,
      locked: lockedAcc,
      occupied: occupiedIds.length,
      full: fullCount,
      available: Math.max(totalAcc - lockedAcc - fullCount, 0), // still has at least one free unit
      totalUnits: unitsTotal,
      occupiedUnits: unitsUsed,
    },
    expiringSoon,
    overdue,
    awaitingConfirmation: awaiting,
    upcomingStays: upcoming,
    revenueThisMonth: revenue[0]?.total ?? 0,
    unreadNotifications: unread,
    recentBookings: recent,
  });
});

// ---- accommodations ----------------------------------------------------------------------------
const accommodationBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(3000).default(""),
  type: z.enum(ACCOMMODATION_TYPES).default("room"),
  capacity: z.coerce.number().int().min(1).max(500),
  totalUnits: z.coerce.number().int().min(1).max(1000).default(1),
  amenities: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  images: z.array(z.string().url()).max(12).default([]),
  basePricePerDay: z.coerce.number().min(0).max(100_000_000),
  isLocked: z.boolean().optional(),
});

r.get("/accommodations", async (req, res) => {
  const { q, state } = z.object({ q: z.string().optional(), state: z.enum(["available", "occupied", "full", "locked"]).optional() }).parse(req.query);
  const filter: Record<string, unknown> = { deletedAt: null };
  if (q) filter.name = { $regex: escapeRegex(q), $options: "i" };
  const items = await Accommodation.find(filter).sort({ name: 1 }).lean();
  const now = new Date();
  const stays = await Booking.find({ accommodation: { $in: items.map((i: any) => i._id) }, status: "active", checkedOutAt: { $exists: false }, startDate: { $lte: now } })
    .select("code visitor startDate endDate accommodation")
    .lean();
  const upcoming = await Booking.find({ accommodation: { $in: items.map((i: any) => i._id) }, ...LIVE_BOOKING, startDate: { $gt: now } }).select("accommodation").lean();
  const withState = items.map((a: any) => {
    const current = stays.filter((s: any) => s.accommodation.equals(a._id));
    const totalUnits = a.totalUnits ?? 1;
    return {
      ...a,
      totalUnits,
      occupiedUnits: current.length,
      unitsLeft: Math.max(totalUnits - current.length, 0),
      state: a.isLocked ? "locked" : current.length >= totalUnits ? "full" : current.length ? "occupied" : "available",
      currentBookings: current,
      upcomingCount: upcoming.filter((u: any) => u.accommodation.equals(a._id)).length,
    };
  });
  ok(res, state ? withState.filter((a) => a.state === state) : withState);
});

r.post("/accommodations", async (req, res) => {
  ok(res, await Accommodation.create(accommodationBody.parse(req.body)), undefined, 201);
});

r.get("/accommodations/:id", async (req, res) => {
  const acc = await Accommodation.findOne({ _id: objectId.parse(req.params.id), deletedAt: null });
  if (!acc) throw notFound("Accommodation");
  ok(res, acc);
});

r.patch("/accommodations/:id", async (req, res) => {
  const acc = await Accommodation.findOneAndUpdate({ _id: objectId.parse(req.params.id), deletedAt: null }, sent(accommodationBody.partial().parse(req.body), req.body), { returnDocument: "after" });
  if (!acc) throw notFound("Accommodation");
  ok(res, acc);
});

r.patch("/accommodations/:id/lock", async (req, res) => {
  const { locked } = z.object({ locked: z.boolean() }).parse(req.body);
  const acc = await Accommodation.findOneAndUpdate({ _id: objectId.parse(req.params.id), deletedAt: null }, { isLocked: locked }, { returnDocument: "after" });
  if (!acc) throw notFound("Accommodation");
  ok(res, acc);
});

r.post("/accommodations/:id/signout", async (req, res) => {
  const { bookingId } = z.object({ bookingId: objectId.optional() }).parse(req.body ?? {});
  const stays = await Booking.find({ accommodation: objectId.parse(req.params.id), status: "active", checkedOutAt: { $exists: false }, startDate: { $lte: new Date() }, ...(bookingId ? { _id: bookingId } : {}) });
  if (!stays.length) throw conflict("This accommodation has no occupant to sign out");
  if (stays.length > 1) throw conflict("Several occupants are staying here. Choose which one to sign out.", "MULTIPLE_OCCUPANTS");
  ok(res, await checkoutBooking(stays[0].id));
});

r.delete("/accommodations/:id", async (req, res) => {
  const id = objectId.parse(req.params.id);
  if (await Booking.exists({ accommodation: id, ...LIVE_BOOKING })) throw conflict("This accommodation has active or upcoming bookings. Sign out / cancel them first, or lock it instead.");
  const acc = await Accommodation.findOneAndUpdate({ _id: id, deletedAt: null }, { deletedAt: new Date() });
  if (!acc) throw notFound("Accommodation");
  ok(res, { deleted: true });
});

// ---- events ------------------------------------------------------------------------------------
const eventEntry = z.object({ accommodation: objectId, isAvailable: z.boolean().default(true), pricePerDay: z.coerce.number().min(0).max(100_000_000) });
const eventBody = z.object({
  name: z.string().trim().min(2).max(150),
  description: z.string().trim().max(3000).default(""),
  startDate: dateStr,
  endDate: dateStr,
  isActive: z.boolean().default(true),
  accommodations: z.array(eventEntry).default([]),
});
const checkDates = (s: Date, e: Date) => {
  if (e <= s) throw new AppError(400, "endDate must be after startDate", "VALIDATION_ERROR");
};

/** Bookings that already sit inside an event period on accommodations that the event leaves closed. */
async function eventWarnings(ev: any) {
  const open = new Set(ev.accommodations.filter((a: any) => a.isAvailable).map((a: any) => String(a.accommodation)));
  const clashes = await Booking.find({ startDate: { $lt: ev.endDate }, endDate: { $gt: ev.startDate }, ...LIVE_BOOKING }).populate("accommodation", "name").lean();
  return clashes.filter((b: any) => !open.has(String(b.accommodation._id))).map((b: any) => ({ code: b.code, accommodation: b.accommodation.name, visitor: b.visitor.name }));
}

r.get("/events", async (_req, res) => {
  const events = await Event.find().sort({ startDate: -1 }).lean();
  ok(res, events.map((e: any) => ({ ...e, openCount: e.accommodations.filter((a: any) => a.isAvailable).length })));
});

r.post("/events", async (req, res) => {
  const body = eventBody.parse(req.body);
  checkDates(body.startDate, body.endDate);
  const ev = await Event.create(body);
  ok(res, { event: ev, warnings: await eventWarnings(ev) }, undefined, 201);
});

r.get("/events/:id", async (req, res) => {
  const ev = await Event.findById(objectId.parse(req.params.id)).populate("accommodations.accommodation", "name basePricePerDay type isLocked");
  if (!ev) throw notFound("Event");
  ok(res, ev);
});

r.patch("/events/:id", async (req, res) => {
  const body = sent(eventBody.partial().parse(req.body), req.body);
  const ev = await Event.findById(objectId.parse(req.params.id));
  if (!ev) throw notFound("Event");
  ev.set(body);
  checkDates(ev.startDate, ev.endDate);
  await ev.save();
  ok(res, { event: ev, warnings: await eventWarnings(ev) });
});

r.put("/events/:id/accommodations", async (req, res) => {
  const { accommodations } = z.object({ accommodations: z.array(eventEntry) }).parse(req.body);
  const ev = await Event.findById(objectId.parse(req.params.id));
  if (!ev) throw notFound("Event");
  ev.accommodations = accommodations as any;
  await ev.save();
  ok(res, { event: ev, warnings: await eventWarnings(ev) });
});

r.delete("/events/:id", async (req, res) => {
  const ev = await Event.findByIdAndDelete(objectId.parse(req.params.id));
  if (!ev) throw notFound("Event");
  ok(res, { deleted: true });
});

// ---- bookings / occupants ------------------------------------------------------------------------
r.get("/bookings", async (req, res) => {
  const q = pageSchema
    .extend({
      status: z.enum(BOOKING_STATUSES).optional(),
      view: z.enum(["occupants", "expiring", "overdue", "upcoming"]).optional(),
      accommodationId: objectId.optional(),
      q: z.string().optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
    })
    .parse(req.query);
  const now = new Date();
  const stay = { status: "active", checkedOutAt: { $exists: false } };
  const filter: Record<string, any> = {};
  if (q.status) filter.status = q.status;
  if (q.accommodationId) filter.accommodation = q.accommodationId;
  if (q.view === "occupants") Object.assign(filter, stay, { startDate: { $lte: now } });
  if (q.view === "expiring") Object.assign(filter, stay, { endDate: { $gt: now, $lte: new Date(now.getTime() + DAY) } });
  if (q.view === "overdue") Object.assign(filter, stay, { endDate: { $lte: now } });
  if (q.view === "upcoming") Object.assign(filter, stay, { startDate: { $gt: now } });
  if (q.from) filter.endDate = { ...filter.endDate, $gt: q.from };
  if (q.to) filter.startDate = { ...filter.startDate, $lt: q.to };
  if (q.q) {
    const rx = { $regex: escapeRegex(q.q), $options: "i" };
    filter.$or = [{ code: rx }, { "visitor.name": rx }, { "visitor.email": rx }, { "visitor.phone": rx }, { "visitor.whatsapp": rx }];
  }
  const [items, total] = await Promise.all([
    Booking.find(filter).sort(q.view ? { endDate: 1 } : { createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate("accommodation", "name type"),
    Booking.countDocuments(filter),
  ]);
  ok(res, items, { page: q.page, limit: q.limit, total });
});

r.post("/bookings", async (req, res) => {
  // Walk-in / offline booking recorded by an admin: considered paid immediately.
  const body = createBookingBody.omit({ paymentMethod: true, callbackUrl: true }).parse(req.body);
  const out = await createBooking({ ...body, paymentMethod: "cash" }, { source: "admin" });
  ok(res, out.booking, undefined, 201);
});

r.get("/bookings/:id", async (req, res) => {
  const b = await Booking.findById(objectId.parse(req.params.id)).populate("accommodation", "name type");
  if (!b) throw notFound("Booking");
  ok(res, { booking: b, payments: await Payment.find({ booking: b._id }).sort({ createdAt: -1 }) });
});

r.post("/bookings/:id/checkout", async (req, res) => ok(res, await checkoutBooking(objectId.parse(req.params.id))));

r.post("/bookings/:id/cancel", async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(2).max(300).default("Cancelled by admin") }).parse(req.body ?? {});
  ok(res, await cancelBooking(objectId.parse(req.params.id), reason));
});

r.post("/bookings/:id/extend", async (req, res) => {
  const { days, amount } = z.object({ days: z.coerce.number().int().min(1).max(60), amount: z.coerce.number().min(0).default(0) }).parse(req.body);
  const b = await Booking.findById(objectId.parse(req.params.id));
  if (!b || b.status !== "active") throw conflict("Only active stays can be extended");
  const newEnd = new Date(b.endDate.getTime() + days * DAY);
  if ((await occupancy(b.accommodation, b.endDate, newEnd, { excludeBookingId: b._id })).isFull) throw conflict("The accommodation is fully booked for part of the extension period");
  ok(res, await adminExtend(b.id, days, amount));
});

// ---- payments ----------------------------------------------------------------------------------
r.get("/payments", async (req, res) => {
  const q = pageSchema.extend({ status: z.enum(["pending", "submitted", "success", "failed", "rejected"]).optional(), needsRefund: z.enum(["true"]).optional() }).parse(req.query);
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.needsRefund) filter.needsRefund = true;
  const [items, total] = await Promise.all([
    Payment.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate({ path: "booking", select: "code visitor accommodation", populate: { path: "accommodation", select: "name" } }),
    Payment.countDocuments(filter),
  ]);
  ok(res, items, { page: q.page, limit: q.limit, total });
});

r.post("/payments/:id/confirm", async (req, res) => {
  const p = await finalizePayment(objectId.parse(req.params.id), undefined, { silentAdmin: true });
  if (!p) throw conflict("Payment is not awaiting confirmation");
  ok(res, p);
});

r.post("/payments/:id/reject", async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(2).max(300) }).parse(req.body);
  ok(res, await rejectPayment(objectId.parse(req.params.id), reason));
});

// ---- notifications -----------------------------------------------------------------------------
r.get("/notifications", async (req, res) => {
  const q = pageSchema.extend({ unread: z.enum(["true"]).optional() }).parse(req.query);
  const filter = q.unread ? { read: false } : {};
  const [items, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ read: false }),
  ]);
  ok(res, items, { page: q.page, limit: q.limit, total, unread });
});
r.post("/notifications/read-all", async (_req, res) => {
  await Notification.updateMany({ read: false }, { read: true });
  ok(res, { updated: true });
});
r.patch("/notifications/:id/read", async (req, res) => {
  await Notification.updateOne({ _id: objectId.parse(req.params.id) }, { read: true });
  ok(res, { updated: true });
});

// ---- settings (bank accounts) -------------------------------------------------------------------
r.get("/settings", async (_req, res) => ok(res, await getSettings()));
r.put("/settings", async (req, res) => {
  const body = z
    .object({
      churchName: z.string().trim().min(2).max(120),
      contactEmail: z.string().email().optional().or(z.literal("")),
      contactPhone: z.string().trim().max(30).optional(),
      bankAccounts: z
        .array(
          z.object({
            bankName: z.string().trim().min(2).max(80),
            accountNumber: z.string().trim().regex(/^\d{6,20}$/, "Account number must be digits only"),
            accountName: z.string().trim().min(2).max(120),
            active: z.boolean().default(true),
          }),
        )
        .max(10),
    })
    .parse(req.body);
  ok(res, await Settings.findOneAndUpdate({ key: "main" }, body, { returnDocument: "after", upsert: true }));
});

// ---- API keys for third-party apps ----------------------------------------------------------------
// Admin-only areas: API keys and team (manager) management. Managers get everything else.
r.use("/team", requireRole("admin"), teamRoutes);
r.use("/api-keys", requireRole("admin"));
r.get("/api-keys", async (_req, res) => ok(res, await ApiKey.find().select("-keyHash -webhookSecret").sort({ createdAt: -1 })));
r.post("/api-keys", async (req, res) => {
  const { name, webhookUrl } = z.object({ name: z.string().trim().min(2).max(80), webhookUrl: z.string().url().optional() }).parse(req.body);
  const raw = `lff_${randomToken(24)}`;
  const webhookSecret = randomToken(16);
  const doc: any = await ApiKey.create({ name, prefix: raw.slice(0, 10), keyHash: sha256(raw), webhookUrl, webhookSecret });
  // The raw key and webhook secret are only ever shown once.
  ok(res, { id: doc.id, name, key: raw, webhookSecret }, undefined, 201);
});
r.patch("/api-keys/:id", async (req, res) => {
  const body = z.object({ active: z.boolean().optional(), webhookUrl: z.string().url().or(z.literal("")).optional() }).parse(req.body);
  const doc = await ApiKey.findByIdAndUpdate(objectId.parse(req.params.id), body, { returnDocument: "after" }).select("-keyHash -webhookSecret");
  if (!doc) throw notFound("API key");
  ok(res, doc);
});
r.delete("/api-keys/:id", async (req, res) => {
  await ApiKey.findByIdAndDelete(objectId.parse(req.params.id));
  ok(res, { deleted: true });
});

export default r;
