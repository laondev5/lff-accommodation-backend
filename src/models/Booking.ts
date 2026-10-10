import { Schema, model, models } from "mongoose";

export const BOOKING_STATUSES = ["pending_payment", "awaiting_confirmation", "active", "completed", "cancelled", "expired"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

const schema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    accommodation: { type: Schema.Types.ObjectId, ref: "Accommodation", required: true, index: true },
    visitor: {
      name: { type: String, required: true, trim: true },
      email: { type: String, required: true, lowercase: true, trim: true, index: true },
      phone: { type: String, required: true, trim: true },
      whatsapp: { type: String, required: true, trim: true },
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    durationDays: { type: Number, required: true, min: 1 },
    totalAmount: { type: Number, required: true },
    status: { type: String, enum: BOOKING_STATUSES, default: "pending_payment", index: true },
    holdExpiresAt: Date, // unpaid bookings stop blocking the accommodation after this
    source: { type: String, enum: ["web", "api", "admin"], default: "web" },
    apiKey: { type: Schema.Types.ObjectId, ref: "ApiKey" },
    profileToken: { type: String, required: true, unique: true },
    profileExpiresAt: { type: Date, required: true },
    checkedOutAt: Date,
    cancelReason: String,
    reminderSentAt: Date,
    expiredNotifiedAt: Date,
  },
  { timestamps: true },
);
schema.index({ accommodation: 1, startDate: 1, endDate: 1 });
schema.index({ status: 1, endDate: 1 });
export const Booking = models.Booking || model("Booking", schema);
