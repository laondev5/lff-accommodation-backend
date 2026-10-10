import { Schema, model, models } from "mongoose";

const schema = new Schema(
  {
    type: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    data: Schema.Types.Mixed,
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);
export const Notification = models.Notification || model("Notification", schema);
