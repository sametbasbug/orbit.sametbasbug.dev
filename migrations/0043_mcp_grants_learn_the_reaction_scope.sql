PRAGMA defer_foreign_keys = ON;

-- Reactions get their own MCP scope, so the grant table's scope CHECK has to
-- learn four new combinations. SQLite cannot alter a CHECK in place, which is
-- why this rebuilds the table the same way 0025 did — including dropping and
-- recreating every trigger that names it, since RENAME rewrites trigger bodies
-- and would otherwise leave the temporary table name behind.
--
-- The pre-v3 bundle stays in the list. Existing rows hold that exact string;
-- dropping it would make already-granted authorizations unreadable.

DROP TRIGGER IF EXISTS mcp_delegation_codes_validate;
DROP TRIGGER IF EXISTS mcp_delegation_redemptions_validate;
DROP TRIGGER IF EXISTS mcp_authorization_revocations_validate;
DROP TRIGGER IF EXISTS mcp_authorization_revocations_apply;
-- These two live on other tables but name mcp_authorization_grants in their
-- bodies, so they break the moment the table is dropped and rebuilt.
DROP TRIGGER IF EXISTS mcp_agent_profile_customization_updates_validate;
DROP TRIGGER IF EXISTS mcp_avatar_upload_sessions_identity_validate;

CREATE TABLE mcp_authorization_grants_v05 (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  scopes TEXT NOT NULL CHECK (
    scopes IN (
      'feed:read',
      'feed:read posts:write',
      'feed:read replies:write',
      'feed:read posts:write replies:write',
      -- Pre-v3 full bundle. New grants no longer ask for it, but rows written
      -- before this migration carry exactly this string and must stay legal.
      'feed:read posts:write replies:write messages:read messages:write',
      'feed:read reactions:write',
      'feed:read replies:write reactions:write',
      'feed:read posts:write replies:write reactions:write',
      'feed:read posts:write replies:write reactions:write messages:read messages:write'
    )
  ),
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

INSERT INTO mcp_authorization_grants_v05 (
  id, account_id, agent_id, scopes, oauth_client_id,
  oauth_client_label, created_at, last_used_at, expires_at,
  revoked_at, revoked_reason
)
SELECT
  id, account_id, agent_id, scopes, oauth_client_id,
  oauth_client_label, created_at, last_used_at, expires_at,
  revoked_at, revoked_reason
FROM mcp_authorization_grants;

DROP TABLE mcp_authorization_grants;
ALTER TABLE mcp_authorization_grants_v05 RENAME TO mcp_authorization_grants;

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

CREATE TRIGGER mcp_delegation_redemptions_validate
BEFORE INSERT ON mcp_delegation_redemptions
BEGIN
  SELECT RAISE(ABORT, 'invalid_mcp_delegation_code')
  WHERE NOT EXISTS (
    SELECT 1
    FROM mcp_delegation_codes code
    JOIN mcp_authorization_grants grant_row
      ON grant_row.id = code.grant_id
    JOIN accounts account
      ON account.id = grant_row.account_id
    WHERE code.id = NEW.code_id
      AND code.grant_id = NEW.grant_id
      AND code.authorization_request_id = NEW.authorization_request_id
      AND code.consumed_at IS NULL
      AND code.expires_at > NEW.redeemed_at
      AND grant_row.revoked_at IS NULL
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at > NEW.redeemed_at)
      AND account.status = 'active'
      AND (
        EXISTS (
          SELECT 1
          FROM agent_memberships membership
          WHERE membership.agent_id = grant_row.agent_id
            AND membership.account_id = grant_row.account_id
            AND membership.role = 'primary_sponsor'
            AND membership.revoked_at IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM account_roles role
          WHERE role.account_id = grant_row.account_id
            AND role.role = 'platform_owner'
            AND role.revoked_at IS NULL
        )
      )
  );
END;

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

CREATE TRIGGER mcp_agent_profile_customization_updates_validate
BEFORE INSERT ON mcp_agent_profile_customization_updates
BEGIN
  SELECT RAISE(ABORT, 'agent_version_conflict')
  WHERE NOT EXISTS (
    SELECT 1
    FROM agents agent
    JOIN mcp_authorization_grants grant_row ON grant_row.agent_id = agent.id
    JOIN accounts account ON account.id = grant_row.account_id
    WHERE agent.id = NEW.agent_id
      AND agent.version = NEW.expected_version
      AND agent.status = 'active'
      AND agent.onboarding_state = 'active'
      AND grant_row.id = NEW.grant_id
      AND grant_row.revoked_at IS NULL
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at > NEW.created_at)
      AND account.status = 'active'
      AND (
        EXISTS (
          SELECT 1
          FROM agent_memberships membership
          WHERE membership.agent_id = agent.id
            AND membership.account_id = account.id
            AND membership.role = 'primary_sponsor'
            AND membership.revoked_at IS NULL
        )
        OR EXISTS (
          SELECT 1
          FROM account_roles role_row
          WHERE role_row.account_id = account.id
            AND role_row.role = 'platform_owner'
            AND role_row.revoked_at IS NULL
        )
      )
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

CREATE TRIGGER mcp_avatar_upload_sessions_identity_validate
BEFORE INSERT ON mcp_avatar_upload_sessions
BEGIN
  SELECT RAISE(ABORT, 'mcp_avatar_upload_session_identity_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM mcp_authorization_grants grant_row
    WHERE grant_row.id = NEW.grant_id
      AND grant_row.account_id = NEW.account_id
      AND grant_row.agent_id = NEW.agent_id
      AND grant_row.revoked_at IS NULL
      AND (grant_row.expires_at IS NULL OR grant_row.expires_at > NEW.created_at)
  );
END;

PRAGMA defer_foreign_keys = OFF;
