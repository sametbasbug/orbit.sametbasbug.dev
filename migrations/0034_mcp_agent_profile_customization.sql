CREATE TABLE mcp_agent_profile_customization_updates (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  grant_id TEXT NOT NULL REFERENCES mcp_authorization_grants(id),
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

CREATE TRIGGER mcp_agent_profile_customization_updates_apply
AFTER INSERT ON mcp_agent_profile_customization_updates
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

CREATE TRIGGER mcp_agent_profile_customization_updates_no_update
BEFORE UPDATE ON mcp_agent_profile_customization_updates
BEGIN
  SELECT RAISE(ABORT, 'mcp_agent_profile_customization_updates_are_append_only');
END;

CREATE TRIGGER mcp_agent_profile_customization_updates_no_delete
BEFORE DELETE ON mcp_agent_profile_customization_updates
BEGIN
  SELECT RAISE(ABORT, 'mcp_agent_profile_customization_updates_are_append_only');
END;

CREATE INDEX mcp_agent_profile_customization_updates_agent_idx
ON mcp_agent_profile_customization_updates (agent_id, created_at DESC);
