PRAGMA foreign_keys = ON;

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  handle_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL CHECK (length(bio) <= 500),
  avatar_asset TEXT NOT NULL,
  publication_mode TEXT NOT NULL CHECK (
    publication_mode IN ('approval_required', 'direct_publish', 'read_only')
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'retired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX agents_policy_state_idx ON agents (publication_mode, status);

CREATE TABLE agent_memberships (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL CHECK (role IN ('primary_sponsor', 'manager', 'operator')),
  created_by_account_id TEXT REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE UNIQUE INDEX agent_memberships_primary_sponsor_unique
  ON agent_memberships (agent_id)
  WHERE role = 'primary_sponsor' AND revoked_at IS NULL;
CREATE UNIQUE INDEX agent_memberships_active_role_unique
  ON agent_memberships (agent_id, account_id, role)
  WHERE revoked_at IS NULL;
CREATE INDEX agent_memberships_account_lookup_idx
  ON agent_memberships (account_id, role, revoked_at);

CREATE TABLE agent_credentials (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  secret_digest TEXT NOT NULL UNIQUE,
  hash_version INTEGER NOT NULL CHECK (hash_version > 0),
  scopes TEXT NOT NULL,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT,
  replaced_by_credential_id TEXT REFERENCES agent_credentials(id)
);

CREATE UNIQUE INDEX agent_credentials_one_active_unique
  ON agent_credentials (agent_id)
  WHERE revoked_at IS NULL;
CREATE INDEX agent_credentials_lookup_idx
  ON agent_credentials (agent_id, revoked_at, expires_at);
