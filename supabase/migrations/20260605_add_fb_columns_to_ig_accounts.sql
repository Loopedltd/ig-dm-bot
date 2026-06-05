-- ============================================================
-- Migration: Add Facebook Login columns to ig_accounts
-- Date: 2026-06-05
--
-- WHY:
--   The chained OAuth flow (Instagram Login → Facebook Login for Business)
--   stores both tokens on the same ig_accounts row.
--   fb_page_id  = the Facebook Page ID from /me/accounts
--   fb_page_token = the long-lived Facebook Page access token
--   These are used for comment replies and future Facebook-side features.
--   page_access_token stays as the Instagram Login token (page_id stays NULL).
-- ============================================================

ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS fb_page_id   text;
ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS fb_page_token text;
