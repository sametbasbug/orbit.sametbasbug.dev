import type { AuthProvider } from '../repositories/identity-repository';
import type { D1DatabaseLike } from '../repositories/d1/d1-foundation-repository';

export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface R2ObjectLike {
  key: string;
  size: number;
  etag: string;
  httpEtag?: string;
  checksums?: { sha256?: ArrayBuffer };
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  httpMetadata?: Record<string, string>;
}

export interface R2BucketLike {
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
    options?: {
      httpMetadata?: Record<string, string>;
      customMetadata?: Record<string, string>;
      sha256?: ArrayBuffer | Uint8Array | string;
    },
  ): Promise<R2ObjectLike | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2ObjectBodyLike | null>;
  head?(key: string): Promise<R2ObjectLike | null>;
  list(options?: { prefix?: string; cursor?: string; limit?: number; include?: string[] }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
}

export interface ImageTransformationResultLike {
  contentType(): string;
  image(): ReadableStream<Uint8Array>;
}

export interface ImageTransformerLike {
  transform(options: {
    width?: number;
    height?: number;
    fit?: 'scale-down' | 'cover';
    gravity?: 'center';
  }): ImageTransformerLike;
  output(options: { format: 'image/webp'; quality?: number }): Promise<ImageTransformationResultLike>;
}

export interface ImagesBindingLike {
  input(stream: ReadableStream<Uint8Array>): ImageTransformerLike;
}

export type OrbitDeploymentMode = 'dark_launch' | 'live';

const PRODUCTION_ORIGINS: Record<OrbitDeploymentMode, string> = {
  dark_launch: 'https://orbit-v6-production.samett33710.workers.dev',
  live: 'https://orbit.sametbasbug.dev',
};

/* Callback adresi origin'den türetiliyor, elle yazılmıyor. Sağlayıcı tek
 * olduğu için bugün tek satır, ama türetme kalıyor: elle yazılan bir adres
 * yanlış olduğunda hata "OAuth akışı geçersiz" diye görünür ve sebebini
 * söylemez. İkinci bir kapı eklendiği gün de aynı sebeple burası genişler. */
function callbackUrl(origin: string, provider: AuthProvider): string {
  return `${origin}/v1/auth/${provider}/callback`;
}

function assertCallbacks(env: OrbitBindings, origin: string, errorCode: string): void {
  if (env.ORBIT_GOOGLE_CALLBACK_URL !== callbackUrl(origin, 'google')) throw new Error(errorCode);
}

export interface OrbitBindings {
  DB: D1DatabaseLike;
  ASSETS?: AssetsBinding;
  BACKUPS?: R2BucketLike;
  MEDIA?: R2BucketLike;
  IMAGES?: ImagesBindingLike;
  ORBIT_ENVIRONMENT: 'local' | 'test' | 'staging' | 'production';
  ORBIT_DEPLOYMENT_MODE: OrbitDeploymentMode;
  ORBIT_ALLOWED_ORIGIN: string;
  ORBIT_GOOGLE_CALLBACK_URL: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  ORBIT_INVITATION_PEPPER_V1: string;
  ORBIT_SESSION_PEPPER_V1: string;
  ORBIT_AGENT_CREDENTIAL_PEPPER_V1: string;
  ORBIT_OAUTH_STATE_PEPPER_V1: string;
  ORBIT_CSRF_PEPPER_V1: string;
  ORBIT_CURSOR_PEPPER_V1: string;
  ORBIT_MCP_DELEGATION_PEPPER_V1?: string;
  ORBIT_MCP_SERVICE_SECRET_V1?: string;
  ORBIT_BACKUP_ENCRYPTION_KEY_V1?: string;
  /* Davet kapısı. 'true' olduğunda Google hesabı olan herkes davetsiz kayıt
   * olabiliyor; başka her değerde ve tanımsızken kapı kapalı ve kayıt için
   * davet gerekiyor.
   *
   * Neden bir vars, bir sır değil: bu bir gizlilik değil bir karar, ve
   * kararın depoda görünmesi gerekiyor. Değiştirmek bir commit ve bir dağıtım
   * demek — yani kapının açılması geri izlenebilir bir olay, panelde
   * yanlışlıkla tıklanabilen bir anahtar değil.
   *
   * Kapalıyken de kayıt yolunun tamamı işliyor ve test ediliyor: kapının
   * arkasındaki kod ilk kez açıldığı gün çalışmaya başlarsa, ilk kez o gün
   * bozuk olduğunu öğreniriz. */
  ORBIT_OPEN_REGISTRATION?: string;
  ORBIT_BACKUP_ENABLED?: string;
  ORBIT_MEDIA_ENABLED?: string;
  /* Giden posta. Üçü de isteğe bağlı ve birlikte anlamlı: biri eksikse
   * gönderim kapalıdır. Kapalı olmak bir arıza değil — yerel geliştirme,
   * test ve staging bu hâlde çalışıyor ve kuyruk yazılmaya devam ediyor.
   * Anahtar bir sırdır ve yalnız `wrangler secret put` ile girilir; vars
   * içinde durursa depoya sızar. */
  RESEND_API_KEY?: string;
  ORBIT_EMAIL_FROM?: string;
  ORBIT_EMAIL_REPLY_TO?: string;
}

