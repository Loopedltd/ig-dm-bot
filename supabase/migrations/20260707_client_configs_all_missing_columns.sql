-- Comprehensive migration: add every column that the settings save endpoint
-- writes to client_configs, using IF NOT EXISTS so it is safe to run multiple times.
-- Run this in the Supabase SQL editor before deploying the settings save fix.

-- Voice training fields (confirmed missing — caused save failures)
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS voice_price_reply     TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS voice_objection_reply TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS voice_booking_push    TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS voice_quiet_lead      TEXT;

-- Story reply auto-DM
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS story_reply_auto_dm_enabled BOOLEAN DEFAULT false;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS story_reply_auto_dm_text    TEXT;

-- Comment reply auto-DM (distinct from comment keyword DM)
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS comment_reply_auto_dm_enabled BOOLEAN DEFAULT false;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS comment_reply_auto_dm_text    TEXT;

-- Keyword auto-DM (bio link / story keyword trigger)
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS keyword_auto_dm_enabled BOOLEAN DEFAULT false;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS keyword_trigger_text    TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS keyword_auto_dm_text    TEXT;

-- Booking & offer fields
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS booking_url_alt   TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS offer_price        TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS offer_description  TEXT;

-- Business context fields (used in AI prompt building)
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS how_it_works       TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS what_you_do        TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS what_they_get      TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS who_its_for        TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS main_result        TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS best_fit_leads     TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS not_a_fit          TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS common_objections  TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS closing_triggers   TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS urgency_reason     TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS trust_builders     TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS faq                TEXT;

-- Calendly integration key
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS calendly_api_key TEXT;

-- Custom 24h follow-up message
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS followup_message TEXT;

-- Response delay
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS response_delay_ms INT DEFAULT 90000;

-- Product and booking arrays
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS products      JSONB DEFAULT '[]'::jsonb;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS booking_items JSONB DEFAULT '[]'::jsonb;

-- Niche expansion
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS niche_other TEXT;

-- New follower DM
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS new_follower_dm_text TEXT;

-- Contact collection
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS contact_collection_enabled BOOLEAN DEFAULT false;

-- Comment keyword auto-DM (trigger on comment keywords, send DM + optional reply)
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS comment_keyword_dm_enabled      BOOLEAN DEFAULT false;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS comment_keyword_trigger         TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS comment_keyword_dm_text         TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS comment_keyword_reply_enabled   BOOLEAN DEFAULT false;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS comment_keyword_reply_text      TEXT;

-- Verify after running:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'client_configs' ORDER BY column_name;
