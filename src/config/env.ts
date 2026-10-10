import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default("7d"),
  CLIENT_URL: z.string().default("http://localhost:3000"),

  BOOKING_CODE_PREFIX: z.string().default("LFF"),
  PAYSTACK_HOLD_MINUTES: z.coerce.number().default(30),
  BANK_TRANSFER_HOLD_MINUTES: z.coerce.number().default(180),
  REMINDER_HOURS: z.coerce.number().default(5),
  PROFILE_EXPIRY_HOURS: z.coerce.number().default(12),

  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),
  PUSHER_APP_ID: z.string().optional(),
  PUSHER_KEY: z.string().optional(),
  PUSHER_SECRET: z.string().optional(),
  PUSHER_CLUSTER: z.string().default("mt1"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("LFF Accommodation <onboarding@resend.dev>"),
  CRON_SECRET: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:", z.treeifyError(parsed.error));
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
export const clientOrigins = env.CLIENT_URL.split(",").map((s) => s.trim().replace(/\/$/, ""));
export const primaryClientUrl = clientOrigins[0];
