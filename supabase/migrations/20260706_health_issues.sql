-- Alert muting per client
ALTER TABLE clients ADD COLUMN IF NOT EXISTS alerts_muted BOOLEAN DEFAULT FALSE;

-- Health issues log
CREATE TABLE IF NOT EXISTS health_issues (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     TEXT NOT NULL,
  client_name   TEXT,
  issue_type    TEXT NOT NULL,
  issue_description TEXT NOT NULL,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved      BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at   TIMESTAMPTZ,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS health_issues_client_id_idx ON health_issues (client_id);
CREATE INDEX IF NOT EXISTS health_issues_resolved_idx  ON health_issues (resolved, detected_at DESC);
