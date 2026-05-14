-- Pipeline CRM leads table
-- Standalone outreach tracking — no connection to coach/client tables.

create table if not exists pipeline_leads (
  id             uuid        primary key default gen_random_uuid(),
  handle         text        not null,
  followers      text,
  follower_count bigint,
  category       text,
  stage          text        not null default 'convo_cold',
  stage_reasoning text,
  notes          text,
  next_steps     jsonb       not null default '[]'::jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists pipeline_leads_created
  on pipeline_leads (created_at desc);
