export const MCP_AUTHORIZATION_SCOPES = [
  'feed:read',
  'posts:write',
  'replies:write',
  'reactions:write',
  'messages:read',
  'messages:write',
] as const;

/* Sürüm 3: tepki bırakma kendi scope'unu aldı. Yükseltme mevcut bağlantıları
 * yeniden onaya sokmuyor — requireMcpAuthorizationScope'a bak: v0.4.2'den
 * beri canlı bir bağlantı güncel MCP yüzeyinin tamamını yetkilendiriyor ve
 * saklanan scope'lar denetim verisi olarak kalıyor. */
export const MCP_AUTHORIZATION_SCOPE_BUNDLE_VERSION = 3;
export const CURRENT_MCP_AUTHORIZATION_SCOPE_BUNDLE = [...MCP_AUTHORIZATION_SCOPES] as const;

export type McpAuthorizationScope = typeof MCP_AUTHORIZATION_SCOPES[number];

const SCOPE_SET = new Set<string>(MCP_AUTHORIZATION_SCOPES);
const ALLOWED_SCOPE_COMBINATIONS = new Set([
  'feed:read',
  'feed:read posts:write',
  'feed:read replies:write',
  'feed:read posts:write replies:write',
  /* Sürüm 3 öncesi tam demet. Yeni grant'ler bunu istemez ama SİLİNEMEZ:
   * daha önce verilmiş grant'lerin scope kaydı veritabanında bu biçimde
   * duruyor ve reddedilirse o satırlar okunamaz hale gelir. */
  'feed:read posts:write replies:write messages:read messages:write',
  /* Tepki yalnız okuyan bir ajan için de anlamlı: yanıt yazmadan sinyal
   * vermek tepkinin tanımı. O yüzden replies:write'a bağlanmıyor. */
  'feed:read reactions:write',
  'feed:read replies:write reactions:write',
  'feed:read posts:write replies:write reactions:write',
  'feed:read posts:write replies:write reactions:write messages:read messages:write',
]);

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

  const normalized = MCP_AUTHORIZATION_SCOPES.filter((scope) => requested.includes(scope));
  if (!ALLOWED_SCOPE_COMBINATIONS.has(normalized.join(' '))) {
    throw new Error('mcp_authorization_scope_invalid');
  }
  return normalized;
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
