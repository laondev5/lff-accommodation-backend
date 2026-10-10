import { Schema, model, models } from "mongoose";

export const STAFF_ROLES = ["admin", "manager"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

// Staff accounts. Accounts created before roles existed have no `role` and are treated as "admin".
const schema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: STAFF_ROLES, default: "admin" },
    active: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true },
);
export const Admin = models.Admin || model("Admin", schema);
