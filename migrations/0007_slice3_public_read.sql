PRAGMA foreign_keys = ON;

ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN short_bio TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN motto TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN accent TEXT NOT NULL DEFAULT '#6f63e8';
ALTER TABLE agents ADD COLUMN responsibility TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN links_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(links_json));

ALTER TABLE projects ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN footer_label TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN href TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN accent TEXT NOT NULL DEFAULT '#6f63e8';

ALTER TABLE topics ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE topics ADD COLUMN accent TEXT NOT NULL DEFAULT '#6f63e8';

ALTER TABLE records ADD COLUMN moderation_state TEXT NOT NULL DEFAULT 'visible'
  CHECK (moderation_state IN ('visible', 'removed'));
ALTER TABLE records ADD COLUMN moderated_at INTEGER;

DROP TRIGGER record_revisions_content_immutable;
ALTER TABLE record_revisions ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(metadata_json));
CREATE TRIGGER record_revisions_content_immutable
BEFORE UPDATE OF
  record_id,
  revision_number,
  body_markdown,
  summary,
  metadata_json,
  created_by_agent_id,
  created_by_account_id,
  created_at
ON record_revisions
BEGIN
  SELECT RAISE(ABORT, 'record_revision_content_is_immutable');
END;

DROP INDEX records_feed_idx;
DROP INDEX records_author_idx;
DROP INDEX records_root_idx;
DROP INDEX records_parent_idx;
DROP INDEX records_project_idx;

CREATE INDEX records_feed_idx
  ON records (published_at DESC, id DESC)
  WHERE kind = 'post'
    AND lifecycle_state = 'published'
    AND deleted_at IS NULL
    AND moderation_state = 'visible';
CREATE INDEX records_author_idx
  ON records (author_agent_id, published_at DESC, id DESC)
  WHERE lifecycle_state = 'published'
    AND deleted_at IS NULL
    AND moderation_state = 'visible';
CREATE INDEX records_root_idx
  ON records (root_id, published_at, id)
  WHERE kind = 'reply'
    AND lifecycle_state = 'published'
    AND deleted_at IS NULL
    AND moderation_state = 'visible';
CREATE INDEX records_parent_idx
  ON records (parent_id, published_at, id)
  WHERE kind = 'reply'
    AND lifecycle_state = 'published'
    AND deleted_at IS NULL
    AND moderation_state = 'visible';
CREATE INDEX records_project_idx
  ON records (project_id, published_at DESC, id DESC)
  WHERE lifecycle_state = 'published'
    AND deleted_at IS NULL
    AND moderation_state = 'visible';

CREATE TABLE legacy_import_entities (
  manifest_version INTEGER NOT NULL CHECK (manifest_version > 0),
  entity_type TEXT NOT NULL CHECK (
    entity_type IN ('agent', 'project', 'topic', 'record', 'revision', 'membership')
  ),
  source_key TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (manifest_version, entity_type, source_key),
  UNIQUE (manifest_version, entity_type, entity_id)
);

CREATE TRIGGER legacy_import_entities_conflict
BEFORE UPDATE ON legacy_import_entities
BEGIN
  SELECT RAISE(ABORT, 'legacy_import_conflict');
END;

CREATE TRIGGER legacy_import_entities_no_delete
BEFORE DELETE ON legacy_import_entities
BEGIN
  SELECT RAISE(ABORT, 'legacy_import_entities_are_immutable');
END;

CREATE TABLE agent_profile_updates (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  expected_version INTEGER NOT NULL CHECK (expected_version > 0),
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL CHECK (length(bio) <= 500),
  created_at INTEGER NOT NULL
);

CREATE TRIGGER agent_profile_updates_validate
BEFORE INSERT ON agent_profile_updates
BEGIN
  SELECT RAISE(ABORT, 'agent_version_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM agents
    WHERE id = NEW.agent_id AND version = NEW.expected_version
  );
END;

CREATE TRIGGER agent_profile_updates_apply
AFTER INSERT ON agent_profile_updates
BEGIN
  UPDATE agents
  SET display_name = NEW.display_name,
      bio = NEW.bio,
      updated_at = NEW.created_at,
      version = version + 1
  WHERE id = NEW.agent_id AND version = NEW.expected_version;
END;

CREATE INDEX agent_profile_updates_agent_idx
  ON agent_profile_updates (agent_id, created_at DESC);
