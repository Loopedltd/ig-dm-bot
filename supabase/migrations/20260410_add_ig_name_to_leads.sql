-- Add ig_name (display name from Instagram API) to leads
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ig_name text;
