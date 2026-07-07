-- Add setup fee and monthly retainer to clients table (stored in pence)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS setup_fee INTEGER DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS monthly_retainer INTEGER DEFAULT 0;
