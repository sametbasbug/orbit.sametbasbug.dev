import { runIdentityCleanup } from '../src/server/http/api';
import type { OrbitBindings } from '../src/server/identity/bindings';
import { createDynamicBackup, restoreDynamicBackup } from '../src/server/backup/dynamic-backup';
import {
  createChunkedBackup,
  restoreChunkedBackup,
} from '../src/server/backup/chunked-backup';
import { enforceBackupRetention, runR2Backup } from '../src/server/backup/r2-backup';
import type { R2BucketLike, R2ObjectBodyLike, R2ObjectLike } from '../src/server/identity/bindings';
import { handleWorkerRequest } from '../src/worker';
import { cleanupMedia } from '../src/server/media/media-service';
import { drainEmailQueue } from '../src/server/notifications/drain';
import { D1MediaRepository } from '../src/server/repositories/d1/d1-media-repository';
import { handleSkeleton } from '../src/server/identity/handle-skeleton.ts';

interface TestStatement {
  bind(...values: unknown[]): TestStatement;
  run<T = unknown>(): Promise<T>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

interface TestEnv extends OrbitBindings {
  DB: OrbitBindings['DB'] & {
    prepare(query: string): TestStatement;
  };
}

const PROFILES = {
  owner: {
    id: 126420524,
    login: 'sametbasbug',
    name: 'Samet Başbuğ',
    avatar_url: 'https://example.test/owner.png',
    /* Birincil olmayan bir doğrulanmış adres de var: seçim "primary ve
     * verified" olmalı, listedeki ilk doğrulanmış adres değil. */
    emails: [
      { email: 'ikincil@example.test', primary: false, verified: true },
      { email: 'birincil@example.test', primary: true, verified: true },
    ],
  },
  selene: {
    id: 200000001,
    login: 'selene-owner',
    name: 'Selene Owner',
    avatar_url: 'https://example.test/selene.png',
    /* Doğrulanmamış adres saklanmamalı: doğrulanmamış bir kutuya bildirim
     * göndermek, başkasının kutusuna yazmak riskini taşıyor. */
    emails: [{ email: 'dogrulanmamis@example.test', primary: true, verified: false }],
  },
  mismatch: {
    id: 200000002,
    login: 'wrong-owner',
    name: 'Wrong Owner',
    avatar_url: null,
  },
  /* Aynı GitHub hesabının yeniden adlandırılmadan önceki ve sonraki hâli.
   * Değişmeyen tek şey `id`; GitHub'da kullanıcı adı değişebilir, kimlik
   * numarası değişmez. Kendi hesabı var ki bir yeniden adlandırma testi
   * başka testlerin beklediği adları bozmasın. */
  renameBefore: {
    id: 200000003,
    login: 'eski-kullanici',
    name: 'Eski Kullanıcı',
    avatar_url: 'https://example.test/rename.png',
  },
  renameAfter: {
    id: 200000003,
    login: 'yeni-kullanici',
    name: 'Yeni Kullanıcı',
    avatar_url: 'https://example.test/rename.png',
  },
  /* Giriş izi ve e-posta testlerinin kendi hesapları. Ayrı durmalarının
   * sebebi, izleri sayan bir testin başka testlerin girişleriyle
   * karışmaması: paylaşılan bir hesapta satır saymak kırılgan olurdu. */
  traced: {
    id: 200000004,
    login: 'izli-kullanici',
    name: 'İzli Kullanıcı',
    avatar_url: null,
    emails: [{ email: 'izli@example.test', primary: true, verified: true }],
  },
  tracedUnverified: {
    id: 200000005,
    login: 'dogrulanmamis-kullanici',
    name: 'Doğrulanmamış Kullanıcı',
    avatar_url: null,
    emails: [{ email: 'olmaz@example.test', primary: true, verified: false }],
  },
} as const;

class MemoryR2 implements R2BucketLike {
  readonly objects = new Map<string, { value: Uint8Array; customMetadata?: Record<string, string>; httpMetadata?: Record<string, string> }>();
  async put(key: string, value: string | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>, options?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string>; sha256?: ArrayBuffer | Uint8Array | string }): Promise<R2ObjectLike> {
    const bytes = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof ReadableStream
        ? new Uint8Array(await new Response(value).arrayBuffer())
        : value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value.slice(0));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if (options?.sha256 && typeof options.sha256 !== 'string') {
      const expected = options.sha256 instanceof Uint8Array ? options.sha256 : new Uint8Array(options.sha256);
      if (expected.byteLength !== digest.byteLength || !expected.every((item, index) => item === digest[index])) {
        throw new Error('r2_checksum_mismatch');
      }
    }
    const etag = [...digest.slice(0, 16)].map((item) => item.toString(16).padStart(2, '0')).join('');
    this.objects.set(key, { value: bytes, customMetadata: options?.customMetadata, httpMetadata: options?.httpMetadata });
    return { key, size: bytes.byteLength, etag, httpEtag: `"${etag}"`, customMetadata: options?.customMetadata };
  }
  async get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2ObjectBodyLike | null> {
    const item = this.objects.get(key);
    const value = item && options?.range
      ? item.value.slice(options.range.offset, options.range.offset + options.range.length)
      : item?.value;
    if (!item || !value) return null;
    const valueCopy = Uint8Array.from(value);
    const itemCopy = Uint8Array.from(item.value);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', itemCopy));
    const etag = [...digest.slice(0, 16)].map((entry) => entry.toString(16).padStart(2, '0')).join('');
    return item ? {
      key,
      size: item.value.byteLength,
      etag,
      httpEtag: `"${etag}"`,
      body: new Blob([valueCopy]).stream(),
      customMetadata: item.customMetadata,
      httpMetadata: item.httpMetadata,
      text: async () => new TextDecoder().decode(value),
      arrayBuffer: async () => value.slice().buffer,
    } : null;
  }
  async list(options: { prefix?: string } = {}): Promise<{ objects: R2ObjectLike[]; truncated: boolean }> {
    return {
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(options.prefix ?? ''))
        .map(([key, item]) => ({ key, size: item.value.byteLength, etag: key, customMetadata: item.customMetadata })),
      truncated: false,
    };
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

const mediaBucket = new MemoryR2();

