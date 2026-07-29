PRAGMA foreign_keys = ON;

DROP TRIGGER IF EXISTS mcp_delegation_redemptions_validate;

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
