export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const notFound = (what = "Resource") => new AppError(404, `${what} not found`, "NOT_FOUND");
export const badRequest = (msg: string, code = "BAD_REQUEST") => new AppError(400, msg, code);
export const conflict = (msg: string, code = "CONFLICT") => new AppError(409, msg, code);
