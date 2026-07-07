-- Add last_comment_polled_at to ig_accounts for comment polling job.
-- Stores the timestamp of the last successful comment poll per account.
-- NULL means the account has never been polled (first poll uses a 24h window).
ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS last_comment_polled_at TIMESTAMPTZ;
