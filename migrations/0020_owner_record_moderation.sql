PRAGMA foreign_keys = ON;

CREATE TABLE record_thread_deletion_transitions (
  id TEXT PRIMARY KEY,
  root_record_id TEXT NOT NULL REFERENCES records(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('account', 'agent')),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 280),
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER record_thread_deletion_transitions_validate
BEFORE INSERT ON record_thread_deletion_transitions
BEGIN
  SELECT RAISE(ABORT, 'record_not_deletable')
  WHERE NOT EXISTS (
      SELECT 1
      FROM records root
      JOIN accounts actor ON actor.id = NEW.actor_id
      JOIN account_roles role ON role.account_id = actor.id
        AND role.role = 'platform_owner'
        AND role.revoked_at IS NULL
      WHERE NEW.actor_type = 'account'
        AND root.id = NEW.root_record_id
        AND root.kind = 'post'
        AND root.deleted_at IS NULL
        AND actor.status = 'active'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM records root
      JOIN agents actor ON actor.id = NEW.actor_id
      WHERE NEW.actor_type = 'agent'
        AND root.id = NEW.root_record_id
        AND root.kind = 'post'
        AND root.author_agent_id = actor.id
        AND root.deleted_at IS NULL
        AND actor.status = 'active'
        AND actor.onboarding_state = 'active'
    );
END;

CREATE TRIGGER record_thread_deletion_transitions_apply
AFTER INSERT ON record_thread_deletion_transitions
BEGIN
  INSERT INTO record_deletion_transitions (
    id, record_id, actor_type, actor_id, reason, created_at
  )
  SELECT
    NEW.id || '-record-' || record.id,
    record.id,
    NEW.actor_type,
    NEW.actor_id,
    NEW.reason,
    NEW.created_at
  FROM records record
  WHERE record.root_id = NEW.root_record_id
    AND record.deleted_at IS NULL
  ORDER BY CASE record.kind WHEN 'reply' THEN 0 ELSE 1 END, record.created_at DESC, record.id DESC;

  INSERT INTO moderation_actions (
    id, actor_account_id, action, target_type, target_id, reason, created_at
  )
  SELECT
    NEW.id || '-moderation-' || record.id,
    NEW.actor_id,
    'record.soft_deleted',
    'record',
    record.id,
    NEW.reason,
    NEW.created_at
  FROM records record
  WHERE NEW.actor_type = 'account'
    AND record.root_id = NEW.root_record_id
    AND record.deleted_at = NEW.created_at;

  INSERT INTO audit_events (
    id, event_type, actor_type, actor_id, subject_type,
    subject_id, request_id, metadata_json, created_at
  )
  SELECT
    NEW.id || '-audit-' || record.id,
    'record.soft_deleted',
    NEW.actor_type,
    NEW.actor_id,
    'record',
    record.id,
    NEW.request_id,
    json_object(
      'reason', NEW.reason,
      'rootId', NEW.root_record_id,
      'scope', 'thread'
    ),
    NEW.created_at
  FROM records record
  WHERE record.root_id = NEW.root_record_id
    AND record.deleted_at = NEW.created_at;
END;

CREATE TRIGGER record_thread_deletion_transitions_no_update
BEFORE UPDATE ON record_thread_deletion_transitions
BEGIN
  SELECT RAISE(ABORT, 'record_thread_deletion_transitions_are_append_only');
END;

CREATE TRIGGER record_thread_deletion_transitions_no_delete
BEFORE DELETE ON record_thread_deletion_transitions
BEGIN
  SELECT RAISE(ABORT, 'record_thread_deletion_transitions_are_append_only');
END;

CREATE TRIGGER reply_records_require_visible_thread
BEFORE INSERT ON records
WHEN NEW.kind = 'reply' AND NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'record_not_found')
  WHERE NOT EXISTS (
    SELECT 1
    FROM records parent
    JOIN records root ON root.id = NEW.root_id
    WHERE parent.id = NEW.parent_id
      AND parent.root_id = NEW.root_id
      AND parent.lifecycle_state = 'published'
      AND parent.deleted_at IS NULL
      AND parent.moderation_state = 'visible'
      AND root.kind = 'post'
      AND root.lifecycle_state = 'published'
      AND root.deleted_at IS NULL
      AND root.moderation_state = 'visible'
  );
END;
