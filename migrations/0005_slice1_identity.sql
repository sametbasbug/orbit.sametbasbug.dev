PRAGMA foreign_keys = ON;

ALTER TABLE oauth_flows ADD COLUMN pkce_verifier_digest TEXT;
ALTER TABLE oauth_flows ADD COLUMN redirect_uri TEXT;

CREATE INDEX oauth_flows_expiry_idx
  ON oauth_flows (expires_at, consumed_at);

CREATE TRIGGER oauth_flows_require_slice1_fields
BEFORE INSERT ON oauth_flows
WHEN NEW.pkce_verifier_digest IS NULL OR NEW.redirect_uri IS NULL
BEGIN
  SELECT RAISE(ABORT, 'oauth_flow_security_fields_required');
END;

CREATE TABLE oauth_flow_consumptions (
  flow_id TEXT PRIMARY KEY REFERENCES oauth_flows(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  consumed_at INTEGER NOT NULL
);

CREATE TRIGGER oauth_flow_consumptions_validate_before_insert
BEFORE INSERT ON oauth_flow_consumptions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM oauth_flows
    WHERE id = NEW.flow_id
      AND consumed_at IS NULL
      AND expires_at > NEW.consumed_at
  ) THEN RAISE(ABORT, 'invalid_oauth_flow') END;
END;

CREATE TRIGGER oauth_flow_consumptions_mark_after_insert
AFTER INSERT ON oauth_flow_consumptions
BEGIN
  UPDATE oauth_flows
  SET consumed_at = NEW.consumed_at
  WHERE id = NEW.flow_id;
END;

CREATE TABLE invitation_revocations (
  invitation_id TEXT PRIMARY KEY REFERENCES invitations(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  revoked_at INTEGER NOT NULL
);

CREATE TRIGGER invitation_revocations_validate_before_insert
BEFORE INSERT ON invitation_revocations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM invitations
    WHERE id = NEW.invitation_id
      AND revoked_at IS NULL
      AND redeemed_at IS NULL
      AND expires_at > NEW.revoked_at
  ) THEN RAISE(ABORT, 'invitation_not_revocable') END;
END;

CREATE TRIGGER invitation_revocations_mark_after_insert
AFTER INSERT ON invitation_revocations
BEGIN
  UPDATE invitations
  SET revoked_at = NEW.revoked_at,
      revoked_by_account_id = NEW.account_id
  WHERE id = NEW.invitation_id;
END;

CREATE TABLE session_revocations (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  reason TEXT NOT NULL,
  revoked_at INTEGER NOT NULL
);

CREATE TRIGGER session_revocations_validate_before_insert
BEFORE INSERT ON session_revocations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM sessions
    WHERE id = NEW.session_id
      AND account_id = NEW.account_id
      AND revoked_at IS NULL
  ) THEN RAISE(ABORT, 'session_not_revocable') END;
END;

CREATE TRIGGER session_revocations_mark_after_insert
AFTER INSERT ON session_revocations
BEGIN
  UPDATE sessions
  SET revoked_at = NEW.revoked_at,
      revoked_reason = NEW.reason
  WHERE id = NEW.session_id;
END;

CREATE TRIGGER sessions_require_active_account
BEFORE INSERT ON sessions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM accounts WHERE id = NEW.account_id AND status = 'active'
  ) THEN RAISE(ABORT, 'inactive_session_account') END;
END;

-- Platform-owner authorization is rooted in GitHub's immutable numeric ID.
-- The login is a mutable display snapshot and is never consulted for access control.
INSERT INTO accounts (
  id, handle, handle_normalized, display_name, avatar_url,
  status, created_at, updated_at
) VALUES (
  '019f64d2-0109-7644-9a4e-a0d25df888e2',
  'sametbasbug',
  'sametbasbug',
  'Samet Başbuğ',
  'https://avatars.githubusercontent.com/u/126420524?v=4',
  'active',
  1784102918000,
  1784102918000
);

INSERT INTO auth_identities (
  id, account_id, provider, provider_user_id,
  provider_login_snapshot, created_at, last_seen_at
) VALUES (
  '019f64d2-010a-76cb-8824-696911819716',
  '019f64d2-0109-7644-9a4e-a0d25df888e2',
  'github',
  '126420524',
  'sametbasbug',
  1784102918000,
  1784102918000
);

INSERT INTO account_roles (
  id, account_id, role, granted_by_account_id, granted_at
) VALUES (
  '019f64d2-010a-76cb-8824-6e74b3c28916',
  '019f64d2-0109-7644-9a4e-a0d25df888e2',
  'platform_owner',
  NULL,
  1784102918000
);

INSERT INTO account_quotas (
  account_id, quota_key, limit_value, updated_by_account_id, updated_at
) VALUES (
  '019f64d2-0109-7644-9a4e-a0d25df888e2',
  'agents.max_active',
  -1,
  NULL,
  1784102918000
);

INSERT INTO audit_events (
  id, event_type, actor_type, actor_id, subject_type,
  subject_id, request_id, metadata_json, created_at
) VALUES (
  '019f64d2-010a-76cb-8824-72f961785c01',
  'platform_owner.seeded',
  'system',
  NULL,
  'account',
  '019f64d2-0109-7644-9a4e-a0d25df888e2',
  'seed_slice1_platform_owner',
  '{"provider":"github","providerUserId":"126420524"}',
  1784102918000
);
