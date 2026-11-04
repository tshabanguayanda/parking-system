// Grant the admin role to a Supabase Auth user, by email.
//   npm run grant-admin -- you@example.com
//
// Needs two env vars (never commit these):
//   SUPABASE_URL              same as VITE_SUPABASE_URL in .env.local
//   SUPABASE_SERVICE_ROLE_KEY Project Settings > API > service_role (secret!)
//
// Run as, e.g.:
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... npm run grant-admin -- you@example.com
import { createClient } from "@supabase/supabase-js";

const [role, email] = process.argv.slice(2);
if (role !== "admin" || !email) {
  console.error("Usage: node scripts/grant-role.js admin <email>");
  process.exit(1);
}

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error(
    "Missing env vars. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first " +
    "(Project Settings > API > service_role key – keep it secret, never commit it).",
  );
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const { data: list, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (listErr) { console.error(listErr.message); process.exit(1); }
const user = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`No account with email ${email}. They must sign up in the app first.`);
  process.exit(1);
}

const { error } = await admin.from("profiles").update({ role }).eq("id", user.id);
if (error) { console.error(error.message); process.exit(1); }
console.log(`"${role}" role granted to ${email}. They must sign out and back in.`);
