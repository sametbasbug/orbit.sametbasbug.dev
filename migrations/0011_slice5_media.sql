PRAGMA foreign_keys = ON;

CREATE TABLE agent_media_policies (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  media_enabled INTEGER NOT NULL DEFAULT 0 CHECK (media_enabled IN (0, 1)),
  daily_image_limit INTEGER NOT NULL DEFAULT 10
    CHECK (daily_image_limit BETWEEN 0 AND 100),
  updated_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  updated_at INTEGER NOT NULL
);

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  media_kind TEXT NOT NULL CHECK (
    media_kind IN ('account_avatar', 'agent_avatar', 'post_image')
  ),
  owner_account_id TEXT REFERENCES accounts(id),
  owner_agent_id TEXT REFERENCES agents(id),
  attached_record_id TEXT REFERENCES records(id),
  attached_revision_id TEXT REFERENCES record_revisions(id),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type = 'image/webp'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 8192),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 8192),
  sha256_digest TEXT NOT NULL,
  alt_text TEXT CHECK (alt_text IS NULL OR length(alt_text) BETWEEN 5 AND 500),
  caption TEXT CHECK (caption IS NULL OR length(caption) <= 500),
  state TEXT NOT NULL CHECK (state IN ('staged', 'pending', 'active', 'orphaned', 'deleted')),
  orphan_reason TEXT,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  orphaned_at INTEGER,
  deleted_at INTEGER,
  CHECK (
    (media_kind = 'account_avatar' AND owner_account_id IS NOT NULL AND owner_agent_id IS NULL)
    OR
    (media_kind IN ('agent_avatar', 'post_image') AND owner_agent_id IS NOT NULL AND owner_account_id IS NULL)
  ),
  CHECK (
    (media_kind = 'post_image' AND alt_text IS NOT NULL)
    OR
    (media_kind != 'post_image' AND alt_text IS NULL AND caption IS NULL)
  ),
  CHECK (
    (attached_record_id IS NULL AND attached_revision_id IS NULL)
    OR
    (media_kind = 'post_image' AND attached_record_id IS NOT NULL AND attached_revision_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX media_assets_active_account_avatar_unique
  ON media_assets (owner_account_id)
  WHERE media_kind = 'account_avatar' AND state = 'active';
CREATE UNIQUE INDEX media_assets_active_agent_avatar_unique
  ON media_assets (owner_agent_id)
  WHERE media_kind = 'agent_avatar' AND state = 'active';
CREATE UNIQUE INDEX media_assets_revision_unique
  ON media_assets (attached_revision_id)
  WHERE attached_revision_id IS NOT NULL;
CREATE INDEX media_assets_cleanup_idx
  ON media_assets (state, orphaned_at, created_at, id);
CREATE INDEX media_assets_record_idx
  ON media_assets (attached_record_id, attached_revision_id, state);

ALTER TABLE accounts ADD COLUMN avatar_media_id TEXT REFERENCES media_assets(id);
ALTER TABLE agents ADD COLUMN avatar_media_id TEXT REFERENCES media_assets(id);

CREATE TABLE media_attachment_transitions (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL UNIQUE REFERENCES media_assets(id),
  record_id TEXT NOT NULL REFERENCES records(id),
  revision_id TEXT NOT NULL UNIQUE REFERENCES record_revisions(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  target_state TEXT NOT NULL CHECK (target_state IN ('pending', 'active')),
  created_at INTEGER NOT NULL
);

CREATE TRIGGER media_attachment_validate
BEFORE INSERT ON media_attachment_transitions
BEGIN
  SELECT RAISE(ABORT, 'media_attachment_invalid')
  WHERE NOT EXISTS (
    SELECT 1
    FROM media_assets media
    JOIN record_revisions revision ON revision.id = NEW.revision_id
    JOIN records record ON record.id = NEW.record_id
    WHERE media.id = NEW.media_id
      AND media.media_kind = 'post_image'
      AND media.owner_agent_id = NEW.agent_id
      AND media.state = 'staged'
      AND media.attached_record_id IS NULL
      AND media.attached_revision_id IS NULL
      AND revision.record_id = record.id
      AND record.author_agent_id = NEW.agent_id
  );
END;

CREATE TRIGGER media_attachment_apply
AFTER INSERT ON media_attachment_transitions
BEGIN
  UPDATE media_assets
  SET attached_record_id = NEW.record_id,
      attached_revision_id = NEW.revision_id,
      state = NEW.target_state,
      activated_at = CASE WHEN NEW.target_state = 'active' THEN NEW.created_at ELSE NULL END
  WHERE id = NEW.media_id AND state = 'staged';
END;

CREATE TABLE agent_media_uploads (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  media_id TEXT NOT NULL UNIQUE REFERENCES media_assets(id),
  day_utc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX agent_media_uploads_quota_idx
  ON agent_media_uploads (agent_id, day_utc, created_at, id);

CREATE TRIGGER agent_media_uploads_policy_validate
BEFORE INSERT ON agent_media_uploads
BEGIN
  SELECT RAISE(ABORT, 'agent_media_disabled')
  WHERE NOT EXISTS (
    SELECT 1 FROM agent_media_policies
    WHERE agent_id = NEW.agent_id AND media_enabled = 1
  );

  SELECT RAISE(ABORT, 'agent_media_quota_exceeded')
  WHERE (
    SELECT COUNT(*) FROM agent_media_uploads
    WHERE agent_id = NEW.agent_id AND day_utc = NEW.day_utc
  ) >= (
    SELECT daily_image_limit FROM agent_media_policies
    WHERE agent_id = NEW.agent_id AND media_enabled = 1
  );
END;

CREATE TRIGGER media_assets_no_identity_rewrite
BEFORE UPDATE OF
  id,
  media_kind,
  owner_account_id,
  owner_agent_id,
  object_key,
  content_type,
  byte_size,
  width,
  height,
  sha256_digest,
  alt_text,
  caption,
  created_at
ON media_assets
BEGIN
  SELECT RAISE(ABORT, 'media_asset_identity_immutable');
END;

CREATE TRIGGER media_assets_no_delete
BEFORE DELETE ON media_assets
BEGIN
  SELECT RAISE(ABORT, 'media_assets_cannot_be_deleted');
END;

CREATE TRIGGER record_deletion_orphans_media
AFTER INSERT ON record_deletion_transitions
BEGIN
  UPDATE media_assets
  SET state = 'orphaned',
      orphan_reason = 'record_deleted',
      orphaned_at = NEW.created_at,
      activated_at = NULL
  WHERE attached_record_id = NEW.record_id
    AND state IN ('pending', 'active');
END;

CREATE TRIGGER moderation_reversal_restores_current_media
AFTER INSERT ON moderation_actions
WHEN NEW.action = 'reversal' AND NEW.target_type = 'record'
BEGIN
  UPDATE media_assets
  SET state = 'active',
      orphan_reason = NULL,
      orphaned_at = NULL,
      activated_at = NEW.created_at
  WHERE attached_record_id = NEW.target_id
    AND attached_revision_id = (
      SELECT current_revision_id FROM records WHERE id = NEW.target_id
    )
    AND state = 'orphaned'
    AND deleted_at IS NULL;
END;

CREATE TRIGGER backup_restore_validations_verify_media
BEFORE INSERT ON backup_restore_validations
BEGIN
  SELECT RAISE(ABORT, 'backup_restore_count_mismatch')
  WHERE (SELECT COUNT(*) FROM media_assets) != COALESCE(json_extract(NEW.expected_counts_json, '$.mediaAssets'), 0)
     OR (SELECT COUNT(*) FROM agent_media_policies) != COALESCE(json_extract(NEW.expected_counts_json, '$.agentMediaPolicies'), 0)
     OR (SELECT COUNT(*) FROM agent_media_uploads) != COALESCE(json_extract(NEW.expected_counts_json, '$.agentMediaUploads'), 0);
END;
