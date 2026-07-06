-- Offboarding columns on clients table
ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS offboarded_at TIMESTAMPTZ;
