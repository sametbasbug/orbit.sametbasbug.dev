PRAGMA foreign_keys = ON;

CREATE TABLE mcp_authorization_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  scopes TEXT NOT NULL CHECK (scopes = 'feed:read'),
  oauth_client_id TEXT NOT NULL CHECK (
    length(trim(oauth_client_id)) BETWEEN 1 AND 255
  ),
  oauth_client_label TEXT NOT NULL CHECK (
    length(trim(oauth_client_label)) BETWEEN 1 AND 120
  ),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT,
  CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR
    (
      revoked_at IS NOT NULL
      AND revoked_reason IS NOT NULL
      AND length(trim(revoked_reason)) BETWEEN 1 AND 120
    )
  )
);

CREATE INDEX mcp_authorization_grants_account_state_idx
  ON mcp_authorization_grants (account_id, revoked_at, expires_at, created_at DESC);

CREATE INDEX mcp_authorization_grants_agent_state_idx
  ON mcp_authorization_grants (agent_id, revoked_at, expires_at, created_at DESC);

CREATE INDEX mcp_authorization_grants_client_idx
  ON mcp_authorization_grants (oauth_client_id, created_at DESC);

CREATE TRIGGER mcp_authorization_grants_validate
BEFORE INSERT ON mcp_authorization_grants
BEGIN
  SELECT RAISE(ABORT, 'mcp_authorization_account_inactive')
  WHERE NOT EXISTS (
    SELECT 1
    FROM accounts account
    WHERE account.id = NEW.account_id
      AND account.status = 'active'
  );

  SELECT RAISE(ABORT, 'mcp_authorization_agent_not_manageable')
  WHERE NOT EXISTS (
    SELECT 1
    FROM agents agent
    WHERE agent.id = NEW.agent_id
      AND (
        EXISTS (
          SELECT 1
          FROM agent_memberships membership
          WHERE membership.agent_id = agent.id
            AND membership.account_id = NEW.account_id
            AND membership.role = 'primary_sponsor'
            AND membership.revoked_at IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM account_roles role
          WHERE role.account_id = NEW.account_id
            AND role.role = 'platform_owner'
            AND role.revoked_at IS NULL
        )
      )
  );
END;

CREATE TRIGGER mcp_authorization_grants_identity_immutable
BEFORE UPDATE OF account_id, agent_id, scopes, oauth_client_id, oauth_client_label, created_at, expires_at
ON mcp_authorization_grants
BEGIN
  SELECT RAISE(ABORT, 'mcp_authorization_grant_identity_immutable');
END;

CREATE TABLE mcp_delegation_codes (
  id TEXT PRIMARY KEY,
  secret_digest TEXT NOT NULL UNIQUE,
  hash_version INTEGER NOT NULL CHECK (hash_version > 0),
  grant_id TEXT NOT NULL REFERENCES mcp_authorization_grants(id),
  authorization_request_id TEXT NOT NULL UNIQUE CHECK (
    length(trim(authorization_request_id)) BETWEEN 1 AND 200
  ),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + 600000),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX mcp_delegation_codes_grant_state_idx
  ON mcp_delegation_codes (grant_id, consumed_at, expires_at);

CREATE TRIGGER mcp_delegation_codes_validate
BEFORE INSERT ON mcp_delegation_codes
BEGIN
  SELECT RAISE(ABORT, 'mcp_authorization_grant_unavailable')
  WHERE NOT EXISTS (
    SELECT 1
    FROM mcp_authorization_grants grant_row
    WHERE grant_row.id = NEW.grant_id
      AND grant_row.revoked_at IS NULL
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at > NEW.created_at)
  );
END;

CREATE TRIGGER mcp_delegation_codes_identity_immutable
BEFORE UPDATE OF secret_digest, hash_version, grant_id, authorization_request_id, created_at, expires_at
ON mcp_delegation_codes
BEGIN
  SELECT RAISE(ABORT, 'mcp_delegation_code_identity_immutable');
END;

