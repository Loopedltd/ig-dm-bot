-- Tracks when a coach was last notified about a paused lead.
-- Cleared when manual_override is reset so the next pause triggers a fresh email.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS coach_notified_at TIMESTAMPTZ;
