-- ============================================================
-- Migration: Add token_expires_at column to ig_accounts
-- Date: 2026-06-04
--
-- WHY:
--   Instagram Business Login long-lived tokens expire after ~60 days.
--   We need to store the expiry time so a background job can refresh
--   tokens before they expire and avoid losing webhook delivery.
-- ============================================================

ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;
