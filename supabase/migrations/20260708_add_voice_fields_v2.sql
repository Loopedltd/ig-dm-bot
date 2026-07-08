-- Add 6 new voice training fields to client_configs.
-- These capture coach responses for common objections and buying signals,
-- used as few-shot pairs in the AI system prompt.
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS voice_price_too_much TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS voice_need_to_think TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS voice_not_sure_works TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS voice_no_time TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS voice_ready_to_book TEXT;
ALTER TABLE client_configs ADD COLUMN IF NOT EXISTS voice_wants_link TEXT;
