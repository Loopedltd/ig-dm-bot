import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

// Only load .env for local/dev. In production, your host injects env vars.
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: ".env" });
}

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables");
}

export const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});
