import { Router } from "express";
import { z } from "zod";
import { ApiKey } from "../models/ApiKey";
import { Booking } from "../models/Booking";
import { Payment } from "../models/Payment";
import { cancelBooking, requestExtension } from "../services/booking";
import { profileUrl } from "../services/email";
import { notFound } from "../utils/AppError";
import { extendBody, pageSchema } from "../utils/schemas";
import { bookingView, buildPublicRouter, publicBankAccounts } from "./public";

/**
 * Third-party API (`x-api-key`). Includes everything a visitor can do (shared router),
 * plus lookups by booking code, cancellations, payment status and webhook registration.
 */
export function buildV1Router() {
  const r = Router();
  r.use(buildPublicRouter("api"));

  const byCode = async (code: string) => {
    const b = await Booking.findOne({ code: code.toUpperCase() }).populate("accommodation", "name type images");
    if (!b) throw notFound("Booking");
    return b;
  };

  r.get("/bookings", async (req, res) => {
    const q = pageSchema.extend({ email: z.string().email().optional(), phone: z.string().optional(), status: z.string().optional() }).parse(req.query);
    const filter: Record<string, unknown> = {};
    if (q.email) filter["visitor.email"] = q.email.toLowerCase();
    if (q.phone) filter["visitor.phone"] = q.phone;
    if (q.status) filter.status = q.status;
    const [items, total] = await Promise.all([
      Booking.find(filter).populate("accommodation", "name type images").sort({ createdAt: -1 }).skip((q.page - 1) * q.limit).limit(q.limit),
      Booking.countDocuments(filter),
    ]);
    const data = await Promise.all(items.map(async (b: any) => ({ ...(await bookingView(b)), profileUrl: profileUrl(b.profileToken) })));
    res.json({ success: true, data, meta: { page: q.page, limit: q.limit, total } });
  });

  r.get("/bookings/:code", async (req, res) => {
    const b: any = await byCode(req.params.code as string);
    res.json({ success: true, data: { ...(await bookingView(b)), profileUrl: profileUrl(b.profileToken) } });
  });

  r.post("/bookings/:code/extend", async (req, res) => {
    const body = extendBody.parse(req.body);
    const b = await byCode(req.params.code as string);
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

  r.post("/bookings/:code/cancel", async (req, res) => {
    const b = await byCode(req.params.code as string);
    const out = await cancelBooking(b.id, "Cancelled via API", ["pending_payment", "awaiting_confirmation"]);
    res.json({ success: true, data: { status: out.status } });
  });

  r.get("/payments/:reference", async (req, res) => {
    const p = await Payment.findOne({ reference: req.params.reference }).select("reference purpose method amount status paidAt booking extensionDays").populate("booking", "code status");
    if (!p) throw notFound("Payment");
    res.json({ success: true, data: p });
  });

  // Register where we should POST signed booking events (booking.confirmed / .expiring / .expired / .extended / .checked_out / .cancelled)
  r.put("/webhook", async (req, res) => {
    const body = z.object({ url: z.string().url().or(z.literal("")), secret: z.string().min(8).max(100) }).parse(req.body);
    await ApiKey.updateOne({ _id: req.apiKeyId }, { webhookUrl: body.url, webhookSecret: body.secret });
    res.json({ success: true, data: { url: body.url } });
  });

  return r;
}
