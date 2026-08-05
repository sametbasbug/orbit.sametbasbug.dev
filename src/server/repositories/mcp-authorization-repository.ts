import type { McpAuthorizationScope } from '../identity/mcp-authorization-scopes';

export {
  MCP_AUTHORIZATION_SCOPES,
  type McpAuthorizationScope,
} from '../identity/mcp-authorization-scopes';

export interface McpAuthorizationGrantView {
  id: string;
  accountId: string;
  agentId: string;
  handle: string;
  scopes: McpAuthorizationScope[];
  oauthClientId: string;
  oauthClientLabel: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
}

export interface McpDelegationCodeView {
  id: string;
  secretDigest: string;
  hashVersion: number;
  grantId: string;
  authorizationRequestId: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface McpAuthorizationRepository {
  createGrantWithCode(input: {
    grant: {
      id: string;
      accountId: string;
      agentId: string;
      scopes: McpAuthorizationScope[];
      oauthClientId: string;
      oauthClientLabel: string;
      createdAt: number;
      expiresAt: number | null;
    };
    code: McpDelegationCodeView;
    auditEventId: string;
    requestId: string;
  }): Promise<void>;

  createPendingAgentGrantWithCode(input: {
    pendingAgent: {
      id: string;
      handle: string;
      createdAt: number;
    };
    membershipId: string;
    grant: {
      id: string;
      accountId: string;
      agentId: string;
      scopes: McpAuthorizationScope[];
      oauthClientId: string;
      oauthClientLabel: string;
      createdAt: number;
      expiresAt: number | null;
    };
    code: McpDelegationCodeView;
    agentAuditEventId: string;
    authorizationAuditEventId: string;
    requestId: string;
  }): Promise<void>;

  listAbandonedPendingGrants(input: {
    accountId: string;
    createdBefore: number;
  }): Promise<Array<{ grantId: string; agentId: string }>>;

  getGrant(grantId: string): Promise<McpAuthorizationGrantView | null>;

  listAccountGrants(accountId: string): Promise<McpAuthorizationGrantView[]>;

  getDelegationCode(codeId: string): Promise<McpDelegationCodeView | null>;

  redeemDelegationCode(input: {
    codeId: string;
    grantId: string;
    authorizationRequestId: string;
    redemptionAuditEventId: string;
    requestId: string;
    redeemedAt: number;
  }): Promise<McpAuthorizationGrantView>;

  touchGrant(input: {
    grantId: string;
    usedAt: number;
  }): Promise<boolean>;

  revokeGrant(input: {
    grantId: string;
    actorAccountId: string;
    reason: string;
    auditEventId: string;
    requestId: string;
    revokedAt: number;
  }): Promise<void>;
}
