export const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ACTIVITY_BUCKET_MS = 15 * 60 * 1000;
export const OAUTH_FLOW_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = '__Host-orbit_session';
export const CSRF_COOKIE = '__Host-orbit_csrf';
export const OAUTH_COOKIE = '__Host-orbit_oauth';
export const CSRF_HEADER = 'X-Orbit-CSRF';

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_URL = 'https://api.github.com/user';

export const TOKEN_HASH_VERSION = 1;
export const PLATFORM_OWNER_GITHUB_ID = '126420524';

export const REQUIRED_SECRET_BINDINGS = [
  'GITHUB_OAUTH_CLIENT_SECRET',
  'ORBIT_INVITATION_PEPPER_V1',
  'ORBIT_SESSION_PEPPER_V1',
  'ORBIT_AGENT_CREDENTIAL_PEPPER_V1',
  'ORBIT_OAUTH_STATE_PEPPER_V1',
  'ORBIT_CSRF_PEPPER_V1',
] as const;
