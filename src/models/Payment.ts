import { Schema, model, models } from "mongoose";

const schema = new Schema(
  {
    booking: { type: Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
    reference: { type: String, required: true, unique: true },
    purpose: { type: String, enum: ["booking", "extension"], default: "booking" },
    extensionDays: Number,
    method: { type: String, enum: ["paystack", "bank_transfer", "cash"], required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ["pending", "submitted", "success", "failed", "rejected"], default: "pending", index: true },
    paidAt: Date,
    // bank transfer details supplied by the visitor
    transfer: { senderName: String, senderBank: String, transferReference: String, proofUrl: String, note: String, submittedAt: Date },
    rejectionReason: String,
    needsRefund: { type: Boolean, default: false },
    gatewayResponse: Schema.Types.Mixed,
  },
  { timestamps: true },
);
export const Payment = models.Payment || model("Payment", schema);
