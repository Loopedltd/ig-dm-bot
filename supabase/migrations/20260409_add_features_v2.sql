-- ============================================================
-- Migration: Add 4 new features
-- Date: 2026-04-09
--
-- Feature 1: Comment-to-DM Keyword Automation (post comment webhooks)
-- Feature 2: Email & Phone Collection
-- Feature 3: Broadcast Messages
-- Feature 4: DM Safety Queue
-- ============================================================


-- ----------------------------------------
-- Feature 1 — Comment keyword DM config
-- ----------------------------------------
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS comment_keyword_dm_enabled boolean DEFAULT false;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS comment_keyword_trigger text;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS comment_keyword_dm_text text;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS comment_keyword_reply_enabled boolean DEFAULT false;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS comment_keyword_reply_text text;


-- ----------------------------------------
-- Feature 2 — Email & phone collection
-- ----------------------------------------
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS contact_collection_enabled boolean DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone text;


-- ----------------------------------------
-- Feature 4 — DM Safety Queue table
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS dm_queue (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid        NOT NULL,
  ig_psid     text        NOT NULL,
  message     text        NOT NULL,
  status      text        NOT NULL DEFAULT 'pending',   -- pending | sent | failed
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

ALTER TABLE dm_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role full access"
  ON dm_queue
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Index for efficient queue polling
CREATE INDEX IF NOT EXISTS dm_queue_status_created ON dm_queue (status, created_at);


-- ----------------------------------------
-- Verify after applying:
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'client_configs';
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'leads';
-- ----------------------------------------
