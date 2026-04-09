-- ============================================================
-- New follower auto-DM support
-- Date: 2026-04-09
--
-- Run STEP 1 first, then STEP 2.
-- ============================================================

-- STEP 1: Add source column to leads table so follower leads
--         are tagged with source = 'new_follower'
-- ============================================================

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT NULL;


-- STEP 2: Add new_follower_dm_text column to client_configs so
--         coaches can set a custom message for new followers.
--         If not set, the bot falls back to the hardcoded default.
-- ============================================================

ALTER TABLE client_configs
  ADD COLUMN IF NOT EXISTS new_follower_dm_text TEXT DEFAULT NULL;
