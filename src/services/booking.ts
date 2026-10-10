import { Types } from "mongoose";
import { env, primaryClientUrl } from "../config/env";
import { Booking } from "../models/Booking";
import { Payment } from "../models/Payment";
import { AppError, badRequest, conflict, notFound } from "../utils/AppError";
import { bookingCode, DAY, fmtDate, HOUR, money, paymentReference, randomToken } from "../utils/helpers";
import { findConflicts, maxConcurrent, occupancy, quote } from "./availability";
import { bookingConfirmedEmail, endedEmail, paymentReceivedEmail, sendEmail } from "./email";
import { emitWebhook, notifyAdmins, notifyVisitor } from "./notify";
import { initializeTransaction, verifyTransaction } from "./paystack";

export type PayMethod = "paystack" | "bank_transfer" | "cash";

export interface VisitorInput {
  name: string;
  email: string;
  phone: string;
  whatsapp: string;
}

// ---- helpers ---------------------------------------------------------------------------------

const accName = (b: { accommodation: unknown }) => (b.accommodation as { name?: string } | null)?.name ?? "your accommodation";

export const webhookPayload = (b: any) => ({
  code: b.code,
  status: b.status,
  accommodationId: String(b.accommodation?._id ?? b.accommodation),
  startDate: b.startDate,
  endDate: b.endDate,
  durationDays: b.durationDays,
  totalAmount: b.totalAmount,
  visitor: b.visitor,
});

async function initPaystack(payment: any, booking: any, callbackUrl?: string) {
  const init = await initializeTransaction({
    email: booking.visitor.email,
    amountNaira: payment.amount,
    reference: payment.reference,
    callbackUrl: callbackUrl ?? `${primaryClientUrl}/payment/callback`,
    metadata: { bookingCode: booking.code, purpose: payment.purpose },
  });
  payment.gatewayResponse = { access_code: init.access_code };
  await payment.save();
  return init.authorization_url;
}

// ---- create ----------------------------------------------------------------------------------

export interface CreateBookingInput {
  accommodationId: string;
  startDate: Date;
  durationDays: number;
  visitor: VisitorInput;
  paymentMethod: PayMethod;
  callbackUrl?: string;
}

export async function createBooking(input: CreateBookingInput, ctx: { source: "web" | "api" | "admin"; apiKeyId?: string }) {
  if (input.startDate.getTime() < Date.now() - 12 * HOUR) throw badRequest("Start date cannot be in the past", "INVALID_DATE");

  const q = await quote(input.accommodationId, input.startDate, input.durationDays);
  if (!q.available) throw conflict(q.reasons.join(". "), "NOT_AVAILABLE");

  const now = new Date();
  const holdMinutes = input.paymentMethod === "paystack" ? env.PAYSTACK_HOLD_MINUTES : env.BANK_TRANSFER_HOLD_MINUTES;

  let booking: any;
  for (let attempt = 0; ; attempt++) {
    try {
      booking = await Booking.create({
        code: bookingCode(),
        accommodation: input.accommodationId,
        visitor: input.visitor,
        startDate: q.startDate,
        endDate: q.endDate,
        durationDays: q.durationDays,
        totalAmount: q.total,
        status: "pending_payment",
        holdExpiresAt: new Date(now.getTime() + holdMinutes * 60_000),
        source: ctx.source,
        apiKey: ctx.apiKeyId,
        profileToken: randomToken(),
        profileExpiresAt: new Date(q.endDate.getTime() + env.PROFILE_EXPIRY_HOURS * HOUR),
      });
      break;
    } catch (e: any) {
      if (e?.code === 11000 && attempt < 4) continue; // code/token collision, retry
      throw e;
    }
  }

  // Race guard: if someone else grabbed an overlapping slot first, back off.
  const earlier = (await findConflicts(booking.accommodation, q.startDate, q.endDate, booking._id).select("startDate endDate").lean()).filter((c: any) => c._id.toString() < booking._id.toString());
  if (maxConcurrent([...earlier, booking], q.startDate, q.endDate) > q.totalUnits) {
    await booking.deleteOne();
    throw conflict("Sorry, this accommodation was just booked by someone else", "NOT_AVAILABLE");
  }

  const payment: any = await Payment.create({
    booking: booking._id,
    reference: paymentReference(),
    purpose: "booking",
    method: input.paymentMethod,
    amount: q.total,
    status: input.paymentMethod === "cash" ? "success" : "pending",
    paidAt: input.paymentMethod === "cash" ? now : undefined,
  });

  let authorizationUrl: string | undefined;
  if (input.paymentMethod === "paystack") {
    try {
      authorizationUrl = await initPaystack(payment, booking, input.callbackUrl);
    } catch (e) {
      await Promise.all([booking.deleteOne(), payment.deleteOne()]);
      throw e;
    }
  } else if (input.paymentMethod === "cash") {
    await activateBooking(booking._id, { silentAdmin: ctx.source === "admin" });
  }

  return { booking: await Booking.findById(booking._id).populate("accommodation", "name type images"), payment, authorizationUrl, quote: q };
}

