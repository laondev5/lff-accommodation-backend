import { Router } from "express";
import { env } from "../config/env";
import { z } from "zod";
import { Accommodation, ACCOMMODATION_TYPES } from "../models/Accommodation";
import { Booking } from "../models/Booking";
import { Event } from "../models/Event";
import { Payment } from "../models/Payment";
import { getSettings } from "../models/Settings";
import { blockedRanges, quote, unitsLeftNow } from "../services/availability";
import { profileUrl } from "../services/email";
import { cancelBooking, createBooking, requestExtension, submitTransferProof, verifyPaystackPayment } from "../services/booking";
import { AppError, notFound } from "../utils/AppError";
import { createBookingBody, extendBody, objectId, pageSchema, quoteQuery, transferProofBody } from "../utils/schemas";

const PUBLIC_ACC_FIELDS = "name description type capacity totalUnits amenities images basePricePerDay";

export async function publicBankAccounts() {
  const s = await getSettings();
  return s.bankAccounts.filter((a: { active: boolean }) => a.active).map((a: any) => ({ bankName: a.bankName, accountNumber: a.accountNumber, accountName: a.accountName }));
}

/** What a visitor is allowed to see about a booking. */
export async function bookingView(b: any) {
  const payments = await Payment.find({ booking: b._id }).sort({ createdAt: -1 }).select("reference purpose method amount status extensionDays createdAt paidAt rejectionReason").lean();
  const pendingBank = payments.some((p: any) => p.method === "bank_transfer" && p.status === "pending");
  return {
    id: b.id,
    code: b.code,
    status: b.status,
    accommodation: b.accommodation,
    visitor: b.visitor,
    startDate: b.startDate,
    endDate: b.endDate,
    durationDays: b.durationDays,
    totalAmount: b.totalAmount,
    holdExpiresAt: b.status === "pending_payment" ? b.holdExpiresAt : undefined,
    checkedOutAt: b.checkedOutAt,
    profileExpiresAt: b.profileExpiresAt,
    payments,
    bankAccounts: pendingBank ? await publicBankAccounts() : undefined,
  };
}

