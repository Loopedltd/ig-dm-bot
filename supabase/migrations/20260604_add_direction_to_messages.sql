-- ============================================================
-- Migration: Add direction column to messages table
-- Date: 2026-06-04
--
-- WHY:
--   The messages table was originally created with a `role` column
--   (values: 'assistant' / 'user'). All application code that inserts
--   messages uses `direction` ('out' / 'in') instead. This mismatch
--   meant every insert was failing silently, so the messages table
--   was always empty — breaking conversation history and the inbox.
--
-- WHAT THIS DOES:
--   1. Adds a `direction` column (text) if it doesn't already exist.
--   2. Backfills existing rows from the `role` column if present:
--        role = 'assistant'  ->  direction = 'out'
--        role = anything else -> direction = 'in'
--   3. Adds an index for efficient per-lead message fetching.
-- ============================================================

-- 1. Add the column
ALTER TABLE messages ADD COLUMN IF NOT EXISTS direction text;

-- 2. Backfill from role column (safe no-op if role doesn't exist)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'messages'
      AND column_name = 'role'
      AND table_schema = 'public'
  ) THEN
    UPDATE messages
    SET direction = CASE
      WHEN role = 'assistant' THEN 'out'
      ELSE 'in'
    END
    WHERE direction IS NULL;
  END IF;
END $$;

-- 3. Index for fast lead thread fetching
CREATE INDEX IF NOT EXISTS messages_lead_id_created_at
  ON messages (lead_id, created_at ASC);
