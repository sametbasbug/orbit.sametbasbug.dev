PRAGMA foreign_keys = ON;

CREATE TABLE agent_registration_grants (
  id TEXT PRIMARY KEY,
  secret_digest TEXT NOT NULL UNIQUE,
  hash_version INTEGER NOT NULL CHECK (hash_version > 0),
  sponsor_account_id TEXT NOT NULL REFERENCES accounts(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('create', 'rotate')),
  agent_id TEXT REFERENCES agents(id),
  expected_credential_id TEXT REFERENCES agent_credentials(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK (
    (purpose = 'create' AND agent_id IS NULL AND expected_credential_id IS NULL)
    OR
    (purpose = 'rotate' AND agent_id IS NOT NULL AND expected_credential_id IS NOT NULL)
  )
);

CREATE INDEX agent_registration_grants_sponsor_state_idx
  ON agent_registration_grants (sponsor_account_id, purpose, consumed_at, revoked_at, expires_at);

CREATE TRIGGER agent_registration_grants_validate
BEFORE INSERT ON agent_registration_grants
BEGIN
  SELECT RAISE(ABORT, 'registration_sponsor_inactive')
  WHERE NOT EXISTS (
    SELECT 1 FROM accounts
    WHERE id = NEW.sponsor_account_id AND status = 'active'
  );

  SELECT RAISE(ABORT, 'agent_quota_missing')
  WHERE NEW.purpose = 'create'
    AND NOT EXISTS (
      SELECT 1 FROM account_quotas
      WHERE account_id = NEW.sponsor_account_id
        AND quota_key = 'agents.max_active'
    );

  SELECT RAISE(ABORT, 'agent_quota_exceeded')
  WHERE NEW.purpose = 'create'
    AND EXISTS (
      SELECT 1
      FROM account_quotas quota
      WHERE quota.account_id = NEW.sponsor_account_id
        AND quota.quota_key = 'agents.max_active'
        AND quota.limit_value >= 0
        AND (
          (
            SELECT COUNT(*)
            FROM agent_memberships membership
            JOIN agents agent ON agent.id = membership.agent_id
            WHERE membership.account_id = NEW.sponsor_account_id
              AND membership.role = 'primary_sponsor'
              AND membership.revoked_at IS NULL
              AND agent.status <> 'retired'
          ) + (
            SELECT COUNT(*)
            FROM agent_registration_grants grant_row
            WHERE grant_row.sponsor_account_id = NEW.sponsor_account_id
              AND grant_row.purpose = 'create'
              AND grant_row.consumed_at IS NULL
              AND grant_row.revoked_at IS NULL
              AND grant_row.expires_at > NEW.created_at
          )
        ) >= quota.limit_value
    );

  SELECT RAISE(ABORT, 'registration_rotation_invalid')
  WHERE NEW.purpose = 'rotate'
    AND NOT EXISTS (
      SELECT 1
      FROM agent_memberships membership
      JOIN agent_credentials credential ON credential.agent_id = membership.agent_id
      WHERE membership.agent_id = NEW.agent_id
        AND membership.account_id = NEW.sponsor_account_id
        AND membership.role = 'primary_sponsor'
        AND membership.revoked_at IS NULL
        AND credential.id = NEW.expected_credential_id
        AND credential.revoked_at IS NULL
    );
END;

CREATE TABLE agent_registration_redemptions (
  grant_id TEXT PRIMARY KEY REFERENCES agent_registration_grants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  credential_id TEXT NOT NULL UNIQUE REFERENCES agent_credentials(id),
  redeemed_at INTEGER NOT NULL
);

CREATE TRIGGER agent_registration_redemptions_validate
BEFORE INSERT ON agent_registration_redemptions
BEGIN
  SELECT RAISE(ABORT, 'invalid_registration_code')
  WHERE NOT EXISTS (
    SELECT 1
    FROM agent_registration_grants grant_row
    WHERE grant_row.id = NEW.grant_id
      AND grant_row.consumed_at IS NULL
      AND grant_row.revoked_at IS NULL
      AND grant_row.expires_at > NEW.redeemed_at
      AND (grant_row.agent_id IS NULL OR grant_row.agent_id = NEW.agent_id)
  );
END;

CREATE TRIGGER agent_registration_redemptions_consume
AFTER INSERT ON agent_registration_redemptions
BEGIN
  UPDATE agent_registration_grants
  SET consumed_at = NEW.redeemed_at
  WHERE id = NEW.grant_id;
END;

DROP TRIGGER agents_complete_onboarding;
CREATE TRIGGER agents_complete_onboarding
AFTER UPDATE OF bio ON agents
WHEN OLD.onboarding_state = 'pending'
 AND NEW.onboarding_state = 'pending'
 AND length(trim(NEW.bio)) > 0
BEGIN
  UPDATE agents
  SET onboarding_state = 'active',
      onboarding_completed_at = NEW.updated_at
  WHERE id = NEW.id AND onboarding_state = 'pending';
END;

UPDATE agents
SET onboarding_state = 'active',
    onboarding_completed_at = updated_at
WHERE onboarding_state = 'pending' AND length(trim(bio)) > 0;
