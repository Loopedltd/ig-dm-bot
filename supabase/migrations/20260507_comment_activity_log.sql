-- comment_activity_log
-- Stores one row every time a comment webhook fires and a DM is sent.
-- Used by the coach dashboard "Recent Comment Activity" section.

create table if not exists comment_activity_log (
  id           uuid        primary key default gen_random_uuid(),
  client_id    uuid        not null,
  ig_username  text,          -- commenter's Instagram handle (from webhook payload)
  trigger_type text        not null,  -- 'comment_keyword' | 'comment_auto_dm'
  keyword      text,          -- populated for comment_keyword events only
  status       text        not null default 'dm_sent',
  created_at   timestamptz not null default now()
);

create index if not exists comment_activity_log_client_created
  on comment_activity_log (client_id, created_at desc);
