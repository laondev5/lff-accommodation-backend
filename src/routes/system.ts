import crypto from "crypto";
import { Router } from "express";
import { z } from "zod";
import { adminIdFromToken } from "../middleware/auth";
import { Admin } from "../models/Admin";
import { Booking } from "../models/Booking";
import { env } from "../config/env";
import { verifyPaystackPayment } from "../services/booking";
import { isValidWebhookSignature } from "../services/paystack";
import { pusher } from "../services/pusher";
import { processScheduledJobs } from "../services/reminders";
import { AppError } from "../utils/AppError";

const r = Router();

r.get("/health", (_req, res) => res.json({ success: true, data: { status: "ok", time: new Date() } }));

/**
 * Called by an external scheduler (e.g. cron-job.org) every 10-15 minutes:
 *   GET /api/cron/process   with header  Authorization: Bearer <CRON_SECRET>
 */
r.all("/cron/process", async (req, res) => {
  const supplied = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1] ?? "";
  const expected = env.CRON_SECRET ?? "";
  const a = crypto.createHash("sha256").update(supplied).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!expected || !crypto.timingSafeEqual(a, b)) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  res.json({ success: true, data: await processScheduledJobs() });
});

/** Paystack server-to-server notification. We re-verify with Paystack instead of trusting the payload. */
r.post("/webhooks/paystack", async (req, res) => {
  if (!isValidWebhookSignature(req.rawBody, req.headers["x-paystack-signature"] as string | undefined)) throw new AppError(401, "Invalid signature");
  const event = req.body as { event?: string; data?: { reference?: string } };
  if (event.event === "charge.success" && event.data?.reference) {
    try {
      await verifyPaystackPayment(event.data.reference);
    } catch (e) {
      console.error("[paystack webhook]", e);
    }
  }
  res.sendStatus(200);
});

/**
 * Pusher private-channel authorisation.
 *  - private-admin             -> requires an admin JWT (Authorization: Bearer ...)
 *  - private-booking-<CODE>    -> requires the booking's profile token in body.token
 */
r.post("/pusher/auth", async (req, res) => {
  if (!pusher) throw new AppError(503, "Realtime is not configured");
  const { socket_id, channel_name, token } = z.object({ socket_id: z.string(), channel_name: z.string(), token: z.string().optional() }).parse(req.body);

  if (channel_name === "private-admin") {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    const id = bearer ? adminIdFromToken(bearer) : null;
    if (!id || !(await Admin.exists({ _id: id, active: { $ne: false } }))) throw new AppError(403, "Forbidden");
  } else if (channel_name.startsWith("private-booking-")) {
    const code = channel_name.slice("private-booking-".length);
    const ok = token && (await Booking.exists({ code, profileToken: token, profileExpiresAt: { $gt: new Date() } }));
    if (!ok) throw new AppError(403, "Forbidden");
  } else {
    throw new AppError(403, "Forbidden");
  }
  res.json(pusher.authorizeChannel(socket_id, channel_name));
});

export default r;
