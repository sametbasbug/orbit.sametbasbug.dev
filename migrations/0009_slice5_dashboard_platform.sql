PRAGMA foreign_keys = ON;

CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body_markdown TEXT NOT NULL CHECK (length(body_markdown) BETWEEN 1 AND 4000),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  audience_type TEXT NOT NULL CHECK (audience_type IN ('all_agents', 'equinox_agents', 'agent')),
  target_agent_id TEXT REFERENCES agents(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'expired', 'withdrawn')),
  starts_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  withdrawn_at INTEGER,
  CHECK (expires_at IS NULL OR expires_at > starts_at),
  CHECK (
    (audience_type = 'agent' AND target_agent_id IS NOT NULL)
    OR (audience_type != 'agent' AND target_agent_id IS NULL)
  )
);

CREATE INDEX announcements_active_idx
  ON announcements (status, starts_at, expires_at, severity, id);
CREATE INDEX announcements_target_idx
  ON announcements (audience_type, target_agent_id, status, starts_at);

CREATE TABLE announcement_transitions (
  id TEXT PRIMARY KEY,
  announcement_id TEXT NOT NULL REFERENCES announcements(id),
  action TEXT NOT NULL CHECK (action IN ('publish', 'withdraw')),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL
);

CREATE TRIGGER announcement_transitions_validate
BEFORE INSERT ON announcement_transitions
BEGIN
  SELECT RAISE(ABORT, 'announcement_transition_invalid')
  WHERE NOT EXISTS (
    SELECT 1 FROM announcements
    WHERE id = NEW.announcement_id
      AND (
        (NEW.action = 'publish' AND status = 'draft')
        OR (NEW.action = 'withdraw' AND status IN ('draft', 'active'))
      )
  );
END;

CREATE TRIGGER announcement_transitions_apply
AFTER INSERT ON announcement_transitions
BEGIN
  UPDATE announcements
  SET status = CASE WHEN NEW.action = 'publish' THEN 'active' ELSE 'withdrawn' END,
      updated_at = NEW.created_at,
      published_at = CASE
        WHEN NEW.action = 'publish' THEN COALESCE(published_at, NEW.created_at)
        ELSE published_at
      END,
      withdrawn_at = CASE WHEN NEW.action = 'withdraw' THEN NEW.created_at ELSE withdrawn_at END
  WHERE id = NEW.announcement_id;
END;

CREATE TABLE announcement_reads (
  announcement_id TEXT NOT NULL REFERENCES announcements(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  read_at INTEGER NOT NULL,
  PRIMARY KEY (announcement_id, agent_id)
);

CREATE INDEX announcement_reads_agent_idx
  ON announcement_reads (agent_id, read_at DESC);

CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY,
  backup_kind TEXT NOT NULL CHECK (backup_kind IN ('daily', 'weekly', 'monthly', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  object_key TEXT,
  manifest_checksum TEXT,
  schema_version INTEGER,
  counts_json TEXT CHECK (counts_json IS NULL OR json_valid(counts_json)),
  error_code TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  created_by_account_id TEXT REFERENCES accounts(id),
  CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status != 'running' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX backup_runs_status_idx
  ON backup_runs (status, started_at DESC);
CREATE INDEX backup_runs_kind_idx
  ON backup_runs (backup_kind, started_at DESC);

ALTER TABLE moderation_actions ADD COLUMN reverses_action_id TEXT REFERENCES moderation_actions(id);

CREATE UNIQUE INDEX moderation_actions_one_reversal_idx
  ON moderation_actions (reverses_action_id)
  WHERE reverses_action_id IS NOT NULL;

CREATE TRIGGER moderation_reversal_validate
BEFORE INSERT ON moderation_actions
WHEN NEW.reverses_action_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'moderation_reversal_invalid')
  WHERE NEW.action != 'reversal'
     OR NOT EXISTS (
       SELECT 1 FROM moderation_actions original
       WHERE original.id = NEW.reverses_action_id
         AND original.target_type = NEW.target_type
         AND original.target_id = NEW.target_id
         AND original.reversed_by_action_id IS NULL
     )
     OR EXISTS (
       SELECT 1
       FROM moderation_actions original
       JOIN moderation_actions newer
         ON newer.target_type = original.target_type
        AND newer.target_id = original.target_id
        AND (newer.created_at > original.created_at
          OR (newer.created_at = original.created_at AND newer.id > original.id))
       WHERE original.id = NEW.reverses_action_id
         AND newer.reversed_by_action_id IS NULL
     );
END;

CREATE TRIGGER moderation_reversal_apply
AFTER INSERT ON moderation_actions
WHEN NEW.reverses_action_id IS NOT NULL
BEGIN
  UPDATE moderation_actions
  SET reversed_by_action_id = NEW.id
  WHERE id = NEW.reverses_action_id AND reversed_by_action_id IS NULL;

  UPDATE records
  SET lifecycle_state = CASE WHEN current_revision_id IS NOT NULL THEN 'published' ELSE lifecycle_state END,
      deleted_at = NULL,
      moderation_state = 'visible',
      moderated_at = NEW.created_at,
      updated_at = NEW.created_at,
      version = version + 1
  WHERE NEW.target_type = 'record' AND id = NEW.target_id;
END;
