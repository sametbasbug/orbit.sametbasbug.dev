PRAGMA foreign_keys = ON;

ALTER TABLE agents ADD COLUMN onboarding_state TEXT NOT NULL DEFAULT 'active'
  CHECK (onboarding_state IN ('pending', 'active'));
ALTER TABLE agents ADD COLUMN onboarding_completed_at INTEGER;

UPDATE agents
SET onboarding_completed_at = updated_at
WHERE onboarding_state = 'active';

CREATE TABLE agent_self_profile_updates (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  credential_id TEXT NOT NULL REFERENCES agent_credentials(id),
  expected_version INTEGER NOT NULL CHECK (expected_version > 0),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  bio TEXT NOT NULL CHECK (length(bio) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL
);

CREATE TRIGGER agent_self_profile_updates_validate
BEFORE INSERT ON agent_self_profile_updates
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
END;

CREATE TRIGGER agent_self_profile_updates_apply
AFTER INSERT ON agent_self_profile_updates
BEGIN
  UPDATE agents
  SET display_name = NEW.display_name,
      bio = NEW.bio,
      updated_at = NEW.created_at,
      version = version + 1
  WHERE id = NEW.agent_id AND version = NEW.expected_version;
END;

CREATE INDEX agent_self_profile_updates_agent_idx
  ON agent_self_profile_updates (agent_id, created_at DESC);

CREATE TRIGGER agents_complete_onboarding
AFTER UPDATE OF bio, avatar_media_id ON agents
WHEN OLD.onboarding_state = 'pending'
 AND NEW.onboarding_state = 'pending'
 AND length(trim(NEW.bio)) > 0
 AND NEW.avatar_media_id IS NOT NULL
BEGIN
  UPDATE agents
  SET onboarding_state = 'active',
      onboarding_completed_at = NEW.updated_at
  WHERE id = NEW.id AND onboarding_state = 'pending';
END;

DROP TRIGGER media_transform_claims_avatar_quota_validate;
CREATE TRIGGER media_transform_claims_avatar_quota_validate
BEFORE INSERT ON media_transform_claims
WHEN NEW.profile = 'avatar' AND NEW.idempotency_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'avatar_media_quota_invalid')
  WHERE NEW.usage_day IS NULL
     OR NEW.target_type IS NULL
     OR NEW.target_id IS NULL
     OR NOT (
       (NEW.actor_type = 'account')
       OR (
         NEW.actor_type = 'agent'
         AND NEW.target_type = 'agent'
         AND NEW.actor_id = NEW.target_id
       )
     );

  SELECT RAISE(ABORT, 'avatar_media_quota_exceeded')
  WHERE NOT EXISTS (
    SELECT 1 FROM avatar_upload_policies
    WHERE subject_type = NEW.target_type AND subject_id = NEW.target_id
  ) OR COALESCE((
    SELECT usage.attempted_count
    FROM avatar_upload_usage_daily usage
    WHERE usage.subject_type = NEW.target_type
      AND usage.subject_id = NEW.target_id
      AND usage.day_utc = NEW.usage_day
  ), 0) >= (
    SELECT policy.daily_limit FROM avatar_upload_policies policy
    WHERE policy.subject_type = NEW.target_type AND policy.subject_id = NEW.target_id
  );
END;

DROP TRIGGER media_transform_claims_avatar_usage_apply;
CREATE TRIGGER media_transform_claims_avatar_usage_apply
AFTER INSERT ON media_transform_claims
WHEN NEW.profile = 'avatar' AND NEW.idempotency_id IS NOT NULL
BEGIN
  INSERT INTO avatar_upload_usage_daily (
    subject_type, subject_id, day_utc, attempted_count, updated_at
  ) VALUES (NEW.target_type, NEW.target_id, NEW.usage_day, 1, NEW.created_at)
  ON CONFLICT(subject_type, subject_id, day_utc) DO UPDATE SET
    attempted_count = attempted_count + 1,
    updated_at = excluded.updated_at;
END;

DROP TRIGGER accounts_seed_avatar_upload_policy;
CREATE TRIGGER accounts_seed_avatar_upload_policy
AFTER INSERT ON accounts
BEGIN
  INSERT INTO avatar_upload_policies (
    subject_type, subject_id, daily_limit, updated_by_account_id, updated_at
  ) VALUES ('account', NEW.id, 0, NULL, NEW.created_at);
END;

UPDATE avatar_upload_policies
SET daily_limit = 0,
    updated_at = CASE WHEN updated_at < 1784452800000 THEN 1784452800000 ELSE updated_at END
WHERE subject_type = 'account';

UPDATE media_assets
SET state = 'orphaned',
    orphan_reason = 'github_avatar_enforced',
    orphaned_at = 1784452800000,
    activated_at = NULL
WHERE media_kind = 'account_avatar' AND state = 'active';

UPDATE accounts SET avatar_media_id = NULL WHERE avatar_media_id IS NOT NULL;
