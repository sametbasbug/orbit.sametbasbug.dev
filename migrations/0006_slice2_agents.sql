PRAGMA foreign_keys = ON;

ALTER TABLE agents ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TRIGGER agent_memberships_enforce_primary_sponsor_quota
BEFORE INSERT ON agent_memberships
WHEN NEW.role = 'primary_sponsor' AND NEW.revoked_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'agent_quota_missing')
  WHERE NOT EXISTS (
    SELECT 1
    FROM account_quotas
    WHERE account_id = NEW.account_id
      AND quota_key = 'agents.max_active'
  );

  SELECT RAISE(ABORT, 'agent_quota_exceeded')
  WHERE EXISTS (
    SELECT 1
    FROM account_quotas q
    WHERE q.account_id = NEW.account_id
      AND q.quota_key = 'agents.max_active'
      AND q.limit_value >= 0
      AND (
        SELECT COUNT(*)
        FROM agent_memberships am
        JOIN agents a ON a.id = am.agent_id
        WHERE am.account_id = NEW.account_id
          AND am.role = 'primary_sponsor'
          AND am.revoked_at IS NULL
          AND a.status <> 'retired'
      ) >= q.limit_value
  );
END;

CREATE TABLE agent_credential_revocations (
  credential_id TEXT PRIMARY KEY REFERENCES agent_credentials(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  reason TEXT NOT NULL CHECK (reason IN ('rotated', 'revoked')),
  replacement_credential_id TEXT,
  revoked_at INTEGER NOT NULL
);

CREATE TRIGGER agent_credential_revocations_validate_before_insert
BEFORE INSERT ON agent_credential_revocations
BEGIN
  SELECT RAISE(ABORT, 'credential_not_revocable')
  WHERE NOT EXISTS (
    SELECT 1
    FROM agent_credentials
    WHERE id = NEW.credential_id
      AND agent_id = NEW.agent_id
      AND revoked_at IS NULL
  );

  SELECT RAISE(ABORT, 'credential_rotation_requires_replacement')
  WHERE NEW.reason = 'rotated'
    AND NEW.replacement_credential_id IS NULL;

  SELECT RAISE(ABORT, 'credential_revoke_forbids_replacement')
  WHERE NEW.reason = 'revoked'
    AND NEW.replacement_credential_id IS NOT NULL;
END;

CREATE TRIGGER agent_credential_revocations_mark_after_insert
AFTER INSERT ON agent_credential_revocations
BEGIN
  UPDATE agent_credentials
  SET revoked_at = NEW.revoked_at,
      revoked_reason = NEW.reason
  WHERE id = NEW.credential_id
    AND agent_id = NEW.agent_id;
END;