CREATE TABLE mcp_delegation_redemptions (
  code_id TEXT PRIMARY KEY REFERENCES mcp_delegation_codes(id),
  grant_id TEXT NOT NULL REFERENCES mcp_authorization_grants(id),
  authorization_request_id TEXT NOT NULL UNIQUE,
  redeemed_at INTEGER NOT NULL
);

CREATE TRIGGER mcp_delegation_redemptions_validate
BEFORE INSERT ON mcp_delegation_redemptions
BEGIN
  SELECT RAISE(ABORT, 'invalid_mcp_delegation_code')
  WHERE NOT EXISTS (
    SELECT 1
    FROM mcp_delegation_codes code
    JOIN mcp_authorization_grants grant_row
      ON grant_row.id = code.grant_id
    WHERE code.id = NEW.code_id
      AND code.grant_id = NEW.grant_id
      AND code.authorization_request_id = NEW.authorization_request_id
      AND code.consumed_at IS NULL
      AND code.expires_at > NEW.redeemed_at
      AND grant_row.revoked_at IS NULL
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at > NEW.redeemed_at)
  );
END;

CREATE TRIGGER mcp_delegation_redemptions_consume
AFTER INSERT ON mcp_delegation_redemptions
BEGIN
  UPDATE mcp_delegation_codes
  SET consumed_at = NEW.redeemed_at
  WHERE id = NEW.code_id;
END;

CREATE TRIGGER mcp_delegation_redemptions_no_update
BEFORE UPDATE ON mcp_delegation_redemptions
BEGIN
  SELECT RAISE(ABORT, 'mcp_delegation_redemptions_are_append_only');
END;

CREATE TRIGGER mcp_delegation_redemptions_no_delete
BEFORE DELETE ON mcp_delegation_redemptions
BEGIN
  SELECT RAISE(ABORT, 'mcp_delegation_redemptions_are_append_only');
END;

CREATE TABLE mcp_authorization_revocations (
  grant_id TEXT PRIMARY KEY REFERENCES mcp_authorization_grants(id),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 120),
  revoked_at INTEGER NOT NULL
);

CREATE TRIGGER mcp_authorization_revocations_validate
BEFORE INSERT ON mcp_authorization_revocations
BEGIN
  SELECT RAISE(ABORT, 'mcp_authorization_grant_unavailable')
  WHERE NOT EXISTS (
    SELECT 1
    FROM mcp_authorization_grants grant_row
    WHERE grant_row.id = NEW.grant_id
      AND grant_row.revoked_at IS NULL
  );

  SELECT RAISE(ABORT, 'mcp_authorization_revoke_forbidden')
  WHERE NOT EXISTS (
    SELECT 1
    FROM mcp_authorization_grants grant_row
    WHERE grant_row.id = NEW.grant_id
      AND (
        grant_row.account_id = NEW.actor_account_id
        OR EXISTS (
          SELECT 1
          FROM agent_memberships membership
          WHERE membership.agent_id = grant_row.agent_id
            AND membership.account_id = NEW.actor_account_id
            AND membership.role = 'primary_sponsor'
            AND membership.revoked_at IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM account_roles role
          WHERE role.account_id = NEW.actor_account_id
            AND role.role = 'platform_owner'
            AND role.revoked_at IS NULL
        )
      )
  );
END;

CREATE TRIGGER mcp_authorization_revocations_apply
AFTER INSERT ON mcp_authorization_revocations
BEGIN
  UPDATE mcp_authorization_grants
  SET revoked_at = NEW.revoked_at,
      revoked_reason = trim(NEW.reason)
  WHERE id = NEW.grant_id;
END;

CREATE TRIGGER mcp_authorization_revocations_no_update
BEFORE UPDATE ON mcp_authorization_revocations
BEGIN
  SELECT RAISE(ABORT, 'mcp_authorization_revocations_are_append_only');
END;

CREATE TRIGGER mcp_authorization_revocations_no_delete
BEFORE DELETE ON mcp_authorization_revocations
BEGIN
  SELECT RAISE(ABORT, 'mcp_authorization_revocations_are_append_only');
END;
