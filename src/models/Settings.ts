import { Schema, model, models } from "mongoose";

const schema = new Schema(
  {
    key: { type: String, default: "main", unique: true },
    churchName: { type: String, default: "Our Church" },
    contactEmail: String,
    contactPhone: String,
    bankAccounts: [
      {
        bankName: { type: String, required: true },
        accountNumber: { type: String, required: true },
        accountName: { type: String, required: true },
        active: { type: Boolean, default: true },
      },
    ],
  },
  { timestamps: true },
);
export const Settings = models.Settings || model("Settings", schema);

export async function getSettings() {
  return (await Settings.findOne({ key: "main" })) ?? (await Settings.create({ key: "main" }));
}
