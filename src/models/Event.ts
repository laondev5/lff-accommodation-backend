import { Schema, model, models } from "mongoose";

const schema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    // Draft events are ignored by pricing/availability.
    isActive: { type: Boolean, default: true },
    // During an event ONLY accommodations listed here with isAvailable=true can be booked, at this price per day.
    accommodations: [
      {
        _id: false,
        accommodation: { type: Schema.Types.ObjectId, ref: "Accommodation", required: true },
        isAvailable: { type: Boolean, default: true },
        pricePerDay: { type: Number, required: true, min: 0 },
      },
    ],
  },
  { timestamps: true },
);
schema.index({ startDate: 1, endDate: 1 });
export const Event = models.Event || model("Event", schema);