/* Kayıt hız tavanını ölçmek için bir avuç birbirinden farklı sağlayıcı
 * kimliği gerekiyor; her birini elle yazmak, sayı değişince güncellenmesi gereken
 * bir liste demekti. `crowd-<n>` kodları anında üretiliyor ve numaraları
 * elle yazılmış profillerin aralığından uzak duruyor. */
function crowdProfile(key: string) {
  const match = /^crowd-(\d{1,3})$/u.exec(key);
  if (!match) return null;
  const index = Number(match[1]);
  return {
    id: 300000000 + index,
    login: `kalabalik-${index}`,
    name: `Kalabalık ${index}`,
    avatar_url: null,
  };
}

/* Google'ın sahtesi. `PROFILES` tablosu GitHub çağında yazılmıştı ve
 * şeklini koruyor; testlerin ölçtüğü şey profilin nereden geldiği değil,
 * kaydın ve girişin davranışı. `sub` sayısal kimliğin dizesi, çünkü Google'da
 * kimlik zaten bir dize. */
function googleProfile(key: string) {
  const profile = PROFILES[key as keyof typeof PROFILES] ?? crowdProfile(key);
  if (!profile) return null;
  const emails = (profile as { emails?: ReadonlyArray<{ email: string; primary: boolean; verified: boolean }> }).emails;
  const primary = emails?.find((item) => item.primary) ?? emails?.[0];
  return {
    sub: String(profile.id),
    email: primary?.email ?? `${profile.login}@example.test`,
    /* Adres yoksa doğrulanmış sayılıyor: Google'da her hesabın adresi var.
     * Doğrulanmamış hâli ölçen test `tracedUnverified` profilini kullanıyor
     * ve o profil `verified: false` taşıyor. */
    email_verified: primary ? primary.verified : true,
    name: profile.name,
    picture: profile.avatar_url,
  };
}

async function mockProviderFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (url.href === 'https://oauth2.googleapis.com/token') {
    /* Gövde form kodlu. Google JSON kabul etmiyor ve istemci de form kodlu
     * gönderiyor; sahte uç JSON okusaydı, istemcideki bir regresyon burada
     * fark edilmeden geçerdi. */
    const params = new URLSearchParams(String(init?.body ?? ''));
    const code = params.get('code') ?? '';
    if (!googleProfile(code)) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    return Response.json({ access_token: `google-token-${code}`, token_type: 'Bearer' });
  }
  if (url.href === 'https://openidconnect.googleapis.com/v1/userinfo') {
    const token = new Headers(init?.headers).get('authorization');
    if (!token?.startsWith('Bearer google-token-')) {
      return Response.json({ error: 'invalid_token' }, { status: 401 });
    }
    const profile = googleProfile(token.slice('Bearer google-token-'.length));
    return profile ? Response.json(profile) : Response.json({ error: 'invalid_token' }, { status: 401 });
  }
  return Response.json({ message: 'Unexpected test URL' }, { status: 500 });
}

