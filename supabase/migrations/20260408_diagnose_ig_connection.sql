-- ============================================================
-- Diagnose: Instagram "Not Connected" mismatch
-- Date: 2026-04-08
--
-- STEP 1: Run this to see ALL ig_accounts rows and ALL coach_users.
--         Find the client_id in ig_accounts for @seretti.jewellers
--         and compare it to the client_id in coach_users.
-- ============================================================

SELECT
  'ig_accounts' AS source,
  id,
  client_id,
  ig_username,
  is_active::text,
  created_at
FROM ig_accounts
ORDER BY created_at DESC
LIMIT 10;

SELECT
  'coach_users' AS source,
  id,
  email,
  client_id,
  created_at
FROM coach_users
ORDER BY created_at DESC
LIMIT 10;


-- ============================================================
-- STEP 2: Cross-reference — find if there is a client_id mismatch.
--         This query will show if the ig_accounts row for
--         @seretti.jewellers has a DIFFERENT client_id than
--         what is stored in coach_users.
-- ============================================================

SELECT
  a.id            AS ig_account_id,
  a.client_id     AS ig_account_client_id,
  a.ig_username,
  a.is_active,
  u.id            AS coach_user_id,
  u.email,
  u.client_id     AS coach_user_client_id,
  CASE
    WHEN a.client_id = u.client_id THEN 'MATCH ✓'
    ELSE 'MISMATCH ✗ — this is the bug'
  END AS status
FROM ig_accounts a
CROSS JOIN coach_users u
WHERE a.ig_username = 'seretti.jewellers';


-- ============================================================
-- STEP 3 (fix — only run if STEP 2 shows MISMATCH):
--
-- Replace YOUR_COACH_EMAIL with the actual email used to log in.
-- This updates ig_accounts to use the correct client_id.
-- ============================================================

-- UPDATE ig_accounts
-- SET client_id = (
--   SELECT client_id FROM coach_users WHERE email = 'YOUR_COACH_EMAIL' LIMIT 1
-- )
-- WHERE ig_username = 'seretti.jewellers';


-- ============================================================
-- ALTERNATIVE STEP 3 (fix using the debug API endpoint):
--
-- After deploying, hit this endpoint in your browser while
-- logged into the coach dashboard to see the JWT client_id
-- vs what is in ig_accounts:
--
--   GET /coach/api/instagram/debug
--   (requires Authorization: Bearer <your token>)
--
-- The response shows:
--   jwt_client_id   — what the current coach session uses
--   ig_accounts     — all rows with their client_ids
--
-- If jwt_client_id does not match any ig_accounts.client_id,
-- run the UPDATE above with the coach email to fix it.
-- ============================================================
