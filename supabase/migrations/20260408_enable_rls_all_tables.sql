-- ============================================================
-- Migration: Enable Row Level Security on all public tables
-- Date: 2026-04-08
--
-- WHY THIS IS SAFE:
--   The Express server uses SUPABASE_SERVICE_ROLE_KEY which
--   bypasses RLS entirely. Enabling RLS only affects direct
--   REST/PostgREST API calls made with the anon key —
--   i.e. anyone hitting your Supabase URL directly without
--   going through your server. Zero server-side queries are
--   affected.
--
-- WHAT THIS BLOCKS:
--   Direct anon-key access to all tables, including:
--     - coach_users  (password hashes, emails)
--     - ig_accounts  (Instagram page_access_tokens)
--     - leads        (ig_psid, personal conversation data)
--     - messages     (private DM conversation content)
--     - clients      (coach business data)
--     - client_configs (system prompts, booking URLs, pricing)
--     - client_usage
--     - lead_memory
--     - learned_examples
--     - payment_links
-- ============================================================


-- ----------------------------------------
-- 1. coach_users — most sensitive: password hashes + emails
-- ----------------------------------------
ALTER TABLE coach_users ENABLE ROW LEVEL SECURITY;

-- No anon policies. Service role bypasses RLS and continues to work.
-- Explicitly document that service_role has full access:
CREATE POLICY "service_role full access"
  ON coach_users
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ----------------------------------------
-- 2. ig_accounts — contains page_access_token (OAuth tokens)
-- ----------------------------------------
ALTER TABLE ig_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON ig_accounts
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ----------------------------------------
-- 3. clients — coach business records
-- ----------------------------------------
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON clients
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ----------------------------------------
-- 4. client_configs — system prompts, booking URLs, offer details
-- ----------------------------------------
ALTER TABLE client_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON client_configs
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ----------------------------------------
-- 5. leads — ig_psid, stage, booking status, personal identifiers
-- ----------------------------------------
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON leads
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ----------------------------------------
-- 6. messages — private DM conversation content
-- ----------------------------------------
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON messages
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ----------------------------------------
-- 7. lead_memory — goals, pain points, objections, personal context
-- ----------------------------------------
ALTER TABLE lead_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON lead_memory
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ----------------------------------------
-- 8. learned_examples — AI training data from real conversations
-- ----------------------------------------
ALTER TABLE learned_examples ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON learned_examples
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ----------------------------------------
-- 9. payment_links — Stripe payment link data
-- ----------------------------------------
ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON payment_links
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ----------------------------------------
-- 10. client_usage — prompt generation counts
-- ----------------------------------------
ALTER TABLE client_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON client_usage
  TO service_role
  USING (true)
  WITH CHECK (true);


-- ----------------------------------------
-- Verify RLS is enabled on all tables
-- Run this SELECT after applying the migration to confirm:
-- ----------------------------------------
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
-- ORDER BY tablename;