// ---- activation / payments -------------------------------------------------------------------

export async function activateBooking(bookingId: Types.ObjectId | string, opts: { silentAdmin?: boolean } = {}) {
  const booking = await Booking.findOneAndUpdate(
    { _id: bookingId, status: { $in: ["pending_payment", "awaiting_confirmation", "expired"] } },
    { $set: { status: "active" }, $unset: { holdExpiresAt: 1 } },
    { returnDocument: "after" },
  ).populate("accommodation", "name");
  if (!booking) return null;
  await Promise.allSettled([
    sendEmail(booking.visitor.email, `Booking confirmed - ${booking.code}`, bookingConfirmedEmail(booking, accName(booking))),
    opts.silentAdmin
      ? Promise.resolve()
      : notifyAdmins({
          type: "booking_confirmed",
          title: "New booking confirmed",
          message: `${booking.visitor.name} booked ${accName(booking)} (${booking.code}) for ${money(booking.totalAmount)}.`,
          data: { bookingId: booking.id, code: booking.code },
        }),
    notifyVisitor(booking.code, "booking:updated", { status: "active" }),
    emitWebhook("booking.confirmed", webhookPayload(booking)),
    notifyIfFull(booking),
  ]);
  return booking;
}

/** Tell admins when a confirmed booking uses up the last free unit of an accommodation. */
async function notifyIfFull(booking: any) {
  const occ = await occupancy(booking.accommodation._id, booking.startDate, booking.endDate);
  if (!occ.isFull) return;
  await notifyAdmins({
    type: "accommodation_full",
    title: "Accommodation is full",
    message: `${accName(booking)} is now fully booked (${occ.totalUnits}/${occ.totalUnits} units) for ${fmtDate(booking.startDate)} - ${fmtDate(booking.endDate)}.`,
    data: { accommodationId: String(booking.accommodation._id) },
    email: false,
  });
  await emitWebhook("accommodation.full", { accommodationId: String(booking.accommodation._id), name: accName(booking), startDate: booking.startDate, endDate: booking.endDate });
}

async function flagRefund(payment: any, booking: any, reason: string) {
  await Payment.updateOne({ _id: payment._id }, { needsRefund: true });
  await notifyAdmins({
    type: "refund_required",
    title: "Refund required",
    message: `Payment ${payment.reference} (${money(payment.amount)}) for booking ${booking.code} was received but could not be applied: ${reason}.`,
    data: { paymentId: payment.id, bookingId: booking.id },
  });
}

/** Idempotent: only the first caller to flip the payment to "success" applies its effects. */
export async function finalizePayment(paymentId: Types.ObjectId | string, gatewayResponse?: unknown, opts: { silentAdmin?: boolean } = {}) {
  const payment: any = await Payment.findOneAndUpdate(
    { _id: paymentId, status: { $in: ["pending", "submitted"] } },
    { $set: { status: "success", paidAt: new Date(), ...(gatewayResponse ? { gatewayResponse } : {}) } },
    { returnDocument: "after" },
  );
  if (!payment) return null;
  const booking: any = await Booking.findById(payment.booking).populate("accommodation", "name");
  if (!booking) return payment;

  if (payment.purpose === "booking") {
    if (["pending_payment", "awaiting_confirmation"].includes(booking.status)) {
      await activateBooking(booking._id, opts);
    } else if (booking.status === "expired") {
      const occ = await occupancy(booking.accommodation._id, booking.startDate, booking.endDate, { excludeBookingId: booking._id });
      if (occ.isFull) await flagRefund(payment, booking, "the hold expired and the accommodation was taken");
      else await activateBooking(booking._id, opts);
    } else if (booking.status !== "active") {
      await flagRefund(payment, booking, `the booking is ${booking.status}`);
    }
    return payment;
  }

  // extension
  const days: number = payment.extensionDays;
  const newEnd = new Date(booking.endDate.getTime() + days * DAY);
  const blocked = booking.status !== "active" || (await occupancy(booking.accommodation._id, booking.endDate, newEnd, { excludeBookingId: booking._id })).isFull;
  if (blocked) {
    await flagRefund(payment, booking, "the extension period is no longer available");
    return payment;
  }
  await applyExtension(booking._id, days, payment.amount);
  return payment;
}

