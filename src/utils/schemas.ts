import { z } from "zod";

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
export const dateStr = z.coerce.date();
export const money = z.coerce.number().min(0).max(100_000_000);

export const visitorSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().min(7).max(20),
  whatsapp: z.string().trim().min(7).max(20),
});

export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const quoteQuery = z.object({
  startDate: dateStr,
  durationDays: z.coerce.number().int().min(1).max(90),
});

export const createBookingBody = z.object({
  accommodationId: objectId,
  startDate: dateStr,
  durationDays: z.coerce.number().int().min(1).max(90),
  visitor: visitorSchema,
  paymentMethod: z.enum(["paystack", "bank_transfer"]),
  callbackUrl: z.string().url().optional(),
});

export const transferProofBody = z.object({
  senderName: z.string().trim().min(2).max(120),
  senderBank: z.string().trim().max(80).optional(),
  transferReference: z.string().trim().max(120).optional(),
  proofUrl: z.string().url().optional(),
  note: z.string().trim().max(500).optional(),
});

export const extendBody = z.object({
  extraDays: z.coerce.number().int().min(1).max(60),
  paymentMethod: z.enum(["paystack", "bank_transfer"]),
  callbackUrl: z.string().url().optional(),
});
