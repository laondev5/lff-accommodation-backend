import mongoose from "mongoose";
import { env } from "./env";

// Cache the connection across serverless invocations.
const g = globalThis as unknown as { _mongo?: { conn?: typeof mongoose; promise?: Promise<typeof mongoose> } };
const cache = (g._mongo ??= {});

export async function connectDB() {
  if (cache.conn) return cache.conn;
  cache.promise ??= mongoose.connect(env.MONGODB_URI, { bufferCommands: false, serverSelectionTimeoutMS: 8000 });
  try {
    cache.conn = await cache.promise;
  } catch (e) {
    cache.promise = undefined;
    throw e;
  }
  return cache.conn;
}
