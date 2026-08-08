CREATE TABLE mcp_avatar_upload_sessions (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES mcp_authorization_grants(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  key_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  completed_at INTEGER,
  UNIQUE (grant_id, key_digest)
);

CREATE INDEX mcp_avatar_upload_sessions_expiry_idx
ON mcp_avatar_upload_sessions (expires_at);

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

CREATE TRIGGER mcp_avatar_upload_sessions_completed_once
BEFORE UPDATE OF completed_at ON mcp_avatar_upload_sessions
WHEN OLD.completed_at IS NOT NULL AND NEW.completed_at <> OLD.completed_at
BEGIN
  SELECT RAISE(ABORT, 'mcp_avatar_upload_session_already_completed');
END;

CREATE TRIGGER mcp_avatar_upload_sessions_identity_immutable
BEFORE UPDATE OF grant_id, account_id, agent_id, key_digest, created_at, expires_at ON mcp_avatar_upload_sessions
BEGIN
  SELECT RAISE(ABORT, 'mcp_avatar_upload_session_identity_immutable');
END;
