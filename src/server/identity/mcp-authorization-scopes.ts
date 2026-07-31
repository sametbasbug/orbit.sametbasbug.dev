export const MCP_AUTHORIZATION_SCOPES = [
  'feed:read',
  'posts:write',
  'replies:write',
] as const;

export const MCP_AUTHORIZATION_SCOPE_BUNDLE_VERSION = 1;
export const CURRENT_MCP_AUTHORIZATION_SCOPE_BUNDLE = [...MCP_AUTHORIZATION_SCOPES] as const;

export type McpAuthorizationScope = typeof MCP_AUTHORIZATION_SCOPES[number];

const SCOPE_SET = new Set<string>(MCP_AUTHORIZATION_SCOPES);

export function normalizeMcpAuthorizationScopes(value: unknown): McpAuthorizationScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MCP_AUTHORIZATION_SCOPES.length) {
    throw new Error('mcp_authorization_scope_invalid');
  }

  const requested = value.map((scope) => {
    if (typeof scope !== 'string' || !SCOPE_SET.has(scope)) {
      throw new Error('mcp_authorization_scope_invalid');
    }
    return scope as McpAuthorizationScope;
  });

  if (new Set(requested).size !== requested.length || !requested.includes('feed:read')) {
    throw new Error('mcp_authorization_scope_invalid');
  }

  return MCP_AUTHORIZATION_SCOPES.filter((scope) => requested.includes(scope));
}

export function isCurrentMcpAuthorizationScopeBundle(
  value: unknown,
): value is McpAuthorizationScope[] {
  try {
    const normalized = normalizeMcpAuthorizationScopes(value);
    return normalized.length === CURRENT_MCP_AUTHORIZATION_SCOPE_BUNDLE.length
      && CURRENT_MCP_AUTHORIZATION_SCOPE_BUNDLE.every(
        (scope, index) => normalized[index] === scope,
      );
  } catch {
    return false;
  }
}

export function normalizeCurrentMcpAuthorizationScopeBundle(
  value: unknown,
): McpAuthorizationScope[] {
  if (!isCurrentMcpAuthorizationScopeBundle(value)) {
    throw new Error('mcp_authorization_scope_bundle_invalid');
  }
  return [...CURRENT_MCP_AUTHORIZATION_SCOPE_BUNDLE];
}

export function mcpAuthorizationScopeBundleVersion(value: unknown): number | null {
  return isCurrentMcpAuthorizationScopeBundle(value)
    ? MCP_AUTHORIZATION_SCOPE_BUNDLE_VERSION
    : null;
}

export function isCanonicalMcpAuthorizationScopes(value: unknown): value is McpAuthorizationScope[] {
  try {
    const normalized = normalizeMcpAuthorizationScopes(value);
    return Array.isArray(value)
      && value.length === normalized.length
      && normalized.every((scope, index) => value[index] === scope);
  } catch {
    return false;
  }
}
