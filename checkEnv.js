import dotenv from "dotenv";
dotenv.config({ path: ".env" });

console.log("URL?", !!process.env.SUPABASE_URL, "KEY?", !!process.env.SUPABASE_SERVICE_ROLE_KEY);