async function applyExtension(bookingId: Types.ObjectId | string, days: number, amount: number) {
  const updated: any = await Booking.findOneAndUpdate(
    { _id: bookingId, status: "active" },
    [
      {
        $set: {
          profileExpiresAt: { $add: ["$endDate", days * DAY, env.PROFILE_EXPIRY_HOURS * HOUR] },
          endDate: { $add: ["$endDate", days * DAY] },
          durationDays: { $add: ["$durationDays", days] },
          totalAmount: { $add: ["$totalAmount", amount] },
        },
      },
      { $unset: ["reminderSentAt", "expiredNotifiedAt"] },
    ],
    { returnDocument: "after", updatePipeline: true },
  ).populate("accommodation", "name");
  if (!updated) return null;
  await Promise.allSettled([
    sendEmail(
      updated.visitor.email,
      `Stay extended - ${updated.code}`,
      bookingConfirmedEmail(updated, accName(updated)),
    ),
    notifyAdmins({
      type: "booking_extended",
      title: "Stay extended",
      message: `${updated.visitor.name} extended ${accName(updated)} (${updated.code}) by ${days} day(s). New check-out: ${updated.endDate.toISOString()}.`,
      data: { bookingId: updated.id },
      email: false,
    }),
    notifyVisitor(updated.code, "booking:updated", { status: "active", endDate: updated.endDate }),
    emitWebhook("booking.extended", webhookPayload(updated)),
  ]);
  return updated;
}

/** Admin-side free extension (no payment record, e.g. granted by the church). */
export const adminExtend = (bookingId: string, days: number, amount = 0) => applyExtension(bookingId, days, amount);

export async function verifyPaystackPayment(reference: string) {
  const payment: any = await Payment.findOne({ reference });
  if (!payment || payment.method !== "paystack") throw notFound("Payment");
  if (payment.status !== "pending") return payment;

  const tx = await verifyTransaction(reference);
  if (tx.status === "success") {
    if (tx.currency !== "NGN" || tx.amount !== Math.round(payment.amount * 100)) {
      await Payment.updateOne({ _id: payment._id }, { status: "failed", gatewayResponse: tx });
      await notifyAdmins({
        type: "payment_mismatch",
        title: "Payment amount mismatch",
        message: `Paystack reference ${reference} succeeded with an unexpected amount (${tx.amount / 100} ${tx.currency}). Check it manually.`,
      });
      throw new AppError(422, "Payment amount mismatch. Please contact the church office.", "AMOUNT_MISMATCH");
    }
    await finalizePayment(payment._id, tx);
  } else if (["failed", "reversed"].includes(tx.status)) {
    await Payment.updateOne({ _id: payment._id, status: "pending" }, { status: "failed", gatewayResponse: tx });
  }
  return Payment.findById(payment._id).populate({ path: "booking", select: "code status profileToken" });
}

export async function submitTransferProof(
  reference: string,
  proof: { senderName: string; senderBank?: string; transferReference?: string; proofUrl?: string; note?: string },
) {
  const payment: any = await Payment.findOne({ reference });
  if (!payment || payment.method !== "bank_transfer") throw notFound("Payment");
  if (payment.status !== "pending" && payment.status !== "submitted") throw conflict(`Payment is already ${payment.status}`);
  const booking: any = await Booking.findById(payment.booking).populate("accommodation", "name");
  if (!booking) throw notFound("Booking");

  if (booking.status === "expired" && payment.purpose === "booking") {
    const occ = await occupancy(booking.accommodation._id, booking.startDate, booking.endDate, { excludeBookingId: booking._id });
    if (occ.isFull) throw conflict("This booking's hold expired and the accommodation was taken. Please contact the church office.", "HOLD_EXPIRED");
  } else if (!["pending_payment", "awaiting_confirmation", "active"].includes(booking.status)) {
    throw conflict(`Booking is ${booking.status}`);
  }

  payment.status = "submitted";
  payment.transfer = { ...proof, submittedAt: new Date() };
  await payment.save();
  if (payment.purpose === "booking") {
    await Booking.updateOne({ _id: booking._id }, { status: "awaiting_confirmation", $unset: { holdExpiresAt: 1 } });
  }

  await Promise.allSettled([
    notifyAdmins({
      type: "transfer_submitted",
      title: "Bank transfer awaiting confirmation",
      message: `${booking.visitor.name} says they paid ${money(payment.amount)} for ${accName(booking)} (${booking.code}). Sender: ${proof.senderName}.`,
      data: { paymentId: payment.id, bookingId: booking.id },
    }),
    sendEmail(
      booking.visitor.email,
      `We received your transfer details - ${booking.code}`,
      paymentReceivedEmail(booking.visitor.name, booking.code, "Thanks! We'll confirm your transfer shortly and email you your confirmation."),
    ),
    notifyVisitor(booking.code, "booking:updated", { status: "awaiting_confirmation" }),
  ]);
  return payment;
}

