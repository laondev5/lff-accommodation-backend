import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { Admin } from "../models/Admin";
import { AppError, notFound } from "../utils/AppError";
import { randomToken } from "../utils/helpers";
import { objectId } from "../utils/schemas";

/** Admin-only: create and manage manager accounts. (Mounted behind requireRole("admin").) */
const r = Router();
const ok = (res: any, data: unknown, status = 200) => res.status(status).json({ success: true, data });

const generatePassword = () => randomToken(6) + "Aa1"; // 15 chars, shown once to the admin
const view = (a: any) => ({ id: a.id, name: a.name, email: a.email, role: a.role ?? "admin", active: a.active !== false, createdAt: a.createdAt });

/** Only managers can be changed here, and never your own account. */
async function loadManager(id: string, selfId?: string) {
  const doc: any = await Admin.findById(id);
  if (!doc) throw notFound("Team member");
  if ((doc.role ?? "admin") !== "manager") throw new AppError(403, "Admin accounts can't be changed here", "FORBIDDEN");
  if (doc.id === selfId) throw new AppError(400, "You can't change your own account here");
  return doc;
}

r.get("/", async (_req, res) => {
  const staff = await Admin.find().sort({ createdAt: 1 });
  ok(res, staff.map(view));
});

r.post("/", async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(2).max(100),
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(8).max(100).optional(),
    })
    .parse(req.body);
  if (await Admin.exists({ email: body.email })) throw new AppError(409, "An account with this email already exists", "CONFLICT");
  const password = body.password ?? generatePassword();
  const doc: any = await Admin.create({ name: body.name, email: body.email, password: await bcrypt.hash(password, 12), role: "manager", createdBy: req.adminId });
  // The password is returned this once so the admin can hand it over; it is never stored in plain text.
  ok(res, { ...view(doc), password }, 201);
});

r.patch("/:id", async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(100).optional(), active: z.boolean().optional() }).parse(req.body);
  const doc = await loadManager(objectId.parse(req.params.id), req.adminId);
  if (body.name !== undefined) doc.name = body.name;
  if (body.active !== undefined) doc.active = body.active;
  await doc.save();
  ok(res, view(doc));
});

r.post("/:id/reset-password", async (req, res) => {
  const doc = await loadManager(objectId.parse(req.params.id), req.adminId);
  const password = generatePassword();
  doc.password = await bcrypt.hash(password, 12);
  await doc.save();
  ok(res, { ...view(doc), password });
});

r.delete("/:id", async (req, res) => {
  const doc = await loadManager(objectId.parse(req.params.id), req.adminId);
  await doc.deleteOne();
  ok(res, { deleted: true });
});

export default r;
