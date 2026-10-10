import crypto from "crypto";
import { Admin } from "../models/Admin";
import { ApiKey } from "../models/ApiKey";
import { Notification } from "../models/Notification";
import { adminAlertEmail, sendEmail } from "./email";
import { ADMIN_CHANNEL, bookingChannel, push } from "./pusher";

interface AdminNotice {
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  email?: boolean;
}

/** Stores the notification, pushes it live to the dashboard, and (optionally) emails every admin. */
export async function notifyAdmins({ type, title, message, data, email = true }: AdminNotice) {
  const doc = await Notification.create({ type, title, message, data });
  const tasks: Promise<unknown>[] = [push(ADMIN_CHANNEL, "notification", doc.toJSON())];
  if (email) {
    tasks.push(
      Admin.find({ active: { $ne: false } }).select("email").lean().then((admins: { email: string }[]) =>
        sendEmail(admins.map((a) => a.email), title, adminAlertEmail(title, message)),
      ),
    );
  }
  await Promise.allSettled(tasks);
}

export const notifyVisitor = (code: string, event: string, data: Record<string, unknown>) => push(bookingChannel(code), event, data);

/** Signed outbound webhooks for third-party apps that registered a webhook URL on their API key. */
export async function emitWebhook(event: string, data: Record<string, unknown>) {
  const keys = await ApiKey.find({ active: true, webhookUrl: { $exists: true, $ne: "" } }).select("webhookUrl webhookSecret").lean();
  const body = JSON.stringify({ event, data, sentAt: new Date().toISOString() });
  await Promise.allSettled(
    keys.map(async (k: { webhookUrl: string; webhookSecret?: string }) => {
      const signature = crypto.createHmac("sha256", k.webhookSecret ?? "").update(body).digest("hex");
      await fetch(k.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lff-event": event, "x-lff-signature": signature },
        body,
        signal: AbortSignal.timeout(5000),
      });
    }),
  );
}
