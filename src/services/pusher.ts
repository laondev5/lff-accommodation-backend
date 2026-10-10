import Pusher from "pusher";
import { env } from "../config/env";

export const pusher =
  env.PUSHER_APP_ID && env.PUSHER_KEY && env.PUSHER_SECRET
    ? new Pusher({ appId: env.PUSHER_APP_ID, key: env.PUSHER_KEY, secret: env.PUSHER_SECRET, cluster: env.PUSHER_CLUSTER, useTLS: true })
    : null;

export const ADMIN_CHANNEL = "private-admin";
export const bookingChannel = (code: string) => `private-booking-${code}`;

/** Never throws: a failed push must not break the business flow. */
export async function push(channel: string, event: string, data: unknown) {
  if (!pusher) return;
  try {
    await pusher.trigger(channel, event, data);
  } catch (e) {
    console.error("[pusher] trigger failed", e);
  }
}
