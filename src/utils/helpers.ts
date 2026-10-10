import crypto from "crypto";
import { env } from "../config/env";

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export function randomCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}
export const bookingCode = () => `${env.BOOKING_CODE_PREFIX}-${randomCode(6)}`;
export const paymentReference = () => `${env.BOOKING_CODE_PREFIX}PAY-${Date.now().toString(36).toUpperCase()}${randomCode(5)}`;
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export const money = (n: number) => `₦${n.toLocaleString("en-NG")}`;
export const fmtDate = (d: Date) =>
  d.toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" });

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