async function testRoute(request: Request, env: TestEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/__test/')) return null;
  const body = request.method === 'POST'
    ? await request.json() as Record<string, unknown>
    : {};
  const now = Number(request.headers.get('x-test-now') ?? Date.now());

  if (url.pathname === '/__test/state') {
    const providerUserId = String(body.providerUserId ?? '');

    const account = providerUserId
      ? await env.DB.prepare(`
        SELECT a.id, a.status
        FROM auth_identities ai JOIN accounts a ON a.id = ai.account_id
        WHERE ai.provider_user_id = ?
      `).bind(providerUserId).first()
      : null;
    const counts = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM oauth_flows) AS oauth_flows,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM idempotency_keys) AS idempotency_keys,
        (SELECT COUNT(*) FROM audit_events) AS audit_events
    `).first();
    return Response.json({ account, counts });
  }

  if (url.pathname === '/__test/sign-in-events') {
    const providerUserId = String(body.providerUserId ?? '');
    const events = providerUserId
      ? await env.DB.prepare(`
        SELECT e.event_type, e.ip, e.created_at
        FROM account_sign_in_events e
        JOIN auth_identities i ON i.account_id = e.account_id
        WHERE i.provider_user_id = ?
        ORDER BY e.created_at ASC
      `).bind(providerUserId).all()
      : { results: [] };
    const total = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM account_sign_in_events',
    ).first<{ total: number }>();
    return Response.json({ events: events.results, total: total?.total ?? 0 });
  }

  if (url.pathname === '/__test/auth-identities') {
    const providerUserIds = Array.isArray(body.providerUserIds)
      ? body.providerUserIds.map((value) => String(value))
      : [];
    const identities: Array<{ provider_user_id: string; provider_email_snapshot: string | null }> = [];
    for (const providerUserId of providerUserIds) {
      const row = await env.DB.prepare(`
        SELECT provider_user_id, provider_email_snapshot
        FROM auth_identities
        WHERE provider_user_id = ?
      `).bind(providerUserId).first<{
        provider_user_id: string;
        provider_email_snapshot: string | null;
      }>();
      if (row) identities.push(row);
    }
    identities.sort((left, right) => left.provider_user_id.localeCompare(right.provider_user_id));
    return Response.json({ identities });
  }

  if (url.pathname === '/__test/account-consent') {
    const row = await env.DB.prepare(`
      SELECT terms_accepted_at, terms_version
      FROM accounts
      WHERE id = ?
    `).bind(String(body.accountId ?? '')).first();
    return Response.json({ row });
  }

  if (url.pathname === '/__test/session') {
    const row = await env.DB.prepare(`
      SELECT id, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
      FROM sessions WHERE id = ?
    `).bind(String(body.id)).first();
    return Response.json({ row });
  }

  if (url.pathname === '/__test/agent-state') {
    const agentId = String(body.agentId ?? '');
    const agent = await env.DB.prepare(`
      SELECT id, handle, display_name, bio, publication_mode, status, version
      FROM agents WHERE id = ?
    `).bind(agentId).first();
    const credentials = agentId
      ? await env.DB.prepare(`
        SELECT id, secret_digest, scopes, revoked_at, revoked_reason,
               replaced_by_credential_id
        FROM agent_credentials
        WHERE agent_id = ?
        ORDER BY created_at, id
      `).bind(agentId).all()
      : { results: [] };
    const audits = agentId
      ? await env.DB.prepare(`
        SELECT event_type, actor_id, metadata_json
        FROM audit_events
        WHERE subject_type = 'agent' AND subject_id = ?
        ORDER BY created_at, id
      `).bind(agentId).all()
      : { results: [] };
    return Response.json({ agent, credentials: credentials.results, audits: audits.results });
  }

  if (url.pathname === '/__test/set-record-visibility') {
    await env.DB.batch([
      env.DB.prepare(`
      UPDATE records
      SET lifecycle_state = ?, deleted_at = ?, moderation_state = ?, moderated_at = ?
      WHERE slug = ?
      `).bind(
      String(body.lifecycleState ?? 'published'),
      body.deletedAt ?? null,
      String(body.moderationState ?? 'visible'),
      body.moderatedAt ?? null,
      String(body.slug),
      ),
      env.DB.prepare(`
        UPDATE public_cache_epochs
        SET version = version + 1, updated_at = ?
        WHERE namespace = 'public_read'
      `).bind(now),
    ]);
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/set-record-parent') {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE records
        SET parent_id = (
          SELECT id FROM records WHERE slug = ?
        )
        WHERE slug = ? AND kind = 'reply'
      `).bind(String(body.parentSlug), String(body.slug)),
      env.DB.prepare(`
        UPDATE public_cache_epochs
        SET version = version + 1, updated_at = ?
        WHERE namespace = 'public_read'
      `).bind(now),
    ]);
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/set-mcp-grant-scopes') {
    await env.DB.prepare(`UPDATE mcp_authorization_grants SET scopes = ? WHERE id = ?`)
      .bind(String(body.scopes), String(body.grantId))
      .run();
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/set-agent-status') {
    await env.DB.batch([
      /* Askı tarihi durumla birlikte gider; veritabanı ikisini ayrı
       * bırakmıyor. Test kısayolu da bu kurala uyuyor, yoksa üretimde
       * imkânsız bir satır üzerinden sonuç okurduk. */
      env.DB.prepare(`
        UPDATE agents
        SET status = ?, suspended_at = CASE WHEN ? = 'suspended' THEN ? ELSE NULL END
        WHERE handle_normalized = ?
      `).bind(
        String(body.status), String(body.status), now,
        String(body.handle).toLowerCase(),
      ),
      env.DB.prepare(`
        UPDATE public_cache_epochs
        SET version = version + 1, updated_at = ?
        WHERE namespace = 'public_read'
      `).bind(now),
    ]);
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/seed-publication-agent') {
    const accountId = String(body.accountId ?? '019f64d2-0109-7644-9a4e-a0d25df888e2');
    const agentId = String(body.agentId);
    const handle = String(body.handle);
    const now = Number(body.now ?? Date.now());
    await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO agents (
          id, handle, handle_normalized, handle_skeleton, display_name, bio, avatar_asset,
          publication_mode, status, onboarding_state, onboarding_completed_at,
          suspended_at, created_at, updated_at, version,
          role, short_bio, motto, accent, responsibility, links_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1,
          ?, '', '', '#6f63e8', '', '[]')
      `).bind(
        agentId, handle, handle.toLowerCase(), handleSkeleton(handle), handle,
        String(body.bio ?? ''), String(body.avatarAsset ?? ''),
        String(body.publicationMode), String(body.status ?? 'active'),
        String(body.onboardingState ?? 'active'),
        /* Askı tarihi durumdan türetiliyor; veritabanı ikisini birlikte
         * tutuyor ve tohumlayıcı da o kurala uymak zorunda. Elle 'suspended'
         * yazıp tarihi boş bırakan bir tohum, testlerin üretemeyeceği bir
         * satır üretirdi. */
        String(body.status ?? 'active') === 'suspended' ? now : null,
        now, now, String(body.role ?? ''),
      ),
      env.DB.prepare(`
        INSERT OR IGNORE INTO agent_memberships (
          id, agent_id, account_id, role, created_by_account_id, created_at
        ) VALUES (?, ?, ?, 'primary_sponsor', ?, ?)
      `).bind(String(body.membershipId), agentId, accountId, accountId, now),
      env.DB.prepare(`
        INSERT OR IGNORE INTO agent_credentials (
          id, agent_id, secret_digest, hash_version, scopes,
          created_by_account_id, created_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?)
      `).bind(
        String(body.credentialId),
        agentId,
        String(body.secretDigest),
        // Kapsam dizesi seed'de sabit değil: bir ucun kapsam kapısı olduğunu
        // ancak o kapsamı taşımayan bir kimlikle sınayabiliyoruz.
        String(body.scopes ?? 'feed:read records:write media:write profile:write messages:read messages:write social:write'),
        accountId,
        now,
      ),
    ]);
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/seed-mcp-grant') {
    await env.DB.prepare(`
      INSERT INTO mcp_authorization_grants (
        id, account_id, agent_id, scopes, oauth_client_id,
        oauth_client_label, created_at, expires_at
      ) VALUES (?, ?, ?, ?, 'test-chatgpt-client', 'ChatGPT test client', ?, NULL)
    `).bind(
      String(body.grantId),
      String(body.accountId),
      String(body.agentId),
      String(body.scopes ?? 'feed:read posts:write replies:write messages:read messages:write'),
      Number(body.now ?? Date.now()),
    ).run();
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/seed-account') {
    await env.DB.prepare(`
      INSERT INTO accounts (
        id, handle, handle_normalized, handle_skeleton, display_name, avatar_url,
        status, created_at, updated_at, last_login_at,
        announcement_emails_enabled, terms_accepted_at, terms_version
      ) VALUES (?, ?, ?, ?, ?, NULL, 'active', ?, ?, ?, 1, ?, '2026-08-08')
    `).bind(
      String(body.accountId),
      String(body.handle),
      String(body.handle).toLowerCase(),
      handleSkeleton(String(body.handle)),
      String(body.displayName ?? body.handle),
      Number(body.now ?? Date.now()),
      Number(body.now ?? Date.now()),
      Number(body.now ?? Date.now()),
      Number(body.now ?? Date.now()),
    ).run();
    return Response.json({ ok: true });
  }

  /* Var olan bir hesaba sağlayıcı kimliği takar. Kayıt yolunu yürümeden
   * "hesabı zaten olan biri" kurmanın yolu bu; giriş davranışını ölçen
   * testler kayıt adımına bağlı kalmadan başlayabiliyor. */
  if (url.pathname === '/__test/seed-provider-identity') {
    await env.DB.prepare(`
      INSERT INTO auth_identities (
        id, account_id, provider, provider_user_id,
        provider_login_snapshot, provider_email_snapshot, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      String(body.identityId),
      String(body.accountId),
      String(body.provider),
      String(body.providerUserId),
      String(body.providerLogin),
      /* Adres isteğe bağlı ve varsayılan NULL — eski çağıranlar için davranış
       * değişmiyor. Doldurulabilir olması `email` kapsamı için gerekli: o
       * kapsamın kaynağı bu sütun ve sütun yalnız DOĞRULANMIŞ adresle
       * doluyor (bkz. google.ts). */
      typeof body.providerEmail === 'string' && body.providerEmail.length > 0
        ? body.providerEmail
        : null,
      Number(body.now ?? Date.now()),
      Number(body.now ?? Date.now()),
    ).run();
    return Response.json({ ok: true });
  }

  /* Alt site istemcisi (Plan 008). Sırrın digest'ini test hesaplıyor ve
   * buraya hazır getiriyor: sır hiç worker'a girmiyor, yani testin kurduğu
   * istemci de gerçek istemci gibi yalnız digest olarak duruyor. */
  if (url.pathname === '/__test/seed-site-client') {
    const clientRowId = String(body.id);
    const uris = Array.isArray(body.redirectUris) ? body.redirectUris : [];
    await env.DB.prepare(`
      INSERT INTO oauth_clients (
        id, client_id, secret_digest, hash_version, label, site_url,
        allowed_scopes, environment, status, created_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'active', ?)
    `).bind(
      clientRowId,
      String(body.clientId),
      String(body.secretDigest),
      String(body.label),
      String(body.siteUrl),
      String(body.allowedScopes),
      String(body.environment ?? 'production'),
      now,
    ).run();
    for (const [index, uri] of uris.entries()) {
      await env.DB.prepare(`
        INSERT INTO oauth_client_redirect_uris (id, client_id, redirect_uri, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(`${clientRowId}:uri:${index}`, clientRowId, String(uri), now).run();
    }
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/site-grant-state') {
    const grants = await env.DB.prepare(`
      SELECT grant_row.id, grant_row.scopes, grant_row.consent_version,
             grant_row.revoked_at, grant_row.last_used_at,
             (SELECT COUNT(*) FROM oauth_site_tokens token
               WHERE token.grant_id = grant_row.id AND token.revoked_at IS NULL) AS live_tokens
      FROM oauth_client_grants grant_row
      JOIN oauth_clients client ON client.id = grant_row.client_id
      WHERE client.client_id = ?
      ORDER BY grant_row.created_at
    `).bind(String(body.clientId)).all();
    return Response.json({ grants: grants.results });
  }

  if (url.pathname === '/__test/set-site-account-status') {
    await env.DB.prepare(`
      UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?
    `).bind(String(body.status), now, String(body.accountId)).run();
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/seed-human-session') {
    await env.DB.prepare(`
      INSERT INTO sessions (
        id, account_id, secret_digest, hash_version, csrf_digest,
        created_at, last_seen_at, idle_expires_at, absolute_expires_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).bind(
      String(body.sessionId),
      String(body.accountId ?? '019f64d2-0109-7644-9a4e-a0d25df888e2'),
      String(body.secretDigest), String(body.csrfDigest), now, now,
      now + 7 * 86400000, now + 30 * 86400000,
    ).run();
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/seed-role-session') {
    const accountId = String(body.accountId);
    const handle = String(body.handle);
    const role = String(body.role);
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO accounts (
          id, handle, handle_normalized, handle_skeleton, display_name, avatar_url,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'active', ?, ?)
      `).bind(accountId, handle, handle.toLowerCase(), handleSkeleton(handle), handle, now, now),
      env.DB.prepare(`
        INSERT INTO account_roles (
          id, account_id, role, granted_by_account_id, granted_at
        ) VALUES (?, ?, ?, NULL, ?)
      `).bind(String(body.roleId), accountId, role, now),
      env.DB.prepare(`
        INSERT INTO sessions (
          id, account_id, secret_digest, hash_version, csrf_digest,
          created_at, last_seen_at, idle_expires_at, absolute_expires_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).bind(
        String(body.sessionId), accountId, String(body.secretDigest),
        String(body.csrfDigest), now, now, now + 7 * 86400000,
        now + 30 * 86400000,
      ),
    ]);
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/seed-closed-account-session') {
    const accountId = String(body.accountId);
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO accounts (
          id, handle, handle_normalized, handle_skeleton, display_name, avatar_url,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'active', ?, ?)
      `).bind(
        accountId, String(body.handle), String(body.handle),
        handleSkeleton(String(body.handle)), String(body.handle), now, now,
      ),
      env.DB.prepare(`
        INSERT INTO sessions (
          id, account_id, secret_digest, hash_version, csrf_digest,
          created_at, last_seen_at, idle_expires_at, absolute_expires_at,
          revoked_at, revoked_reason
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'test_revoked_before_account_close')
      `).bind(
        String(body.sessionId), accountId, String(body.secretDigest), String(body.csrfDigest),
        now, now, now + 7 * 86400000, now + 30 * 86400000, now + 1000,
      ),
      env.DB.prepare(`
        UPDATE accounts SET status = 'closed', updated_at = ? WHERE id = ?
      `).bind(now + 2000, accountId),
    ]);
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/publication-state') {
    const record = await env.DB.prepare(`
      SELECT id, slug, lifecycle_state, current_revision_id, pending_revision_id,
             deleted_at, version FROM records WHERE id = ? OR slug = ? LIMIT 1
    `).bind(String(body.record), String(body.record)).first();
    const revisions = record ? await env.DB.prepare(`
      SELECT id, revision_number, body_markdown, summary, state, published_at
      FROM record_revisions WHERE record_id = ? ORDER BY revision_number
    `).bind((record as { id: string }).id).all() : { results: [] };
    const reviews = record ? await env.DB.prepare(`
      SELECT id, revision_id, status, reviewer_account_id, review_note
      FROM publication_reviews WHERE record_id = ? ORDER BY requested_at
    `).bind((record as { id: string }).id).all() : { results: [] };
    return Response.json({ record, revisions: revisions.results, reviews: reviews.results });
  }

  if (url.pathname === '/__test/publication-evidence') {
    const recordId = String(body.recordId);
    const audits = await env.DB.prepare(`
      SELECT event_type, actor_type, actor_id, metadata_json
      FROM audit_events WHERE subject_type = 'record' AND subject_id = ? ORDER BY sequence
    `).bind(recordId).all();
    const moderation = await env.DB.prepare(`
      SELECT id, action, actor_account_id, reason, reversed_by_action_id, reverses_action_id
      FROM moderation_actions WHERE target_type = 'record' AND target_id = ? ORDER BY created_at, id
    `).bind(recordId).all();
    return Response.json({ audits: audits.results, moderation: moderation.results });
  }

  if (url.pathname === '/__test/usage') {
    const daily = await env.DB.prepare(`
      SELECT day_utc, posts_created, replies_created, write_attempts
      FROM agent_usage_daily WHERE agent_id = ? ORDER BY day_utc
    `).bind(String(body.agentId)).all();
    const hourly = await env.DB.prepare(`
      SELECT hour_utc, posts_created, replies_created
      FROM agent_usage_hourly WHERE agent_id = ? ORDER BY hour_utc
    `).bind(String(body.agentId)).all();
    const throttle = await env.DB.prepare(`
      SELECT last_record_created_at
      FROM agent_publication_throttles WHERE agent_id = ?
    `).bind(String(body.agentId)).first();
    return Response.json({ rows: daily.results, hourly: hourly.results, throttle });
  }

  if (url.pathname === '/__test/set-usage') {
    await env.DB.prepare(`
      INSERT INTO agent_usage_daily (
        agent_id, day_utc, posts_created, replies_created, write_attempts, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, day_utc) DO UPDATE SET
        posts_created = excluded.posts_created,
        replies_created = excluded.replies_created,
        write_attempts = excluded.write_attempts,
        updated_at = excluded.updated_at
    `).bind(
      String(body.agentId), String(body.dayUtc), Number(body.postsCreated ?? 0),
      Number(body.repliesCreated ?? 0), Number(body.writeAttempts ?? 0), now,
    ).run();
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/set-hourly-usage') {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO agent_usage_hourly (
          agent_id, hour_utc, posts_created, replies_created, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_id, hour_utc) DO UPDATE SET
          posts_created = excluded.posts_created,
          replies_created = excluded.replies_created,
          updated_at = excluded.updated_at
      `).bind(
        String(body.agentId), String(body.hourUtc), Number(body.postsCreated ?? 0),
        Number(body.repliesCreated ?? 0), now,
      ),
      env.DB.prepare(`
        DELETE FROM agent_publication_throttles WHERE agent_id = ?
      `).bind(String(body.agentId)),
      env.DB.prepare(`
        INSERT INTO agent_publication_throttles (agent_id, last_record_created_at)
        VALUES (?, ?)
      `).bind(String(body.agentId), Number(body.lastRecordCreatedAt ?? now - 15000)),
    ]);
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/backup-export') {
    return Response.json(await createDynamicBackup(env.DB, now, Boolean(body.includeSessions)));
  }

  if (url.pathname === '/__test/chunked-backup-export') {
    return Response.json(await createChunkedBackup(env.DB, now, Boolean(body.includeSessions)));
  }

  if (url.pathname === '/__test/chunked-backup-restore') {
    try {
      const proof = await restoreChunkedBackup(env.DB, body.backup, {
        revokeSecurity: Boolean(body.revokeSecurity), now,
      });
      return Response.json({ ok: true, proof });
    } catch (error) {
      return Response.json({
        ok: false,
        code: error instanceof Error ? error.message : 'restore_failed',
      }, { status: 400 });
    }
  }

  if (url.pathname === '/__test/r2-backup') {
    const bucket = new MemoryR2();
    const testKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
      .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO backup_runs (id, backup_kind, status, started_at)
        VALUES ('slice5-stale-backup', 'daily', 'running', ?)
      `).bind(now - 31 * 60 * 1000),
      env.DB.prepare(`
        INSERT INTO backup_runs (id, backup_kind, status, started_at)
        VALUES ('slice5-fresh-backup', 'daily', 'running', ?)
      `).bind(now - 60 * 1000),
    ]);
    const result = await runR2Backup({
      ...env,
      BACKUPS: bucket,
      ORBIT_BACKUP_ENABLED: 'true',
      ORBIT_BACKUP_ENCRYPTION_KEY_V1: testKey,
    }, 'daily', now);
    for (let index = 0; index < 16; index += 1) {
      await bucket.put(`orbit-v6/daily/2026-06-${String(index + 1).padStart(2, '0')}-test.json.enc`, '{}');
    }
    const retention = await enforceBackupRetention(bucket);
    const runs = await env.DB.prepare(`
      SELECT status, object_key, manifest_checksum, error_code
      FROM backup_runs WHERE id = ?
    `).bind(result.runId).first();
    const reconciled = await env.DB.prepare(`
      SELECT id, status, error_code, completed_at
      FROM backup_runs
      WHERE id IN ('slice5-stale-backup', 'slice5-fresh-backup')
      ORDER BY id
    `).all();
    return Response.json({
      objectCount: bucket.objects.size,
      retention,
      run: runs,
      reconciled: reconciled.results,
      objectKeyIsSafe: !result.objectKey.includes('nyx') && !result.objectKey.includes('samet'),
      checksumLength: result.objectChecksum.length,
    });
  }

  if (url.pathname === '/__test/backup-restore') {
    try {
      const proof = await restoreDynamicBackup(env.DB, body.backup, {
        revokeSecurity: Boolean(body.revokeSecurity), now,
      });
      return Response.json({ ok: true, proof });
    } catch (error) {
      return Response.json({
        ok: false,
        code: error instanceof Error ? error.message : 'restore_failed',
      }, { status: 400 });
    }
  }

  if (url.pathname === '/__test/backup-counts') {
    const counts = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM accounts) AS accounts,
        (SELECT COUNT(*) FROM accounts WHERE status = 'closed') AS closedAccounts,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM agents) AS agents,
        (SELECT COUNT(*) FROM records) AS records,
        (SELECT COUNT(*) FROM projects) AS projects,
        (SELECT COUNT(*) FROM topics) AS topics,
        (SELECT COUNT(*) FROM backup_restore_validations) AS validations
    `).first();
    const fk = await env.DB.prepare(`PRAGMA foreign_key_check`).all();
    return Response.json({ counts, foreignKeyViolations: fk.results.length });
  }

  if (url.pathname === '/__test/schema-triggers') {
    const triggers = await env.DB.prepare(`
      SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name
    `).all<{ name: string; sql: string }>();
    return Response.json({ triggers: triggers.results });
  }

  if (url.pathname === '/__test/media-objects') {
    return Response.json({ count: mediaBucket.objects.size });
  }

  if (url.pathname === '/__test/media-transform-state') {
    const month = String(body.month ?? new Date(now).toISOString().slice(0, 7));
    const counts = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM media_assets) AS media_assets,
        (SELECT COUNT(*) FROM media_transform_claims WHERE month_utc = ?) AS claims,
        (SELECT COUNT(*) FROM media_transform_results result
          JOIN media_transform_claims claim ON claim.id = result.claim_id
          WHERE claim.month_utc = ?) AS results,
        (SELECT COUNT(*) FROM media_transform_results result
          JOIN media_transform_claims claim ON claim.id = result.claim_id
          WHERE claim.month_utc = ? AND result.status = 'failed') AS failed_results,
        COALESCE((SELECT attempted_count FROM media_transform_usage_monthly WHERE month_utc = ?), 0) AS attempted,
        COALESCE((SELECT succeeded_count FROM media_transform_usage_monthly WHERE month_utc = ?), 0) AS succeeded,
        COALESCE((SELECT failed_count FROM media_transform_usage_monthly WHERE month_utc = ?), 0) AS failed
    `).bind(month, month, month, month, month, month).first();
    return Response.json({ counts, objectCount: mediaBucket.objects.size });
  }

  if (url.pathname === '/__test/media-transform-limit') {
    const month = String(body.month);
    const attempted = Number(body.attempted);
    await env.DB.prepare(`
      INSERT INTO media_transform_usage_monthly (
        month_utc, attempted_count, succeeded_count, failed_count, updated_at
      ) VALUES (?, ?, 0, 0, ?)
      ON CONFLICT(month_utc) DO UPDATE SET
        attempted_count = excluded.attempted_count,
        succeeded_count = 0,
        failed_count = 0,
        updated_at = excluded.updated_at
    `).bind(month, attempted, now).run();
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/media-transform-tamper') {
    const claim = await env.DB.prepare(`
      SELECT id FROM media_transform_claims WHERE status = 'succeeded' LIMIT 1
    `).first<{ id: string }>();
    try {
      await env.DB.prepare(`
        UPDATE media_transform_claims
        SET status = 'failed', error_category = 'images_unknown',
            output_byte_size = NULL, completed_at = ?
        WHERE id = ?
      `).bind(now, claim?.id ?? '').run();
      return Response.json({ rejected: false });
    } catch (error) {
      return Response.json({
        rejected: true,
        code: error instanceof Error && error.message.includes('media_transform_claim_lifecycle_invalid')
          ? 'media_transform_claim_lifecycle_invalid'
          : 'unexpected_error',
      });
    }
  }

  if (url.pathname === '/__test/media-cleanup') {
    return Response.json(await cleanupMedia(
      env,
      new D1MediaRepository(env.DB),
      Number(body.now ?? now),
    ));
  }

  if (url.pathname === '/__test/cleanup') {
    return Response.json(await runIdentityCleanup(env, now));
  }

  /* Giden posta testleri kurulumlarını BURADAN yapıyor, CLI'dan değil.
   * wrangler dev veritabanını açık tutarken dışarıdan yazmaya kalkmak
   * worker'ı ECONNRESET ile düşürüyor; bir kez ödeyerek öğrendim. */
  if (url.pathname === '/__test/seed-email-world') {
    /* Test kendi dünyasını TAMAMEN kuruyor: üç hesap, üç kimlik satırı.
     * Fikstürdeki hesaplara yaslanmayı denedim ve testi boşa çıkardı —
     * onların auth_identities satırı yok, dolayısıyla sorgudaki JOIN
     * zaten eliyordu ve tercih süzgecini bozduğumda test yine geçiyordu.
     *
     *   wants      → adresi var, istiyor   → kuyruğa girmeli
     *   refuses    → adresi var, istemiyor → girmemeli (tercih süzgeci)
     *   no-email   → adresi yok, istiyor   → girmemeli (adres süzgeci)
     */
    const account = (id: string, handle: string) => env.DB.prepare(`
      INSERT OR IGNORE INTO accounts (
        id, handle, handle_normalized, handle_skeleton, display_name, avatar_url,
        status, created_at, updated_at, last_login_at
      ) VALUES (?, ?, ?, ?, ?, NULL, 'active', ?, ?, ?)
    `).bind(id, handle, handle, handleSkeleton(handle), handle, now, now, now);
    const identity = (id: string, accountId: string, providerId: string, email: string | null) =>
      env.DB.prepare(`
        INSERT OR IGNORE INTO auth_identities (
          id, account_id, provider, provider_user_id,
          provider_login_snapshot, provider_email_snapshot, created_at, last_seen_at
        ) VALUES (?, ?, 'google', ?, ?, ?, ?, ?)
      `).bind(id, accountId, providerId, accountId, email, now, now);

    await env.DB.batch([
      env.DB.prepare('DELETE FROM email_deliveries'),
      account('acc-wants', 'posta-isteyen'),
      account('acc-refuses', 'posta-istemeyen'),
      account('acc-no-email', 'adressiz'),
      identity('ident-wants', 'acc-wants', '900000001', null),
      identity('ident-refuses', 'acc-refuses', '900000002', null),
      identity('ident-no-email', 'acc-no-email', '900000003', null),
      /* Önce herkesi adressiz yap: fikstürde adres taşıyan bir hesap
       * kalırsa beklenen sayı tutmaz ve testin ne ölçtüğü belirsizleşir. */
      env.DB.prepare('UPDATE auth_identities SET provider_email_snapshot = NULL'),
      env.DB.prepare('UPDATE accounts SET announcement_emails_enabled = 1'),
      env.DB.prepare("UPDATE auth_identities SET provider_email_snapshot = 'alan@example.test' WHERE account_id = 'acc-wants'"),
      env.DB.prepare("UPDATE auth_identities SET provider_email_snapshot = 'istemeyen@example.test' WHERE account_id = 'acc-refuses'"),
      env.DB.prepare("UPDATE accounts SET announcement_emails_enabled = 0 WHERE id = 'acc-refuses'"),
    ]);
    return Response.json({ wants: 'acc-wants', refuses: 'acc-refuses', withoutEmail: 'acc-no-email' });
  }

  /* Bir fikstür hesabına bildirim adresi verir. Yayın reddi testinin
   * ihtiyacı bu: reddi veren moderatör ile ajanın sponsoru farklı olmalı
   * ve sponsorun adresi bulunmalı, yoksa kuyruk boş kalır ve test hiçbir
   * şey ölçmez. */
  if (url.pathname === '/__test/set-account-email') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM email_deliveries'),
      env.DB.prepare(`
        INSERT INTO auth_identities (
          id, account_id, provider, provider_user_id,
          provider_login_snapshot, provider_email_snapshot, created_at, last_seen_at
        ) VALUES (?, ?, 'google', ?, ?, ?, ?, ?)
        ON CONFLICT (account_id, provider) DO UPDATE SET provider_email_snapshot = excluded.provider_email_snapshot
      `).bind(
        `ident-${String(body.accountId)}`, String(body.accountId), `95${String(body.accountId).slice(-7)}`,
        String(body.accountId), String(body.email), now, now,
      ),
    ]);
    return Response.json({ ok: true });
  }

  /* Duyuru alıcı tavanını ölçmek için kalabalık bir abone listesi. Tavan
   * altmış kişi; onu elle altmış bir hesap yazarak sınamak, sayı değiştiği
   * gün güncellenmesi gereken bir fikstür demekti. */
  if (url.pathname === '/__test/seed-email-recipients') {
    const count = Number(body.count ?? 0);
    const pool = Number(body.pool ?? 61);
    /* Hesaplar silinmiyor, sadece susturuluyor. Silmek denendi ve olmadı:
     * hesap açılışı bir tetikleyiciyle avatar yükleme politikası yazıyor ve
     * başka bir tetikleyici o politikanın silinmesini yasaklıyor. Yani
     * fikstür havuzu bir kez kuruluyor, testler yalnız kimin duyuru postası
     * aldığını değiştiriyor — zaten ölçtüğümüz şey de bu. */
    const statements = [
      env.DB.prepare('DELETE FROM email_deliveries'),
      env.DB.prepare('UPDATE accounts SET announcement_emails_enabled = 0'),
    ];
    for (let index = 0; index < pool; index += 1) {
      const id = `bulk-${index}`;
      /* Handle artık id'nin aynısı olamıyor. `bulk-1` ve `bulk-11` ayrı
       * hesaplar ama iskeletleri aynı: tire atılıyor, `1` `i`ye eşleniyor ve
       * ardışık tekrar daraltılıyor — ikisi de `bulki`. 0039 iskeleti tekil
       * yaptığı için fikstür kendi içinde çakışıyordu.
       *
       * Sayıyı harfe çeviren iki ayrık alfabe: ilk harf birinciden, ikinci
       * harf ikinciden geliyor, yani yan yana iki aynı harf hiç doğmuyor ve
       * daraltma bu adları hiç değiştirmiyor. `k` ilk alfabede yok, çünkü
       * `bulk`in son harfiyle birleşip `bulkk` → `bulk` olurdu. */
      const first = 'abcdefghijlm';
      const second = 'nopqrstuvwxyz';
      const handle = `bulk${first[index % first.length]}${
        second[Math.floor(index / first.length) % second.length]}`;
      statements.push(env.DB.prepare(`
        INSERT INTO accounts (
          id, handle, handle_normalized, handle_skeleton, display_name, avatar_url,
          status, created_at, updated_at, last_login_at, announcement_emails_enabled
        ) VALUES (?, ?, ?, ?, ?, NULL, 'active', ?, ?, ?, 0)
        ON CONFLICT (id) DO NOTHING
      `).bind(id, handle, handle, handleSkeleton(handle), handle, now, now, now));
      statements.push(env.DB.prepare(`
        INSERT INTO auth_identities (
          id, account_id, provider, provider_user_id,
          provider_login_snapshot, provider_email_snapshot, created_at, last_seen_at
        ) VALUES (?, ?, 'google', ?, ?, ?, ?, ?)
        ON CONFLICT (account_id, provider) DO UPDATE SET
          provider_email_snapshot = excluded.provider_email_snapshot
      `).bind(`ident-${id}`, id, `8000${String(index).padStart(5, '0')}`, id, `${id}@example.test`, now, now));
    }
    await env.DB.batch(statements);
    /* Havuzun `count` kadarı postayı alıyor, kalanı almıyor. count 0 ise
     * fikstür bırakılıyor demektir: fikstür hesapları susuyor, gerçek
     * hesaplar varsayılan hâline (açık) dönüyor. Bunu yapmazsak sonraki
     * testler, duyuru postalarını kimin kapattığını bilmeyen bir dünyada
     * çalışırdı. */
    await env.DB.prepare(
      count > 0
        ? `UPDATE accounts SET announcement_emails_enabled = 1
           WHERE id IN (SELECT id FROM accounts WHERE id LIKE 'bulk-%' ORDER BY id LIMIT ?)`
        : `UPDATE accounts SET announcement_emails_enabled = 1
           WHERE id NOT LIKE 'bulk-%' AND ? IS NOT NULL`,
    ).bind(count).run();
    return Response.json({ seeded: count });
  }

  /* Kuyruğu sahte bir göndericiyle boşaltır ve KİMİN hangi sırayla
   * denendiğini geri verir. Sıra testin asıl konusu: bütçe sonluyken hangi
   * postanın önce gittiği, bütçenin kendisi kadar önemli. */
  if (url.pathname === '/__test/email-drain') {
    const attempted: Array<{ to: string; subject: string }> = [];
    const result = await drainEmailQueue(env, now, {
      async send(message) {
        attempted.push({ to: message.to, subject: message.subject });
        return { outcome: 'sent' };
      },
    });
    return Response.json({ result, attempted });
  }

  /* Kuyruğa elle bir posta yazar. Sıra testinin ihtiyacı bu: bir güvenlik
   * bildirimini duyurulardan SONRA yazabilmek, yani yaşça en geride ama
   * türce en önde bir satır kurabilmek. */
  if (url.pathname === '/__test/queue-email') {
    await env.DB.prepare(`
      INSERT INTO email_deliveries (
        id, account_id, recipient, kind, subject, body_text,
        status, attempts, created_at, subject_ref
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).bind(
      String(body.id), String(body.accountId), String(body.recipient), String(body.kind),
      String(body.subject), 'govde', Number(body.createdAt ?? now), String(body.id),
    ).run();
    return Response.json({ ok: true });
  }

  /* Bütçeyi doldurulmuş göstermek. Gerçekten doksan posta göndermek yerine
   * denenmiş satırlar yazıyoruz: ölçülen şey sayacın kendisi. */
  if (url.pathname === '/__test/spend-email-budget') {
    const count = Number(body.count ?? 0);
    const statements = [];
    for (let index = 0; index < count; index += 1) {
      statements.push(env.DB.prepare(`
        INSERT INTO email_deliveries (
          id, account_id, recipient, kind, subject, body_text,
          status, attempts, created_at, sent_at, last_attempt_at, subject_ref
        ) VALUES (?, ?, ?, 'announcement', 'gecmis', 'gecmis', 'sent', 1, ?, ?, ?, ?)
      `).bind(
        `spent-${index}`, String(body.accountId), 'gecmis@example.test',
        now - 1000, now - 1000, Number(body.attemptedAt ?? now - 1000), `spent:${index}`,
      ));
    }
    if (statements.length > 0) await env.DB.batch(statements);
    return Response.json({ spent: count });
  }

  if (url.pathname === '/__test/email-deliveries') {
    const rows = await env.DB.prepare(`
      SELECT recipient, kind, status, subject FROM email_deliveries ORDER BY created_at ASC
    `).all<{ recipient: string; kind: string; status: string; subject: string }>();
    return Response.json({ deliveries: rows.results ?? [] });
  }

  if (url.pathname === '/__test/seed-idempotency') {
    await env.DB.prepare(`
      INSERT INTO idempotency_keys (
        id, principal_type, principal_id, key_digest, operation,
        request_digest, response_status, created_at, expires_at
      ) VALUES (?, 'account',
        '019f64d2-0109-7644-9a4e-a0d25df888e2',
        ?, 'test.cleanup', ?, 201, ?, ?)
    `).bind(
      String(body.id),
      String(body.id),
      String(body.id),
      now - 1000,
      now - 1,
    ).run();
    return Response.json({ ok: true });
  }

  if (url.pathname === '/__test/seed-referenced-idempotency') {
    try {
      const id = String(body.id);
      const accountId = '019f64d2-0109-7644-9a4e-a0d25df888e2';
      const monthUtc = new Date(now).toISOString().slice(0, 7);
      const usageDay = new Date(now).toISOString().slice(0, 10);
      await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO idempotency_keys (
          id, principal_type, principal_id, key_digest, operation,
          request_digest, response_status, resource_type, resource_id,
          created_at, expires_at, response_json, state, completed_at
        ) VALUES (?, 'account', ?, ?, 'POST /v1/account/avatar', ?, 0,
          'media_upload', NULL, ?, ?, '{}', 'in_progress', NULL)
      `).bind(id, accountId, id, id, now - 1000, now - 1),
      env.DB.prepare(`
        INSERT INTO media_transform_usage_monthly (
          month_utc, attempted_count, succeeded_count, failed_count, updated_at
        ) VALUES (?, 0, 0, 0, ?)
        ON CONFLICT(month_utc) DO NOTHING
      `).bind(monthUtc, now),
      env.DB.prepare(`
        INSERT INTO media_transform_claims (
          id, month_utc, profile, actor_type, actor_id,
          source_content_type, source_byte_size, status, created_at,
          usage_day, target_type, target_id, idempotency_id
        ) VALUES (?, ?, 'avatar', 'account', ?, 'image/png', 128,
          'reserved', ?, ?, 'account', ?, NULL)
      `).bind(`${id}-claim`, monthUtc, accountId, now, usageDay, accountId),
      ]);
      await env.DB.prepare(`
        UPDATE media_transform_claims SET idempotency_id = ? WHERE id = ?
      `).bind(id, `${id}-claim`).run();
      await env.DB.prepare(`
        UPDATE idempotency_keys
        SET state = 'completed', response_status = 201,
            response_json = '{"ok":true}', completed_at = ?
        WHERE id = ?
      `).bind(now, id).run();
      const claim = await env.DB.prepare(`
        SELECT idempotency_id FROM media_transform_claims WHERE id = ?
      `).bind(`${id}-claim`).first<{ idempotency_id: string | null }>();
      return Response.json({ ok: true, idempotencyId: claim?.idempotency_id ?? null });
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message : 'seed_referenced_idempotency_failed',
      }, { status: 500 });
    }
  }

  return Response.json({ error: 'not_found' }, { status: 404 });
}

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    /* Davet kapısı bir bağlama değeri ve bağlama değerleri dağıtım başına
     * sabit. Testin İKİ hâli birden ölçmesi gerekiyor: kapı kapalıyken
     * davetsiz kaydın reddedildiğini, açıkken kabul edildiğini. Tek bir
     * yapılandırma değeriyle bunlardan yalnız biri ölçülebilirdi ve
     * ölçülmeyen hâl, kapıyı açtığımız gün ilk kez çalışacaktı. */
    const extended = {
      ...env,
      MEDIA: mediaBucket,
      ORBIT_OPEN_REGISTRATION: request.headers.get('x-test-open-registration')
        ?? env.ORBIT_OPEN_REGISTRATION,
    };
    const testResponse = await testRoute(request, extended);
    if (testResponse) return testResponse;
    const nowHeader = request.headers.get('x-test-now');
    return await handleWorkerRequest(request, extended, {
      fetch: mockProviderFetch,
      now: nowHeader ? () => Number(nowHeader) : undefined,
    });
  },
};
