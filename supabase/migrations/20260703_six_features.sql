-- Feature 2: Multiple products/services
ALTER TABLE client_configs
  ADD COLUMN IF NOT EXISTS products JSONB DEFAULT '[]'::jsonb;

-- Feature 4: Custom 24h follow-up message
ALTER TABLE client_configs
  ADD COLUMN IF NOT EXISTS followup_message TEXT;

-- Feature 6: Response delay (ms; 30000–180000; default 90s)
ALTER TABLE client_configs
  ADD COLUMN IF NOT EXISTS response_delay_ms INT DEFAULT 90000;

-- Features 1+4, 3, 5 use existing columns only - no migration needed.

-- Unified booking links & products
ALTER TABLE client_configs
  ADD COLUMN IF NOT EXISTS booking_items JSONB DEFAULT '[]'::jsonb;

-- Expanded niche: stores free-text "other" niche description
ALTER TABLE client_configs
  ADD COLUMN IF NOT EXISTS niche_other TEXT;
