-- ============================================================
-- Migration: Add all missing columns to lead_memory
-- Date: 2026-06-07
--
-- WHY:
--   The lead_memory table was created without several columns that
--   the application code references. Running upserts with these
--   fields causes "Could not find the '...' column" schema cache
--   errors. This migration adds every column the code uses,
--   all with IF NOT EXISTS so it is safe to re-run.
-- ============================================================

-- Core profiling fields
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS summary              text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS goal                 text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS current_situation    text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS pain_points          text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS desired_outcome      text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS objection            text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS intent_level         text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS last_question_asked  text;

-- Extended context fields added later
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS timeline             text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS event_name           text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS motivation           text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS budget               text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS trust_barrier        text;

-- CTA tracking
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS last_cta_type        text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS last_cta_at          timestamptz;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS last_cta_response    text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS cta_attempts         integer NOT NULL DEFAULT 0;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS booking_link_sent_count integer NOT NULL DEFAULT 0;

-- Bot state tracking
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS last_user_intent     text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS last_bot_reply_type  text;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS conversation_state   text;

-- Answer frequency counters (prevent repeating the same explanation)
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS answered_price_count        integer NOT NULL DEFAULT 0;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS answered_offer_count        integer NOT NULL DEFAULT 0;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS answered_process_count      integer NOT NULL DEFAULT 0;
ALTER TABLE lead_memory ADD COLUMN IF NOT EXISTS answered_who_its_for_count  integer NOT NULL DEFAULT 0;
