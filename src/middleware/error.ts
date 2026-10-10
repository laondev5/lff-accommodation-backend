import { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../utils/AppError";

export const notFoundHandler = (req: Request, res: Response) =>
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found`, code: "NOT_FOUND" });

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ success: false, message: err.message, code: err.code, details: err.details });
  }
  if (err instanceof ZodError) {
    const errors = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return res.status(400).json({ success: false, message: errors[0] ? `${errors[0].path}: ${errors[0].message}` : "Validation failed", code: "VALIDATION_ERROR", errors });
  }
  if (err?.name === "CastError") return res.status(400).json({ success: false, message: "Invalid identifier", code: "BAD_REQUEST" });
  if (err?.code === 11000) return res.status(409).json({ success: false, message: "Duplicate value", code: "CONFLICT" });
  if (err?.type === "entity.parse.failed") return res.status(400).json({ success: false, message: "Invalid JSON body", code: "BAD_REQUEST" });
  console.error(err);
  res.status(500).json({ success: false, message: "Internal server error", code: "INTERNAL" });
}
