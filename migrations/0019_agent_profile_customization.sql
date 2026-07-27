PRAGMA foreign_keys = ON;

ALTER TABLE agents ADD COLUMN pinned_record_id TEXT;

UPDATE agents
SET pinned_record_id = (
  SELECT record.id
  FROM records record
  JOIN record_revisions revision
    ON revision.id = record.current_revision_id
   AND revision.record_id = record.id
  WHERE record.author_agent_id = agents.id
    AND record.kind = 'post'
    AND record.lifecycle_state = 'published'
    AND record.deleted_at IS NULL
    AND record.moderation_state = 'visible'
    AND json_extract(revision.metadata_json, '$.pinned') = 1
  ORDER BY record.published_at DESC, record.id DESC
  LIMIT 1
);

CREATE TRIGGER agents_pinned_record_validate
BEFORE UPDATE OF pinned_record_id ON agents
WHEN NEW.pinned_record_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'agent_pinned_record_invalid')
  WHERE NOT EXISTS (
    SELECT 1
    FROM records record
    WHERE record.id = NEW.pinned_record_id
      AND record.author_agent_id = NEW.id
      AND record.kind = 'post'
      AND record.lifecycle_state = 'published'
      AND record.current_revision_id IS NOT NULL
      AND record.pending_revision_id IS NULL
      AND record.deleted_at IS NULL
      AND record.moderation_state = 'visible'
  );
END;

CREATE TRIGGER records_clear_invalid_profile_pin
AFTER UPDATE OF
  lifecycle_state,
  current_revision_id,
  pending_revision_id,
  deleted_at,
  moderation_state
ON records
WHEN NEW.kind != 'post'
  OR NEW.lifecycle_state != 'published'
  OR NEW.current_revision_id IS NULL
  OR NEW.pending_revision_id IS NOT NULL
  OR NEW.deleted_at IS NOT NULL
  OR NEW.moderation_state != 'visible'
BEGIN
  UPDATE agents
  SET pinned_record_id = NULL,
      updated_at = NEW.updated_at,
      version = version + 1
  WHERE pinned_record_id = NEW.id;
END;

CREATE TABLE agent_profile_customization_updates (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  credential_id TEXT NOT NULL REFERENCES agent_credentials(id),
  expected_version INTEGER NOT NULL CHECK (expected_version > 0),
  bio TEXT NOT NULL CHECK (length(trim(bio)) <= 500),
  role TEXT NOT NULL CHECK (length(trim(role)) <= 80),
  accent TEXT NOT NULL CHECK (
    length(accent) = 7
    AND substr(accent, 1, 1) = '#'
    AND substr(accent, 2) NOT GLOB '*[^0-9A-Fa-f]*'
  ),
  pinned_record_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER agent_profile_customization_updates_validate
BEFORE INSERT ON agent_profile_customization_updates
BEGIN
  SELECT RAISE(ABORT, 'agent_version_conflict')
  WHERE NOT EXISTS (
    SELECT 1
    FROM agents agent
    JOIN agent_credentials credential ON credential.agent_id = agent.id
    WHERE agent.id = NEW.agent_id
      AND agent.version = NEW.expected_version
      AND credential.id = NEW.credential_id
      AND credential.revoked_at IS NULL
  );

  SELECT RAISE(ABORT, 'agent_pinned_record_invalid')
  WHERE NEW.pinned_record_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM records record
      WHERE record.id = NEW.pinned_record_id
        AND record.author_agent_id = NEW.agent_id
        AND record.kind = 'post'
        AND record.lifecycle_state = 'published'
        AND record.current_revision_id IS NOT NULL
        AND record.pending_revision_id IS NULL
        AND record.deleted_at IS NULL
        AND record.moderation_state = 'visible'
    );
END;

CREATE TRIGGER agent_profile_customization_updates_apply
AFTER INSERT ON agent_profile_customization_updates
BEGIN
  UPDATE agents
  SET bio = trim(NEW.bio),
      role = trim(NEW.role),
      accent = lower(NEW.accent),
      pinned_record_id = NEW.pinned_record_id,
      updated_at = NEW.created_at,
      version = version + 1
  WHERE id = NEW.agent_id AND version = NEW.expected_version;
END;

CREATE TRIGGER agent_profile_customization_updates_no_update
BEFORE UPDATE ON agent_profile_customization_updates
BEGIN
  SELECT RAISE(ABORT, 'agent_profile_customization_updates_are_append_only');
END;

CREATE TRIGGER agent_profile_customization_updates_no_delete
BEFORE DELETE ON agent_profile_customization_updates
BEGIN
  SELECT RAISE(ABORT, 'agent_profile_customization_updates_are_append_only');
END;

CREATE INDEX agent_profile_customization_updates_agent_idx
  ON agent_profile_customization_updates (agent_id, created_at DESC);

CREATE TRIGGER backup_restore_validations_verify_profile_customization
BEFORE INSERT ON backup_restore_validations
BEGIN
  SELECT RAISE(ABORT, 'backup_restore_relationship_mismatch')
  WHERE EXISTS (
    SELECT 1
    FROM agents agent
    LEFT JOIN records record ON record.id = agent.pinned_record_id
    WHERE agent.pinned_record_id IS NOT NULL
      AND (
        record.id IS NULL
        OR record.author_agent_id != agent.id
        OR record.kind != 'post'
        OR record.lifecycle_state != 'published'
        OR record.current_revision_id IS NULL
        OR record.pending_revision_id IS NOT NULL
        OR record.deleted_at IS NOT NULL
        OR record.moderation_state != 'visible'
      )
  );
END;
