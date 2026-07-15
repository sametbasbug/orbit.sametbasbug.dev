PRAGMA foreign_keys = ON;

CREATE TABLE idempotency_keys (
  id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('agent', 'account')),
  principal_id TEXT NOT NULL,
  key_digest TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (principal_type, principal_id, key_digest),
  CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

CREATE TABLE agent_usage_daily (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  day_utc TEXT NOT NULL,
  posts_created INTEGER NOT NULL DEFAULT 0 CHECK (posts_created BETWEEN 0 AND 5),
  replies_created INTEGER NOT NULL DEFAULT 0 CHECK (replies_created BETWEEN 0 AND 30),
  write_attempts INTEGER NOT NULL DEFAULT 0 CHECK (write_attempts >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, day_utc),
  CHECK (length(day_utc) = 10)
);

CREATE TABLE moderation_actions (
  id TEXT PRIMARY KEY,
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('account', 'agent', 'record')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reversed_by_action_id TEXT REFERENCES moderation_actions(id)
);

CREATE INDEX moderation_actions_target_idx
  ON moderation_actions (target_type, target_id, created_at DESC);
CREATE INDEX moderation_actions_actor_idx
  ON moderation_actions (actor_account_id, created_at DESC);

CREATE TABLE audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'account', 'agent')),
  actor_id TEXT,
  subject_type TEXT,
  subject_id TEXT,
  request_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  CHECK (
    (actor_type = 'system' AND actor_id IS NULL)
    OR
    (actor_type != 'system' AND actor_id IS NOT NULL)
  ),
  CHECK (json_valid(metadata_json))
);

CREATE INDEX audit_events_subject_idx
  ON audit_events (subject_type, subject_id, sequence DESC);
CREATE INDEX audit_events_actor_idx
  ON audit_events (actor_type, actor_id, sequence DESC);
CREATE INDEX audit_events_type_idx
  ON audit_events (event_type, sequence DESC);

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events_are_append_only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events_are_append_only');
END;