export async function rejectPayment(paymentId: string, reason: string) {
  const payment: any = await Payment.findOneAndUpdate(
    { _id: paymentId, status: { $in: ["pending", "submitted"] } },
    { status: "rejected", rejectionReason: reason },
    { returnDocument: "after" },
  );
  if (!payment) throw conflict("Payment is not awaiting confirmation");
  const booking: any = await Booking.findById(payment.booking);
  if (booking && payment.purpose === "booking" && ["pending_payment", "awaiting_confirmation"].includes(booking.status)) {
    await Booking.updateOne({ _id: booking._id }, { status: "cancelled", cancelReason: `Payment rejected: ${reason}`, $unset: { holdExpiresAt: 1 } });
  }
  if (booking) {
    await Promise.allSettled([
      sendEmail(booking.visitor.email, `Payment not confirmed - ${booking.code}`, paymentReceivedEmail(booking.visitor.name, booking.code, `We could not confirm your payment: ${reason}. Please contact the church office.`)),
      notifyVisitor(booking.code, "booking:updated", { status: "cancelled" }),
    ]);
  }
  return payment;
}

// ---- extension request (visitor / api) ---------------------------------------------------------

export async function requestExtension(bookingId: Types.ObjectId | string, extraDays: number, method: "paystack" | "bank_transfer", callbackUrl?: string) {
  const booking: any = await Booking.findById(bookingId).populate("accommodation", "name");
  if (!booking) throw notFound("Booking");
  if (booking.status !== "active") throw conflict("Only active bookings can be extended");
  if (booking.checkedOutAt) throw conflict("This booking has been checked out");
  if (booking.profileExpiresAt < new Date()) throw new AppError(410, "This booking link has expired", "EXPIRED");

  const q = await quote(booking.accommodation._id.toString(), booking.endDate, extraDays);
  if (!q.available) throw conflict(`Cannot extend: ${q.reasons.join(". ")}`, "NOT_AVAILABLE");

  const payment: any = await Payment.create({
    booking: booking._id,
    reference: paymentReference(),
    purpose: "extension",
    extensionDays: extraDays,
    method,
    amount: q.total,
  });
  let authorizationUrl: string | undefined;
  if (method === "paystack") {
    try {
      authorizationUrl = await initPaystack(payment, booking, callbackUrl);
    } catch (e) {
      await payment.deleteOne();
      throw e;
    }
  }
  return { payment, authorizationUrl, quote: q };
}

// ---- lifecycle ---------------------------------------------------------------------------------

export async function checkoutBooking(bookingId: string) {
  const booking: any = await Booking.findOneAndUpdate(
    { _id: bookingId, status: "active", checkedOutAt: { $exists: false } },
    { status: "completed", checkedOutAt: new Date() },
    { returnDocument: "after" },
  ).populate("accommodation", "name");
  if (!booking) throw conflict("Booking is not an active stay");
  await Promise.allSettled([
    sendEmail(booking.visitor.email, `Checked out - ${booking.code}`, endedEmail(booking, accName(booking))),
    notifyVisitor(booking.code, "booking:updated", { status: "completed" }),
    emitWebhook("booking.checked_out", webhookPayload(booking)),
  ]);
  return booking;
}

export async function cancelBooking(bookingId: string, reason: string, allowed: string[] = ["pending_payment", "awaiting_confirmation", "active"]) {
  const booking: any = await Booking.findOneAndUpdate(
    { _id: bookingId, status: { $in: allowed } },
    { status: "cancelled", cancelReason: reason, $unset: { holdExpiresAt: 1 } },
    { returnDocument: "after" },
  ).populate("accommodation", "name");
  if (!booking) throw conflict("Booking cannot be cancelled in its current state");
  await Promise.allSettled([
    notifyVisitor(booking.code, "booking:updated", { status: "cancelled" }),
    emitWebhook("booking.cancelled", webhookPayload(booking)),
  ]);
  return booking;
}
