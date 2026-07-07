-- Fix: ig_user_id stored as ASID (34568616436085679) but webhook delivers IGBID (17841475448308944).
-- The /me endpoint returns the App-Scoped User ID (ASID); webhooks use the Instagram Business
-- Account ID (IGBID). These differ and the IGBID is authoritative for webhook routing.
-- Run this in the Supabase SQL editor, then resubscribe the webhook from the Settings page.

UPDATE ig_accounts
SET ig_user_id = '17841475448308944'
WHERE client_id = '2b43a8f2-a355-4793-b6c5-73a99e08a40f'
  AND ig_user_id = '34568616436085679';

-- Verify:
-- SELECT client_id, ig_user_id, ig_username FROM ig_accounts WHERE client_id = '2b43a8f2-a355-4793-b6c5-73a99e08a40f';
