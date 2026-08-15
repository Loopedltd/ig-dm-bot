-- ============================================================
-- Migration: Prevent the same Instagram account being simultaneously
--            active on two different client records
-- Date: 2026-08-15
--
-- WHY:
--   A bug in the previous connect flow (update-then-insert with RLS
--   blocking the read-back) could create two ig_accounts rows for the
--   same Instagram account on different clients. Application-level
--   deactivation guards have been added to the ig_connect and
--   fb_callback flows, but this DB-level constraint is the backstop:
--   even if the application guard is bypassed, the second INSERT will
--   fail clearly instead of silently creating a duplicate active row.
--
-- WHAT THIS DOES:
--   Partial unique index on fb_page_id WHERE is_active = true AND
--   fb_page_id IS NOT NULL.
--   - Deactivated rows (is_active = false) are excluded so offboarded
--     accounts don't block future reconnects.
--   - Rows without a fb_page_id (e.g. Instagram-only connections that
--     never completed the Facebook chain) are excluded.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS ig_accounts_fb_page_id_active_unique
  ON ig_accounts (fb_page_id)
  WHERE is_active = true AND fb_page_id IS NOT NULL;
