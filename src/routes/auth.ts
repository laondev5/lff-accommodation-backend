import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { requireAdmin, signAdminToken } from "../middleware/auth";
import { Admin } from "../models/Admin";
import { AppError } from "../utils/AppError";

const r = Router();

r.post("/login", async (req, res) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const admin: any = await Admin.findOne({ email: email.toLowerCase() }).select("+password");
  // Always compare to avoid leaking which emails exist through timing.
  const ok = await bcrypt.compare(password, admin?.password ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali");
  if (!admin || !ok) throw new AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
  if (admin.active === false) throw new AppError(403, "This account has been deactivated. Contact an admin.", "ACCOUNT_DISABLED");
  res.json({ success: true, data: { token: signAdminToken(admin.id), admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role ?? "admin" } } });
});

r.get("/me", requireAdmin, async (req, res) => {
  const admin: any = await Admin.findById(req.adminId);
  res.json({ success: true, data: { id: admin.id, name: admin.name, email: admin.email, role: admin.role ?? "admin" } });
});

r.patch("/password", requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = z.object({ currentPassword: z.string(), newPassword: z.string().min(8).max(100) }).parse(req.body);
  const admin: any = await Admin.findById(req.adminId).select("+password");
  if (!(await bcrypt.compare(currentPassword, admin.password))) throw new AppError(400, "Current password is incorrect");
  admin.password = await bcrypt.hash(newPassword, 12);
  await admin.save();
  res.json({ success: true, data: { updated: true } });
});

export default r;
