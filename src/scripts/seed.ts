import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import "../config/env";
import { connectDB } from "../config/db";
import { Accommodation } from "../models/Accommodation";
import { Admin } from "../models/Admin";
import { getSettings } from "../models/Settings";

async function main() {
  await connectDB();
  const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

  if (!(await Admin.exists({ email }))) {
    await Admin.create({ name: process.env.SEED_ADMIN_NAME ?? "Church Admin", email, password: await bcrypt.hash(password, 12) });
    console.log(`Created admin ${email}`);
  } else console.log(`Admin ${email} already exists`);

  await getSettings();

  if (process.argv.includes("--demo") && !(await Accommodation.exists({}))) {
    await Accommodation.insertMany([
      { name: "Room A1", type: "room", capacity: 2, basePricePerDay: 8000, amenities: ["WiFi", "AC", "Private bathroom"] },
      { name: "Room A2", type: "room", capacity: 2, basePricePerDay: 8000, amenities: ["WiFi", "Fan"] },
      { name: "Family Suite", type: "suite", capacity: 5, basePricePerDay: 20000, amenities: ["WiFi", "AC", "Kitchenette"] },
      { name: "Hostel Beds", type: "hostel", capacity: 1, totalUnits: 6, basePricePerDay: 3000, amenities: ["Shared bathroom"] },
    ]);
    console.log("Inserted demo accommodations");
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