export function assertDeploymentBindings(env: OrbitBindings): void {
  if (!['local', 'test', 'staging', 'production'].includes(env.ORBIT_ENVIRONMENT)) {
    throw new Error('invalid_environment');
  }
  if (!['dark_launch', 'live'].includes(env.ORBIT_DEPLOYMENT_MODE)) {
    throw new Error('invalid_deployment_mode');
  }

  if (env.ORBIT_ENVIRONMENT === 'production') {
    const expected = PRODUCTION_ORIGINS[env.ORBIT_DEPLOYMENT_MODE];
    if (env.ORBIT_ALLOWED_ORIGIN !== expected) {
      throw new Error('invalid_production_origin');
    }
    assertCallbacks(env, expected, 'invalid_production_callback');
  } else if (env.ORBIT_ENVIRONMENT === 'staging') {
    if (env.ORBIT_DEPLOYMENT_MODE !== 'dark_launch') {
      throw new Error('invalid_staging_deployment_mode');
    }
    if (env.ORBIT_ALLOWED_ORIGIN !== 'https://orbit-v6-staging.samett33710.workers.dev') {
      throw new Error('invalid_staging_origin');
    }
    assertCallbacks(env, 'https://orbit-v6-staging.samett33710.workers.dev', 'invalid_staging_callback');
  } else if (env.ORBIT_ENVIRONMENT === 'local') {
    if (env.ORBIT_DEPLOYMENT_MODE !== 'live') {
      throw new Error('invalid_local_deployment_mode');
    }
    if (env.ORBIT_ALLOWED_ORIGIN !== 'http://localhost:4321') {
      throw new Error('invalid_local_origin');
    }
    assertCallbacks(env, 'http://localhost:4321', 'invalid_local_callback');
  } else if (env.ORBIT_DEPLOYMENT_MODE !== 'live') {
    throw new Error('invalid_test_deployment_mode');
  }
}

/* Kapının tek okuyucusu. Karşılaştırma katı — 'TRUE', '1', 'yes' açmıyor.
 * Yazım hatasıyla açılabilen bir kapı, kapalı olduğunu sandığın bir kapıdır. */
export function openRegistrationEnabled(env: OrbitBindings): boolean {
  return env.ORBIT_OPEN_REGISTRATION === 'true';
}

export function blocksSearchIndexing(env: OrbitBindings): boolean {
  return env.ORBIT_ENVIRONMENT === 'staging'
    || (env.ORBIT_ENVIRONMENT === 'production' && env.ORBIT_DEPLOYMENT_MODE === 'dark_launch');
}

export function assertIdentityBindings(env: OrbitBindings): void {
  assertDeploymentBindings(env);
  const required: Array<keyof OrbitBindings> = [
    'ORBIT_ALLOWED_ORIGIN',
    'ORBIT_GOOGLE_CALLBACK_URL',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'ORBIT_INVITATION_PEPPER_V1',
    'ORBIT_SESSION_PEPPER_V1',
    'ORBIT_AGENT_CREDENTIAL_PEPPER_V1',
    'ORBIT_OAUTH_STATE_PEPPER_V1',
    'ORBIT_CSRF_PEPPER_V1',
    'ORBIT_CURSOR_PEPPER_V1',
  ];
  for (const name of required) {
    if (typeof env[name] !== 'string' || env[name].length < 1) {
      throw new Error(`missing_binding:${name}`);
    }
  }
}
