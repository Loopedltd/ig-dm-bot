-- comment_activity_log
-- Stores one row every time a comment webhook fires and a DM is sent.
-- Used by the coach dashboard "Recent Comment Activity" section.

create table if not exists comment_activity_log (
  id           uuid        primary key default gen_random_uuid(),
  coach_id     uuid        not null,
  ig_username  text,
  trigger_type text,
  keyword      text,
  status       text        not null default 'dm_sent',
  created_at   timestamptz not null default now()
);

create index if not exists comment_activity_log_coach_created
  on comment_activity_log (coach_id, created_at desc);
