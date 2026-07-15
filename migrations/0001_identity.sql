PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  handle_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE INDEX accounts_status_created_idx ON accounts (status, created_at);

CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL CHECK (provider = 'github'),
  provider_user_id TEXT NOT NULL,
  provider_login_snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (provider, provider_user_id),
  UNIQUE (account_id, provider)
);

CREATE TABLE account_roles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL CHECK (role IN ('member', 'moderator', 'platform_owner')),
  granted_by_account_id TEXT REFERENCES accounts(id),
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE UNIQUE INDEX account_roles_active_unique
  ON account_roles (account_id, role)
  WHERE revoked_at IS NULL;
CREATE INDEX account_roles_lookup_idx ON account_roles (role, revoked_at);

CREATE TABLE account_quotas (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  quota_key TEXT NOT NULL CHECK (quota_key = 'agents.max_active'),
  limit_value INTEGER NOT NULL CHECK (limit_value = -1 OR limit_value >= 0),
  updated_by_account_id TEXT REFERENCES accounts(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, quota_key)
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  secret_digest TEXT NOT NULL UNIQUE,
  hash_version INTEGER NOT NULL CHECK (hash_version > 0),
  expected_github_user_id TEXT,
  expected_github_login_snapshot TEXT,
  agent_quota INTEGER NOT NULL DEFAULT 1 CHECK (agent_quota >= 0),
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  redeemed_by_account_id TEXT REFERENCES accounts(id),
  revoked_at INTEGER,
  revoked_by_account_id TEXT REFERENCES accounts(id),
  CHECK (expires_at > created_at),
  CHECK ((redeemed_at IS NULL) = (redeemed_by_account_id IS NULL))
);

CREATE INDEX invitations_binding_expiry_idx
  ON invitations (expected_github_user_id, expires_at);
CREATE INDEX invitations_admin_state_idx
  ON invitations (redeemed_at, revoked_at, expires_at);

CREATE TABLE invitation_redemptions (
  invitation_id TEXT PRIMARY KEY REFERENCES invitations(id),
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
  github_user_id TEXT NOT NULL,
  redeemed_at INTEGER NOT NULL
);

CREATE TRIGGER invitation_redemptions_validate_before_insert
BEFORE INSERT ON invitation_redemptions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM invitations
    WHERE id = NEW.invitation_id
      AND revoked_at IS NULL
      AND redeemed_at IS NULL
      AND expires_at > NEW.redeemed_at
      AND (
        expected_github_user_id IS NULL
        OR expected_github_user_id = NEW.github_user_id
      )
  ) THEN RAISE(ABORT, 'invalid_invitation') END;
END;

CREATE TRIGGER invitation_redemptions_mark_after_insert
AFTER INSERT ON invitation_redemptions
BEGIN
  UPDATE invitations
  SET redeemed_at = NEW.redeemed_at,
      redeemed_by_account_id = NEW.account_id
  WHERE id = NEW.invitation_id;
END;

CREATE TABLE oauth_flows (
  id TEXT PRIMARY KEY,
  state_digest TEXT NOT NULL UNIQUE,
  invitation_id TEXT REFERENCES invitations(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK (expires_at > created_at)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  secret_digest TEXT NOT NULL UNIQUE,
  hash_version INTEGER NOT NULL CHECK (hash_version > 0),
  csrf_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT,
  CHECK (idle_expires_at > created_at),
  CHECK (absolute_expires_at > created_at),
  CHECK (idle_expires_at <= absolute_expires_at)
);

CREATE INDEX sessions_account_state_idx
  ON sessions (account_id, revoked_at, absolute_expires_at);
CREATE INDEX sessions_idle_expiry_idx ON sessions (idle_expires_at);
