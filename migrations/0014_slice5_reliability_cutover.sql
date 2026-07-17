PRAGMA foreign_keys = ON;

ALTER TABLE idempotency_keys ADD COLUMN state TEXT NOT NULL DEFAULT 'completed'
  CHECK (state IN ('in_progress', 'completed'));
ALTER TABLE idempotency_keys ADD COLUMN completed_at INTEGER;

UPDATE idempotency_keys
SET completed_at = created_at
WHERE state = 'completed' AND completed_at IS NULL;

CREATE TRIGGER idempotency_keys_identity_immutable
BEFORE UPDATE OF
  id, principal_type, principal_id, key_digest, operation,
  request_digest, created_at, expires_at
ON idempotency_keys
BEGIN
  SELECT RAISE(ABORT, 'idempotency_identity_immutable');
END;

CREATE TRIGGER idempotency_keys_completion_guard
BEFORE UPDATE OF state, response_status, response_json, completed_at
ON idempotency_keys
BEGIN
  SELECT RAISE(ABORT, 'idempotency_completion_invalid')
  WHERE OLD.state != 'in_progress'
     OR NEW.state != 'completed'
     OR NEW.response_status < 100
     OR NEW.response_status > 599
     OR NEW.completed_at IS NULL
     OR json_valid(NEW.response_json) != 1;
END;

CREATE TABLE avatar_upload_policies (
  subject_type TEXT NOT NULL CHECK (subject_type IN ('account', 'agent')),
  subject_id TEXT NOT NULL,
  daily_limit INTEGER NOT NULL DEFAULT 5 CHECK (daily_limit BETWEEN 0 AND 50),
  updated_by_account_id TEXT REFERENCES accounts(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subject_type, subject_id)
);

INSERT INTO avatar_upload_policies (
  subject_type, subject_id, daily_limit, updated_by_account_id, updated_at
)
SELECT 'account', id, 5, NULL, created_at FROM accounts;

INSERT INTO avatar_upload_policies (
  subject_type, subject_id, daily_limit, updated_by_account_id, updated_at
)
SELECT 'agent', id, 5, NULL, created_at FROM agents;

CREATE TRIGGER accounts_seed_avatar_upload_policy
AFTER INSERT ON accounts
BEGIN
  INSERT INTO avatar_upload_policies (
    subject_type, subject_id, daily_limit, updated_by_account_id, updated_at
  ) VALUES ('account', NEW.id, 5, NULL, NEW.created_at);
END;

CREATE TRIGGER agents_seed_avatar_upload_policy
AFTER INSERT ON agents
BEGIN
  INSERT INTO avatar_upload_policies (
    subject_type, subject_id, daily_limit, updated_by_account_id, updated_at
  ) VALUES ('agent', NEW.id, 5, NULL, NEW.created_at);
END;

CREATE TRIGGER avatar_upload_policies_target_validate
BEFORE INSERT ON avatar_upload_policies
BEGIN
  SELECT RAISE(ABORT, 'avatar_policy_target_missing')
  WHERE (NEW.subject_type = 'account' AND NOT EXISTS (
    SELECT 1 FROM accounts WHERE id = NEW.subject_id
  )) OR (NEW.subject_type = 'agent' AND NOT EXISTS (
    SELECT 1 FROM agents WHERE id = NEW.subject_id
  ));
END;

CREATE TRIGGER avatar_upload_policies_no_delete
BEFORE DELETE ON avatar_upload_policies
BEGIN
  SELECT RAISE(ABORT, 'avatar_upload_policy_cannot_be_deleted');
END;

CREATE TABLE avatar_upload_usage_daily (
  subject_type TEXT NOT NULL CHECK (subject_type IN ('account', 'agent')),
  subject_id TEXT NOT NULL,
  day_utc TEXT NOT NULL CHECK (length(day_utc) = 10),
  attempted_count INTEGER NOT NULL DEFAULT 0 CHECK (attempted_count >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subject_type, subject_id, day_utc)
);

ALTER TABLE media_transform_claims ADD COLUMN usage_day TEXT
  CHECK (usage_day IS NULL OR length(usage_day) = 10);
ALTER TABLE media_transform_claims ADD COLUMN target_type TEXT
  CHECK (target_type IS NULL OR target_type IN ('account', 'agent'));
ALTER TABLE media_transform_claims ADD COLUMN target_id TEXT;
ALTER TABLE media_transform_claims ADD COLUMN idempotency_id TEXT
  REFERENCES idempotency_keys(id);

CREATE UNIQUE INDEX media_transform_claims_idempotency_unique
  ON media_transform_claims (idempotency_id)
  WHERE idempotency_id IS NOT NULL;

