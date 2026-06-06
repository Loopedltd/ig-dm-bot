-- ============================================================
-- Migration: Add story reply columns to messages
-- Date: 2026-06-06
--
-- WHY:
--   When a user replies to a coach's Instagram story, the webhook
--   delivers a message with reply_to.story context. We store that
--   context so the inbox can display "Replied to your story" with
--   a thumbnail if the story is still live.
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type   text    NOT NULL DEFAULT 'dm';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS story_id        text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS story_url       text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS story_media_url text;
