-- ============================================================
-- Diagnostic + Restore: Instagram account (@seretti.jewellers)
-- Date: 2026-04-11
--
-- STEP 1: Run this SELECT first to see the current state.
--         Paste the output back if you need help deciding what to do.
-- ============================================================

SELECT
  id,
  client_id,
  ig_user_id,
  ig_username,
  page_id,
  is_active,
  created_at
FROM ig_accounts
ORDER BY created_at DESC
LIMIT 5;


-- ============================================================
-- STEP 2 (only if is_active = false for the seretti.jewellers row):
--
-- If the SELECT above shows a row for ig_username = 'seretti.jewellers'
-- but is_active is false, run this to restore it:
-- ============================================================

-- UPDATE ig_accounts
-- SET is_active = true
-- WHERE ig_username = 'seretti.jewellers';


-- ============================================================
-- STEP 3 (only if there are MULTIPLE rows for the same client_id):
--
-- The status API uses .single() which errors if more than one row
-- matches client_id + is_active = true.
-- If you see duplicate rows for the same client_id, deactivate the older one:
-- ============================================================

-- UPDATE ig_accounts
-- SET is_active = false
-- WHERE ig_username = 'seretti.jewellers'
--   AND id != (
--     SELECT id FROM ig_accounts
--     WHERE ig_username = 'seretti.jewellers'
--     ORDER BY created_at DESC
--     LIMIT 1
--   );


-- ============================================================
-- STEP 4 (nuclear option — if nothing else works):
--
-- If the row is missing entirely, you will need to go through
-- the Connect Instagram button to re-authenticate via OAuth.
-- There is no way to restore a deleted row without the original
-- OAuth tokens from Meta.
-- ============================================================
