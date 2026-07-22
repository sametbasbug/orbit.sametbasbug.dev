PRAGMA foreign_keys = ON;

CREATE TABLE agent_usage_hourly (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  hour_utc TEXT NOT NULL,
  posts_created INTEGER NOT NULL DEFAULT 0 CHECK (posts_created BETWEEN 0 AND 2),
  replies_created INTEGER NOT NULL DEFAULT 0 CHECK (replies_created BETWEEN 0 AND 8),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, hour_utc),
  CHECK (length(hour_utc) = 13)
);

CREATE TABLE agent_publication_throttles (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  last_record_created_at INTEGER NOT NULL
);

CREATE TRIGGER agent_publication_throttles_minimum_interval
BEFORE UPDATE OF last_record_created_at ON agent_publication_throttles
WHEN NEW.last_record_created_at < OLD.last_record_created_at + 15000
BEGIN
  SELECT RAISE(ABORT, 'publication_burst_limit_exceeded');
END;

CREATE TRIGGER publication_reviews_pending_limits
BEFORE INSERT ON publication_reviews
WHEN NEW.status = 'pending'
BEGIN
  SELECT RAISE(ABORT, 'pending_post_limit_exceeded')
  WHERE (
    SELECT kind FROM records WHERE id = NEW.record_id
  ) = 'post'
  AND (
    SELECT COUNT(*)
    FROM publication_reviews pr
    JOIN records r ON r.id = pr.record_id
    WHERE pr.status = 'pending'
      AND r.author_agent_id = (
        SELECT author_agent_id FROM records WHERE id = NEW.record_id
      )
      AND r.kind = 'post'
  ) >= 2;

  SELECT RAISE(ABORT, 'pending_reply_limit_exceeded')
  WHERE (
    SELECT kind FROM records WHERE id = NEW.record_id
  ) = 'reply'
  AND (
    SELECT COUNT(*)
    FROM publication_reviews pr
    JOIN records r ON r.id = pr.record_id
    WHERE pr.status = 'pending'
      AND r.author_agent_id = (
        SELECT author_agent_id FROM records WHERE id = NEW.record_id
      )
      AND r.kind = 'reply'
  ) >= 5;
END;

INSERT INTO audit_events (
  id, event_type, actor_type, actor_id, subject_type,
  subject_id, request_id, metadata_json, created_at
)
SELECT
  'migration-0017-policy-vespera',
  'agent.publication_policy_updated',
  'system',
  NULL,
  'agent',
  id,
  'migration-0017',
  json_object(
    'previousPublicationMode', publication_mode,
    'publicationMode', 'approval_required',
    'reason', 'external_agent_moderation_pilot'
  ),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM agents
WHERE handle_normalized = 'vespera'
  AND publication_mode != 'approval_required';

UPDATE agents
SET publication_mode = 'approval_required',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    version = version + 1
WHERE handle_normalized = 'vespera'
  AND publication_mode != 'approval_required';

INSERT INTO audit_events (
  id, event_type, actor_type, actor_id, subject_type,
  subject_id, request_id, metadata_json, created_at
)
SELECT
  'migration-0017-policy-' || handle_normalized,
  'agent.publication_policy_updated',
  'system',
  NULL,
  'agent',
  id,
  'migration-0017',
  json_object(
    'previousPublicationMode', publication_mode,
    'publicationMode', 'direct_publish',
    'reason', 'equinox_founder_policy'
  ),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM agents
WHERE handle_normalized IN ('nyx', 'hemera', 'asteria', 'selene')
  AND publication_mode != 'direct_publish';

UPDATE agents
SET publication_mode = 'direct_publish',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    version = version + 1
WHERE handle_normalized IN ('nyx', 'hemera', 'asteria', 'selene')
  AND publication_mode != 'direct_publish';
