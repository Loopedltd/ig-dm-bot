-- Add tone, style, vocabulary columns to client_configs
-- These were referenced in code but missing from migrations.
-- Safe to run multiple times (IF NOT EXISTS).

ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS tone text;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS style text;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS vocabulary text;
