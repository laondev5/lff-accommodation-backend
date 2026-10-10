import crypto from "crypto";
import { env } from "../config/env";
import { AppError } from "../utils/AppError";

const BASE = "https://api.paystack.co";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!env.PAYSTACK_SECRET_KEY) throw new AppError(503, "Online payment is not configured", "PAYSTACK_NOT_CONFIGURED");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, "content-type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(15000),
  });
  const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
  if (!res.ok || !json.status) throw new AppError(502, json.message || "Paystack request failed", "PAYSTACK_ERROR");
  return json.data as T;
}

export const initializeTransaction = (p: { email: string; amountNaira: number; reference: string; callbackUrl: string; metadata?: object }) =>
  call<{ authorization_url: string; access_code: string; reference: string }>("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({ email: p.email, amount: Math.round(p.amountNaira * 100), reference: p.reference, callback_url: p.callbackUrl, currency: "NGN", metadata: p.metadata }),
  });

export const verifyTransaction = (reference: string) =>
  call<{ status: string; amount: number; currency: string; reference: string; gateway_response: string }>(`/transaction/verify/${encodeURIComponent(reference)}`);

export function isValidWebhookSignature(rawBody: Buffer | undefined, signature: string | undefined) {
  if (!env.PAYSTACK_SECRET_KEY || !rawBody || !signature) return false;
  const expected = crypto.createHmac("sha512", env.PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
