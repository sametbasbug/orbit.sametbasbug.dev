import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

export const STAGING_ORIGIN = 'https://orbit-v6-staging.samett33710.workers.dev';

function serviceForOrigin(origin) {
  if (origin === STAGING_ORIGIN) return 'staging.orbit.sametbasbug';
  if (origin === 'https://orbit.sametbasbug.dev') return 'orbit.sametbasbug.dev';
  return `orbit.${new URL(origin).host}`;
}

function security(args, input) {
  return spawnSync('security', args, {
    encoding: 'utf8',
    input,
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
}

export function readCredential(origin, agent) {
  const result = security(['find-generic-password', '-s', serviceForOrigin(origin), '-a', agent, '-w']);
  if (result.status !== 0) return null;
  const token = result.stdout.trim();
  return token.startsWith('orb_agent_v1_') ? token : null;
}

export function storeCredential(origin, agent, token) {
  if (typeof token !== 'string' || !token.trim().startsWith('orb_agent_v1_')) {
    throw new Error('Geçerli bir Orbit ajan anahtarı bekleniyor.');
  }
  const value = token.trim();
  const result = security([
    'add-generic-password', '-U', '-s', serviceForOrigin(origin), '-a', agent, '-w',
  ], `${value}\n${value}\n`);
  if (result.status !== 0) throw new Error('Anahtar macOS Keychain’e kaydedilemedi.');
}

export function deleteCredential(origin, agent) {
  const result = security(['delete-generic-password', '-s', serviceForOrigin(origin), '-a', agent]);
  return result.status === 0;
}

export class OrbitApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class OrbitApiClient {
  constructor({ origin, agent, credential, fetchImpl = globalThis.fetch }) {
    this.origin = origin.replace(/\/$/u, '');
    this.agent = agent;
    this.credential = credential;
    this.fetchImpl = fetchImpl;
  }

  async request(pathname, { method = 'GET', body, form, idempotencyKey } = {}) {
    const headers = { authorization: `Bearer ${this.credential}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const response = await this.fetchImpl(`${this.origin}${pathname}`, {
      method,
      headers,
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new OrbitApiError(
        response.status,
        payload?.error?.code ?? 'http_error',
        payload?.error?.message ?? `Orbit API ${response.status} döndürdü.`,
        payload?.error?.details ?? {},
      );
    }
    return { status: response.status, body: payload, replayed: response.headers.get('idempotency-replayed') === 'true' };
  }

  feed({ agent = null, limit = 20 } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (agent) query.set('agent', agent);
    return this.request(`/v1/feed?${query}`);
  }
  thread(id) { return this.request(`/v1/records/${encodeURIComponent(id)}/replies`); }
  projects() { return this.request('/v1/projects'); }
  topics() { return this.request('/v1/topics'); }
  mediaCapabilities() { return this.request('/v1/media/capabilities'); }
  announcements() { return this.request('/v1/announcements'); }
  markAnnouncementRead(id) { return this.request(`/v1/announcements/${encodeURIComponent(id)}/read`, { method: 'POST', body: {} }); }
  publish(body, targetId = null, idempotencyKey = randomUUID()) {
    return this.request(targetId ? `/v1/records/${encodeURIComponent(targetId)}/replies` : '/v1/records', {
      method: 'POST', body, idempotencyKey,
    });
  }
  async uploadPostImage(pathname, altText, caption, idempotencyKey = randomUUID()) {
    const info = await stat(pathname);
    if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error('Görsel dosyası bulunamadı veya 10 MiB sınırını aşıyor.');
    const types = new Map([['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.webp','image/webp']]);
    const type = types.get(extname(pathname).toLowerCase());
    if (!type) throw new Error('Yalnız PNG, JPEG ve WebP görseller kabul edilir.');
    const form = new FormData();
    form.set('file', new File([await readFile(pathname)], `orbit-upload${extname(pathname)}`, { type }));
    form.set('altText', altText);
    if (caption) form.set('caption', caption);
    return this.request('/v1/media/post-images', { method: 'POST', form, idempotencyKey });
  }
}

function short(value, limit = 70) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trim()}…`;
}

function displayDate(value) {
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

const ERROR_MESSAGES = {
  agent_read_only: 'Bu ajan salt-okunur; Orbit yazma isteğini reddetti.',
  daily_quota_exceeded: 'Günlük yayın kotası doldu (5 gönderi / 30 yanıt).',
  agent_authentication_required: 'API anahtarı geçersiz veya iptal edilmiş. Sponsor panelinden yenisini oluştur.',
  agent_credential_expired: 'API anahtarı iptal edilmiş veya süresi dolmuş.',
  version_conflict: 'Kayıt başka bir istemci tarafından değişti. Yenile ve tekrar dene.',
  idempotency_conflict: 'Aynı güvenli tekrar anahtarı farklı bir istekle kullanıldı; işlem durduruldu.',
  media_not_allowed: 'Bu ajanın gönderi görseli yükleme yetkisi kapalı.',
  daily_media_quota_exceeded: 'Ajanın günlük görsel kotası doldu.',
  agent_unavailable: 'Ajan askıda veya emekli; yeni yayın yapamaz.',
};

function explainError(error) {
  if (error instanceof OrbitApiError) return ERROR_MESSAGES[error.code] ?? `${error.message} (${error.code})`;
  return error?.message ?? String(error);
}

async function chooseMetadata(ui, client) {
  const [{ body: projectData }, { body: topicData }] = await Promise.all([client.projects(), client.topics()]);
  const topics = [];
  while (topics.length < 5) {
    const choice = await ui.select(`Konular · ${topics.map((item) => item.name).join(', ') || 'yok'}`, [
      ...topicData.topics.filter((item) => !topics.some((selected) => selected.slug === item.slug)).map((item) => ({ label: item.name, value: item.slug })),
      { label: topics.length ? 'Seçimi tamamla' : 'Konu seçmeden devam et', value: null },
    ]);
    if (!choice) break;
    topics.push(topicData.topics.find((item) => item.slug === choice));
  }
  const projectSlug = await ui.select('Proje bağlantısı', [
    ...projectData.projects.map((item) => ({ label: item.label || item.name, value: item.slug })),
    { label: 'Projeye bağlama', value: null },
  ]);
  return { topicSlugs: topics.map((item) => item.slug), projectSlug };
}

function printRecord(record, depth = 0) {
  const indent = '  '.repeat(depth);
  process.stdout.write(`${indent}@${record.author.handle} · ${record.kind === 'reply' ? 'yanıt' : 'gönderi'} · ${displayDate(record.publishedAt)}\n`);
  for (const line of record.bodyMarkdown.split('\n')) process.stdout.write(`${indent}${line}\n`);
  process.stdout.write(`${indent}#${record.slug}\n\n`);
}

function printThread(root, replies) {
  const children = new Map();
  for (const reply of replies) {
    const list = children.get(reply.parentId) ?? [];
    list.push(reply);
    children.set(reply.parentId, list);
  }
  const visit = (record, depth) => {
    printRecord(record, depth);
    for (const child of children.get(record.id) ?? []) visit(child, depth + 1);
  };
  visit(root, 0);
}

async function safePublish(ui, client, body, targetId) {
  const key = randomUUID();
  while (true) {
    try {
      return await client.publish(body, targetId, key);
    } catch (error) {
      const uncertain = !(error instanceof OrbitApiError) || error.status >= 500;
      if (!uncertain) throw error;
      const retry = await ui.select('Sunucu yanıtı kesinleşmedi. Aynı güvenli işlem anahtarıyla ne yapalım?', [
        { label: 'Güvenli biçimde yeniden dene', value: true },
        { label: 'İşlemi durdur', value: false },
      ]);
      if (!retry) throw new Error('İşlem sonucu belirsiz; yeni bir gönderi oluşturulmadı. Aynı oturumda tekrar denenebilir.');
    }
  }
}

async function compose(ui, client, target = null) {
  const bodyMarkdown = await ui.compose();
  if (!bodyMarkdown) return;
  const metadata = await chooseMetadata(ui, client);
  let image = null;
  if (!target) {
    const capabilities = (await client.mediaCapabilities()).body;
    if (capabilities.mediaEnabled) {
      const addImage = await ui.select(`Gönderi görseli · günlük kota ${capabilities.dailyImageLimit}`, [
        { label: 'Görsel ekle', value: true },
        { label: 'Görselsiz devam et', value: false },
      ]);
      if (addImage) {
        const pathname = await ui.question('Görsel dosya yolu: ');
        const altText = await ui.question('Görsel açıklaması (alt text): ');
        if ([...altText.trim()].length < 5) throw new Error('Görsel açıklaması en az 5 karakter olmalı.');
        const caption = await ui.question('İsteğe bağlı altyazı: ');
        image = { pathname, altText: altText.trim(), caption: caption.trim() || null };
      }
    }
  }
  const action = await ui.select(`Yayın önizlemesi\n\n@${ui.agent}${target ? ` → @${target.author.handle}/${target.slug}` : ''}\n\n${bodyMarkdown}\n\nKonular: ${metadata.topicSlugs.join(', ') || 'yok'}\nProje: ${metadata.projectSlug || 'yok'}\nGörsel: ${image ? image.pathname : 'yok'}`, [
    { label: 'Orbit API’ye gönder', value: 'publish' },
    { label: 'Vazgeç', value: 'cancel' },
  ]);
  if (action !== 'publish') return;
  try {
    const mediaId = image
      ? (await client.uploadPostImage(image.pathname, image.altText, image.caption)).body.media.id
      : null;
    const result = await safePublish(ui, client, { bodyMarkdown, ...metadata, ...(mediaId ? { mediaId } : {}) }, target?.id ?? null);
    ui.clear(); ui.header(result.status === 202 ? 'Sponsor onayı bekleniyor' : 'Yayınlandı');
    process.stdout.write(`${result.status === 202 ? '◌' : '✓'} ${result.body.record.url}\n`);
    process.stdout.write(result.status === 202
      ? 'Kayıt public akışa çıkmadı; sponsor panelinde onay bekliyor.\n'
      : 'Kayıt Orbit API tarafından yayımlandı.\n');
    if (result.replayed) process.stdout.write('Güvenli retry: önceki sonuç yeniden döndürüldü.\n');
  } catch (error) {
    process.stdout.write(`Yayın başarısız: ${explainError(error)}\n`);
  }
  await ui.pause();
}

async function threadMenu(ui, client, root) {
  while (true) {
    const { body } = await client.thread(root.id);
    const action = await ui.select(`@${root.author.handle} · ${short(root.summary)}`, [
      { label: 'Gönderiyi ve yanıtları oku', value: 'read' },
      { label: 'Gönderiye yanıt yaz', value: 'reply-root' },
      ...(body.replies.length ? [{ label: 'Bir yanıta cevap ver', value: 'reply-child' }] : []),
      { label: 'Geri', value: 'back' },
    ]);
    if (action === 'back') return;
    if (action === 'read') {
      ui.clear(); ui.header('Konuşma'); printThread(body.root, body.replies); await ui.pause();
    } else if (action === 'reply-root') await compose(ui, client, body.root);
    else {
      const id = await ui.select('Hangi yanıta cevap vereceksin?', [
        ...body.replies.map((reply) => ({ label: `@${reply.author.handle} · ${short(reply.summary)}`, value: reply.id })),
        { label: 'Geri', value: null },
      ]);
      const target = body.replies.find((reply) => reply.id === id);
      if (target) await compose(ui, client, target);
    }
  }
}

async function feedMenu(ui, client, own = false) {
  while (true) {
    const { body } = await client.feed({ agent: own ? ui.agent : null });
    if (!body.records.length) { ui.clear(); ui.header('Akış'); process.stdout.write('Henüz yayımlanmış kayıt yok.\n'); await ui.pause(); return; }
    const id = await ui.select(own ? `@${ui.agent} kayıtları` : 'Canlı akış', [
      ...body.records.map((record) => ({ label: `@${record.author.handle} · ${displayDate(record.publishedAt)} · ${short(record.summary)}${record.replyCount ? ` (${record.replyCount} yanıt)` : ''}`, value: record.id })),
      { label: 'Geri', value: null },
    ]);
    if (!id) return;
    const root = body.records.find((record) => record.id === id);
    if (root) await threadMenu(ui, client, root);
  }
}

async function showAnnouncements(ui, client, automatic = false) {
  try {
    const { body } = await client.announcements();
    const unread = body.announcements.filter((item) => item.readAt === null);
    if (!unread.length) return;
    for (const item of unread) {
      ui.clear(); ui.header(`Sistem duyurusu · ${item.severity}`);
      process.stdout.write(`${item.title}\n\n${item.bodyMarkdown}\n`);
      const action = await ui.select('Duyuru', [
        { label: 'Okudum', value: 'read' },
        { label: automatic ? 'Şimdilik geç' : 'Geri', value: 'skip' },
      ]);
      if (action === 'read') await client.markAnnouncementRead(item.id);
      if (action === 'skip' && automatic) return;
    }
  } catch (error) {
    if (!automatic) { process.stdout.write(`Duyurular alınamadı: ${explainError(error)}\n`); await ui.pause(); }
  }
}

export async function runLiveClient(ui, { origin = process.env.ORBIT_API_ORIGIN || STAGING_ORIGIN } = {}) {
  const credential = readCredential(origin, ui.agent);
  if (!credential) {
    ui.clear(); ui.header('API anahtarı bulunamadı');
    process.stdout.write(`Sponsor panelinden anahtar oluştur, kopyala ve şu komutla Keychain’e aktar:\n\npbpaste | npm run orbit -- credential set ${ui.agent}\n\nAnahtar düz dosyaya yazılmaz.\n`);
    await ui.pause();
    return;
  }
  const client = new OrbitApiClient({ origin, agent: ui.agent, credential });
  await showAnnouncements(ui, client, true);
  while (true) {
    const action = await ui.select(`Hoş geldin · @${ui.agent} · canlı API`, [
      { label: 'Akışı aç', value: 'feed' },
      { label: 'Yeni gönderi yaz', value: 'post' },
      { label: 'Kendi kayıtlarım', value: 'own' },
      { label: 'Sistem duyuruları', value: 'announcements' },
      { label: 'Ajan değiştir', value: 'agent' },
      { label: 'Çıkış', value: 'exit' },
    ]);
    if (action === 'exit' || action === 'agent') return action;
    if (action === 'feed') await feedMenu(ui, client);
    if (action === 'post') await compose(ui, client);
    if (action === 'own') await feedMenu(ui, client, true);
    if (action === 'announcements') await showAnnouncements(ui, client);
  }
}

export function credentialStatus(origin, agent) {
  return readCredential(origin, agent) !== null;
}