export function buildPublicRouter(source: "web" | "api") {
  const r = Router();

  // ---- catalogue -------------------------------------------------------------------------
  r.get("/accommodations", async (req, res) => {
    const q = pageSchema
      .extend({
        startDate: z.coerce.date().optional(),
        durationDays: z.coerce.number().int().min(1).max(90).optional(),
        type: z.enum(ACCOMMODATION_TYPES).optional(),
        minCapacity: z.coerce.number().int().min(1).optional(),
        availableOnly: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    const filter: Record<string, unknown> = { deletedAt: null, isLocked: false };
    if (q.type) filter.type = q.type;
    if (q.minCapacity) filter.capacity = { $gte: q.minCapacity };

    const wantQuote = !!(q.startDate && q.durationDays);
    if (wantQuote && q.availableOnly === "true") {
      // availability needs per-item evaluation: load all matches, then paginate.
      const all = await Accommodation.find(filter).select(PUBLIC_ACC_FIELDS).sort({ name: 1 }).lean();
      const now = await unitsLeftNow(all as any);
      const withQuotes = (await Promise.all(all.map(async (a: any) => ({ ...a, ...now(a), quote: await quote(String(a._id), q.startDate!, q.durationDays!) })))).filter((a) => a.quote.available);
      const data = withQuotes.slice((q.page - 1) * q.limit, q.page * q.limit);
      return res.json({ success: true, data, meta: { page: q.page, limit: q.limit, total: withQuotes.length } });
    }

    const [items, total] = await Promise.all([
      Accommodation.find(filter).select(PUBLIC_ACC_FIELDS).sort({ name: 1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      Accommodation.countDocuments(filter),
    ]);
    const now = await unitsLeftNow(items as any);
    const data = await Promise.all(items.map(async (a: any) => ({ ...a, ...now(a), ...(wantQuote ? { quote: await quote(String(a._id), q.startDate!, q.durationDays!) } : {}) })));
    res.json({ success: true, data, meta: { page: q.page, limit: q.limit, total } });
  });

  r.get("/accommodations/:id", async (req, res) => {
    const id = objectId.parse(req.params.id);
    const acc = await Accommodation.findOne({ _id: id, deletedAt: null, isLocked: false }).select(PUBLIC_ACC_FIELDS).lean();
    if (!acc) throw notFound("Accommodation");
    const now = await unitsLeftNow([acc as any]);
    res.json({ success: true, data: { ...acc, ...now(acc as any), blockedRanges: await blockedRanges(id) } });
  });

  r.get("/accommodations/:id/quote", async (req, res) => {
    const { startDate, durationDays } = quoteQuery.parse(req.query);
    res.json({ success: true, data: await quote(objectId.parse(req.params.id), startDate, durationDays) });
  });

  r.get("/events", async (_req, res) => {
    const events = await Event.find({ isActive: true, endDate: { $gte: new Date() } }).sort({ startDate: 1 }).lean();
    res.json({
      success: true,
      data: events.map((e: any) => ({
        id: e._id,
        name: e.name,
        description: e.description,
        startDate: e.startDate,
        endDate: e.endDate,
        availableAccommodations: e.accommodations.filter((a: any) => a.isAvailable).length,
      })),
    });
  });

  r.get("/events/:id", async (req, res) => {
    const ev: any = await Event.findOne({ _id: objectId.parse(req.params.id), isActive: true }).populate("accommodations.accommodation", PUBLIC_ACC_FIELDS + " isLocked deletedAt").lean();
    if (!ev) throw notFound("Event");
    const accommodations = ev.accommodations
      .filter((a: any) => a.isAvailable && a.accommodation && !a.accommodation.isLocked && !a.accommodation.deletedAt)
      .map((a: any) => ({ ...a.accommodation, isLocked: undefined, deletedAt: undefined, eventPricePerDay: a.pricePerDay }));
    res.json({ success: true, data: { id: ev._id, name: ev.name, description: ev.description, startDate: ev.startDate, endDate: ev.endDate, accommodations } });
  });

  r.get("/settings", async (_req, res) => {
    const s = await getSettings();
    res.json({ success: true, data: { churchName: s.churchName, contactEmail: s.contactEmail, contactPhone: s.contactPhone, paystackPublicKey: env.PAYSTACK_PUBLIC_KEY || null, bankAccounts: await publicBankAccounts() } });
  });

  // ---- booking -----------------------------------------------------------------------------
  r.post("/bookings", async (req, res) => {
    const body = createBookingBody.parse(req.body);
    const result = await createBooking(body, { source, apiKeyId: req.apiKeyId });
    const { booking, payment } = result as any;
    res.status(201).json({
      success: true,
      data: {
        booking: await bookingView(booking),
        profileToken: booking.profileToken,
        profileUrl: profileUrl(booking.profileToken),
        payment: { reference: payment.reference, method: payment.method, amount: payment.amount, status: payment.status },
        authorizationUrl: result.authorizationUrl,
        bankAccounts: body.paymentMethod === "bank_transfer" ? await publicBankAccounts() : undefined,
      },
    });
  });

  r.post("/payments/verify", async (req, res) => {
    const { reference } = z.object({ reference: z.string().min(5).max(100) }).parse(req.body);
    const payment: any = await verifyPaystackPayment(reference);
    const booking = await Booking.findById(payment.booking?._id ?? payment.booking).select("code status profileToken");
    res.json({ success: true, data: { status: payment.status, booking: booking && { code: booking.code, status: booking.status, profileToken: booking.profileToken } } });
  });

  r.post("/payments/:reference/transfer-proof", async (req, res) => {
    const payment: any = await submitTransferProof(req.params.reference as string, transferProofBody.parse(req.body));
    res.json({ success: true, data: { reference: payment.reference, status: payment.status } });
  });

  // ---- visitor profile (link-based, expires 12h after the stay ends) -------------------------------
  async function bookingByToken(token: string) {
    const b: any = await Booking.findOne({ profileToken: token }).populate("accommodation", "name type images");
    if (!b) throw notFound("Booking");
    if (b.profileExpiresAt < new Date()) throw new AppError(410, "This booking link has expired", "LINK_EXPIRED");
    return b;
  }

  r.get("/bookings/profile/:token", async (req, res) => {
    res.json({ success: true, data: await bookingView(await bookingByToken(req.params.token as string)) });
  });

  r.post("/bookings/profile/:token/extend", async (req, res) => {
    const body = extendBody.parse(req.body);
    const b = await bookingByToken(req.params.token as string);
    const out = await requestExtension(b._id, body.extraDays, body.paymentMethod, body.callbackUrl);
    res.status(201).json({
      success: true,
      data: {
        payment: { reference: out.payment.reference, method: out.payment.method, amount: out.payment.amount, status: out.payment.status },
        authorizationUrl: out.authorizationUrl,
        quote: out.quote,
        bankAccounts: body.paymentMethod === "bank_transfer" ? await publicBankAccounts() : undefined,
      },
    });
  });

  r.post("/bookings/profile/:token/cancel", async (req, res) => {
    const b = await bookingByToken(req.params.token as string);
    const out = await cancelBooking(b.id, "Cancelled by visitor", ["pending_payment"]);
    res.json({ success: true, data: { status: out.status } });
  });

  return r;
}
