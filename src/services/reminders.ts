import { env } from "../config/env";
import { Booking } from "../models/Booking";
import { endedEmail, reminderEmail, sendEmail } from "./email";
import { emitWebhook, notifyAdmins, notifyVisitor } from "./notify";
import { webhookPayload } from "./booking";
import { fmtDate, HOUR } from "../utils/helpers";

const name = (b: any) => b.accommodation?.name ?? "an accommodation";

/**
 * Run every 10-15 minutes from an external scheduler.
 * Each step "claims" a booking atomically (sets a timestamp), so overlapping runs never double-notify.
 */
export async function processScheduledJobs() {
  const now = new Date();
  const result = { reminders: 0, expired: 0, holdsReleased: 0 };

  // 1. Unpaid holds that lapsed.
  const released = await Booking.updateMany({ status: "pending_payment", holdExpiresAt: { $lte: now } }, { status: "expired" });
  result.holdsReleased = released.modifiedCount;

  // 2. Stays ending within REMINDER_HOURS -> notify visitor and admin once.
  const soon = new Date(now.getTime() + env.REMINDER_HOURS * HOUR);
  for (;;) {
    const b: any = await Booking.findOneAndUpdate(
      { status: "active", checkedOutAt: { $exists: false }, endDate: { $gt: now, $lte: soon }, reminderSentAt: { $exists: false } },
      { reminderSentAt: now },
      { returnDocument: "after" },
    ).populate("accommodation", "name");
    if (!b) break;
    result.reminders++;
    await Promise.allSettled([
      sendEmail(b.visitor.email, `Your stay ends soon - ${b.code}`, reminderEmail(b, name(b))),
      notifyVisitor(b.code, "booking:reminder", { endDate: b.endDate, message: `Your stay ends at ${fmtDate(b.endDate)}.` }),
      notifyAdmins({
        type: "expiring_soon",
        title: "Accommodation expiring soon",
        message: `${name(b)} (${b.visitor.name}, ${b.code}) expires at ${fmtDate(b.endDate)}.`,
        data: { bookingId: b.id, code: b.code },
      }),
      emitWebhook("booking.expiring", webhookPayload(b)),
    ]);
  }

  // 3. Stays that have ended and haven't been signed out.
  for (;;) {
    const b: any = await Booking.findOneAndUpdate(
      { status: "active", checkedOutAt: { $exists: false }, endDate: { $lte: now }, expiredNotifiedAt: { $exists: false } },
      { expiredNotifiedAt: now },
      { returnDocument: "after" },
    ).populate("accommodation", "name");
    if (!b) break;
    result.expired++;
    await Promise.allSettled([
      sendEmail(b.visitor.email, `Your stay has ended - ${b.code}`, endedEmail(b, name(b))),
      notifyVisitor(b.code, "booking:expired", { endDate: b.endDate }),
      notifyAdmins({
        type: "expired",
        title: "Accommodation expired",
        message: `${name(b)} - ${b.visitor.name} (${b.code}) has reached check-out time. Sign them out when they leave.`,
        data: { bookingId: b.id, code: b.code },
      }),
      emitWebhook("booking.expired", webhookPayload(b)),
    ]);
  }

  return result;
}
