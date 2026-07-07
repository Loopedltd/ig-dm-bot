-- Normalise lead stage values to the approved list:
-- new, opener_sent, warm, high_intent, booking_sent, booked, call_completed, closed

UPDATE leads SET stage = 'booking_sent'   WHERE stage = 'booking_pushed';
UPDATE leads SET stage = 'call_completed' WHERE stage = 'post_call';
UPDATE leads SET stage = 'high_intent'    WHERE stage = 'objection_pending';
UPDATE leads SET stage = 'warm'           WHERE stage IN ('qualified', 'in_conversation', 'engaged');
UPDATE leads SET stage = 'closed'         WHERE stage = 'lost';
