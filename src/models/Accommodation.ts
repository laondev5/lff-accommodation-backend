import { Schema, model, models } from "mongoose";

export const ACCOMMODATION_TYPES = ["room", "suite", "apartment", "hostel", "other"] as const;

const schema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    type: { type: String, enum: ACCOMMODATION_TYPES, default: "room" },
    capacity: { type: Number, required: true, min: 1, default: 1 }, // people per unit
    totalUnits: { type: Number, required: true, min: 1, default: 1 }, // how many can be booked at once (e.g. 6 beds); full when all are taken
    amenities: [String],
    images: [String],
    basePricePerDay: { type: Number, required: true, min: 0 },
    isLocked: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);
export const Accommodation = models.Accommodation || model("Accommodation", schema);
