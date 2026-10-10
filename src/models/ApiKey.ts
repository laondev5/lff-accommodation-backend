import { Schema, model, models } from "mongoose";

const schema = new Schema(
  {
    name: { type: String, required: true },
    prefix: { type: String, required: true },
    keyHash: { type: String, required: true, unique: true },
    active: { type: Boolean, default: true },
    webhookUrl: String,
    webhookSecret: String,
    lastUsedAt: Date,
  },
  { timestamps: true },
);
export const ApiKey = models.ApiKey || model("ApiKey", schema);
