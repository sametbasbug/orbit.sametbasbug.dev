import type { D1DatabaseLike } from '../repositories/d1/d1-foundation-repository';

export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface OrbitBindings {
  DB: D1DatabaseLike;
  ASSETS?: AssetsBinding;
  ORBIT_ENVIRONMENT: 'local' | 'test' | 'production';
  ORBIT_ALLOWED_ORIGIN: string;
  ORBIT_GITHUB_CALLBACK_URL: string;
  ORBIT_PLATFORM_OWNER_GITHUB_ID: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  ORBIT_INVITATION_PEPPER_V1: string;
  ORBIT_SESSION_PEPPER_V1: string;
  ORBIT_AGENT_CREDENTIAL_PEPPER_V1: string;
  ORBIT_OAUTH_STATE_PEPPER_V1: string;
  ORBIT_CSRF_PEPPER_V1: string;
}

export function assertIdentityBindings(env: OrbitBindings): void {
  const required: Array<keyof OrbitBindings> = [
    'ORBIT_ALLOWED_ORIGIN',
    'ORBIT_GITHUB_CALLBACK_URL',
    'ORBIT_PLATFORM_OWNER_GITHUB_ID',
    'GITHUB_OAUTH_CLIENT_ID',
    'GITHUB_OAUTH_CLIENT_SECRET',
    'ORBIT_INVITATION_PEPPER_V1',
    'ORBIT_SESSION_PEPPER_V1',
    'ORBIT_AGENT_CREDENTIAL_PEPPER_V1',
    'ORBIT_OAUTH_STATE_PEPPER_V1',
    'ORBIT_CSRF_PEPPER_V1',
  ];
  for (const name of required) {
    if (typeof env[name] !== 'string' || env[name].length < 1) {
      throw new Error(`missing_binding:${name}`);
    }
  }
  if (env.ORBIT_PLATFORM_OWNER_GITHUB_ID !== '126420524') {
    throw new Error('platform_owner_github_id_mismatch');
  }
  if (env.ORBIT_ENVIRONMENT === 'production') {
    if (env.ORBIT_ALLOWED_ORIGIN !== 'https://orbit.sametbasbug.dev') {
      throw new Error('invalid_production_origin');
    }
    if (env.ORBIT_GITHUB_CALLBACK_URL !== 'https://orbit.sametbasbug.dev/v1/auth/github/callback') {
      throw new Error('invalid_production_callback');
    }
  } else if (env.ORBIT_ENVIRONMENT === 'local') {
    if (env.ORBIT_ALLOWED_ORIGIN !== 'http://localhost:4321') {
      throw new Error('invalid_local_origin');
    }
    if (env.ORBIT_GITHUB_CALLBACK_URL !== 'http://localhost:4321/v1/auth/github/callback') {
      throw new Error('invalid_local_callback');
    }
  }
}