CREATE TRIGGER media_transform_claims_idempotency_validate
BEFORE INSERT ON media_transform_claims
WHEN NEW.idempotency_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'media_idempotency_not_reserved')
  WHERE NOT EXISTS (
    SELECT 1 FROM idempotency_keys key
    WHERE key.id = NEW.idempotency_id
      AND key.state = 'in_progress'
      AND key.principal_type = NEW.actor_type
      AND key.principal_id = NEW.actor_id
  );
END;

CREATE TRIGGER media_transform_claims_avatar_quota_validate
BEFORE INSERT ON media_transform_claims
WHEN NEW.profile = 'avatar' AND NEW.idempotency_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'avatar_media_quota_invalid')
  WHERE NEW.actor_type != 'account'
     OR NEW.usage_day IS NULL
     OR NEW.target_type IS NULL
     OR NEW.target_id IS NULL;

  SELECT RAISE(ABORT, 'avatar_media_quota_exceeded')
  WHERE NOT EXISTS (
    SELECT 1 FROM avatar_upload_policies
    WHERE subject_type = 'account' AND subject_id = NEW.actor_id
  ) OR COALESCE((
    SELECT usage.attempted_count
    FROM avatar_upload_usage_daily usage
    WHERE usage.subject_type = 'account'
      AND usage.subject_id = NEW.actor_id
      AND usage.day_utc = NEW.usage_day
  ), 0) >= (
    SELECT policy.daily_limit FROM avatar_upload_policies policy
    WHERE policy.subject_type = 'account' AND policy.subject_id = NEW.actor_id
  );

  SELECT RAISE(ABORT, 'avatar_media_quota_exceeded')
  WHERE NEW.target_type = 'agent' AND (
    NOT EXISTS (
      SELECT 1 FROM avatar_upload_policies
      WHERE subject_type = 'agent' AND subject_id = NEW.target_id
    ) OR COALESCE((
      SELECT usage.attempted_count
      FROM avatar_upload_usage_daily usage
      WHERE usage.subject_type = 'agent'
        AND usage.subject_id = NEW.target_id
        AND usage.day_utc = NEW.usage_day
    ), 0) >= (
      SELECT policy.daily_limit FROM avatar_upload_policies policy
      WHERE policy.subject_type = 'agent' AND policy.subject_id = NEW.target_id
    )
  );
END;

CREATE TRIGGER media_transform_claims_post_quota_validate
BEFORE INSERT ON media_transform_claims
WHEN NEW.profile = 'post' AND NEW.idempotency_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'agent_media_disabled')
  WHERE NEW.actor_type != 'agent'
     OR NEW.usage_day IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM agent_media_policies policy
       WHERE policy.agent_id = NEW.actor_id AND policy.media_enabled = 1
     );

  SELECT RAISE(ABORT, 'agent_media_quota_exceeded')
  WHERE (
    SELECT COUNT(*) FROM media_transform_claims claim
    WHERE claim.profile = 'post'
      AND claim.actor_type = 'agent'
      AND claim.actor_id = NEW.actor_id
      AND claim.usage_day = NEW.usage_day
  ) >= (
    SELECT policy.daily_image_limit FROM agent_media_policies policy
    WHERE policy.agent_id = NEW.actor_id
  );
END;

CREATE TRIGGER media_transform_claims_avatar_usage_apply
AFTER INSERT ON media_transform_claims
WHEN NEW.profile = 'avatar' AND NEW.idempotency_id IS NOT NULL
BEGIN
  INSERT INTO avatar_upload_usage_daily (
    subject_type, subject_id, day_utc, attempted_count, updated_at
  ) VALUES ('account', NEW.actor_id, NEW.usage_day, 1, NEW.created_at)
  ON CONFLICT(subject_type, subject_id, day_utc) DO UPDATE SET
    attempted_count = attempted_count + 1,
    updated_at = excluded.updated_at;

  INSERT INTO avatar_upload_usage_daily (
    subject_type, subject_id, day_utc, attempted_count, updated_at
  )
  SELECT 'agent', NEW.target_id, NEW.usage_day, 1, NEW.created_at
  WHERE NEW.target_type = 'agent'
  ON CONFLICT(subject_type, subject_id, day_utc) DO UPDATE SET
    attempted_count = attempted_count + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER backup_restore_validations_verify_avatar_usage
BEFORE INSERT ON backup_restore_validations
BEGIN
  SELECT RAISE(ABORT, 'backup_restore_count_mismatch')
  WHERE (SELECT COUNT(*) FROM avatar_upload_policies) != COALESCE(json_extract(NEW.expected_counts_json, '$.avatarUploadPolicies'), 0)
     OR (SELECT COUNT(*) FROM avatar_upload_usage_daily) != COALESCE(json_extract(NEW.expected_counts_json, '$.avatarUploadUsageDaily'), 0);
END;
