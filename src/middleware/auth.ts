import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { Admin } from "../models/Admin";
import { ApiKey } from "../models/ApiKey";
import { AppError } from "../utils/AppError";
import { sha256 } from "../utils/helpers";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminId?: string;
      apiKeyId?: string;
      rawBody?: Buffer;
    }
  }
}

export const signAdminToken = (adminId: string) =>
  jwt.sign({ sub: adminId }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] });

export function adminIdFromToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

const bearer = (req: Request) => req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];

export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const token = bearer(req);
  const id = token ? adminIdFromToken(token) : null;
  if (!id || !(await Admin.exists({ _id: id }))) throw new AppError(401, "Authentication required", "UNAUTHORIZED");
  req.adminId = id;
  next();
}

export async function requireApiKey(req: Request, _res: Response, next: NextFunction) {
  const key = req.headers["x-api-key"];
  if (typeof key !== "string" || !key) throw new AppError(401, "Missing x-api-key header", "UNAUTHORIZED");
  const doc = await ApiKey.findOneAndUpdate({ keyHash: sha256(key), active: true }, { lastUsedAt: new Date() }).select("_id");
  if (!doc) throw new AppError(401, "Invalid or revoked API key", "UNAUTHORIZED");
  req.apiKeyId = doc.id;
  next();
}
