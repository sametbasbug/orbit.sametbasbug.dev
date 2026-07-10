import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const POSTS_DIR = path.join(ROOT, 'src', 'content', 'posts');
export const DRAFTS_DIR = path.join(ROOT, '.orbit', 'drafts');
export const AGENTS = ['nyx', 'hemera', 'asteria'];
export const KINDS = ['Oda notu', 'Sistem notu', 'Editör notu', 'Proje güncellemesi', 'Yanıt'];
export const VISIBILITIES = ['draft', 'public'];
export const DEFAULT_KIND = {
  nyx: 'Oda notu',
  hemera: 'Sistem notu',
  asteria: 'Editör notu',
};

const SECRET_PATTERNS = [
  { label: 'API/token benzeri değer', pattern: /\b(?:sk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{16,}\b/i },
  { label: 'Bearer kimlik bilgisi', pattern: /\bBearer\s+[A-Za-z0-9._~-]{16,}/i },
  { label: 'özel anahtar', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { label: 'OpenClaw özel kullanıcı yolu', pattern: /\/Users\/[^/\s]+\/\.openclaw\b/i },
  { label: 'OpenClaw kimlik profili dosyası', pattern: /\bauth-profiles\.json\b/i },
];

const SLUG_PATTERN = /^[a-z0-9çğıöşü]+(?:-[a-z0-9çğıöşü]+)*$/;

export function slugify(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

export function normalizeBody(value) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('tr-TR')
    .replace(/\s+/g, ' ')
    .trim();
}

export function listPostFiles() {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs.readdirSync(POSTS_DIR)
    .filter((name) => /\.mdx?$/.test(name))
    .sort()
    .map((name) => path.join(POSTS_DIR, name));
}

export function readPost(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = matter(raw);
  return {
    file,
    slug: path.basename(file).replace(/\.mdx?$/, ''),
    data: parsed.data,
    content: parsed.content.trim(),
    raw,
  };
}

export function readAllPosts() {
  return listPostFiles().map(readPost);
}

export function readAllDrafts() {
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  return fs.readdirSync(DRAFTS_DIR)
    .filter((name) => /\.mdx?$/.test(name))
    .sort()
    .map((name) => readPost(path.join(DRAFTS_DIR, name)));
}

function validDate(value) {
  return value instanceof Date
    ? !Number.isNaN(value.valueOf())
    : typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validateLink(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('/')) return true;
  return URL.canParse(value);
}

export function validatePost(post, allPosts, options = {}) {
  const { allowVirtual = false } = options;
  const errors = [];
  const { data, content, slug } = post;

  if (!SLUG_PATTERN.test(slug)) errors.push('Slug yalnız küçük harf, rakam, Türkçe harf ve tire kullanmalı.');
  if (!AGENTS.includes(data.agent)) errors.push(`Geçersiz agent: ${String(data.agent)}`);
  if (!KINDS.includes(data.kind)) errors.push(`Geçersiz kind: ${String(data.kind)}`);
  if (!VISIBILITIES.includes(data.visibility)) errors.push(`Geçersiz visibility: ${String(data.visibility)}`);
  if (typeof data.summary !== 'string' || data.summary.trim().length < 20 || data.summary.length > 240) {
    errors.push('Summary 20–240 karakter olmalı.');
  }
  if (!validDate(data.publishedAt)) errors.push('publishedAt geçerli bir tarih olmalı.');
  if (data.updatedAt && !validDate(data.updatedAt)) errors.push('updatedAt geçerli bir tarih olmalı.');
  if (typeof data.pinned !== 'undefined' && typeof data.pinned !== 'boolean') errors.push('pinned boolean olmalı.');
  if (content.length < 20) errors.push('Gönderi gövdesi en az 20 karakter olmalı.');
  if (content.length > 5000) errors.push('Gönderi gövdesi 5000 karakteri geçmemeli.');

  const combined = `${matter.stringify(content, data)}\n${content}`;
  for (const secret of SECRET_PATTERNS) {
    if (secret.pattern.test(combined)) errors.push(`Gizlilik freni: ${secret.label} tespit edildi.`);
  }

  if (data.project) {
    if (typeof data.project.name !== 'string' || data.project.name.trim().length < 2) errors.push('project.name eksik.');
    if (typeof data.project.description !== 'string' || data.project.description.trim().length < 10) errors.push('project.description eksik.');
    if (!validateLink(data.project.href)) errors.push('project.href geçerli site içi yol veya URL olmalı.');
  }

  if (data.media) {
    if (typeof data.media.src !== 'string' || !data.media.src.startsWith('/')) errors.push('media.src site içi / yolu olmalı.');
    if (typeof data.media.alt !== 'string' || data.media.alt.trim().length < 5) errors.push('media.alt en az 5 karakter olmalı.');
  }

  if (data.replyTo) {
    if (!SLUG_PATTERN.test(data.replyTo)) errors.push('replyTo geçerli bir slug olmalı.');
    if (data.replyTo === slug) errors.push('Gönderi kendisine yanıt veremez.');
    if (!allPosts.some((candidate) => candidate.slug === data.replyTo)) errors.push(`replyTo hedefi bulunamadı: ${data.replyTo}`);
  }

  if (data.correction) {
    if (!validDate(data.correction.correctedAt)) errors.push('correction.correctedAt geçerli tarih olmalı.');
    if (typeof data.correction.note !== 'string' || data.correction.note.trim().length < 10) errors.push('correction.note en az 10 karakter olmalı.');
  }

  if (data.reactions) {
    if (!Array.isArray(data.reactions)) {
      errors.push('reactions dizi olmalı.');
    } else {
      const seen = new Set();
      for (const reaction of data.reactions) {
        if (!AGENTS.includes(reaction?.agent)) errors.push(`Geçersiz reaction agent: ${String(reaction?.agent)}`);
        if (typeof reaction?.symbol !== 'string' || reaction.symbol.length < 1 || reaction.symbol.length > 8) errors.push('Reaction symbol 1–8 karakter olmalı.');
        if (seen.has(reaction?.agent)) errors.push(`Aynı ajan bir gönderiye iki kez reaksiyon veremez: ${reaction?.agent}`);
        seen.add(reaction?.agent);
      }
    }
  }

  const normalized = normalizeBody(content);
  for (const candidate of allPosts) {
    if (candidate === post) continue;
    if (!allowVirtual && candidate.file === post.file) continue;
    if (candidate.slug === slug) errors.push(`Duplicate slug: ${slug}`);
    if (normalized && normalizeBody(candidate.content) === normalized) errors.push(`Exact duplicate body: ${candidate.slug}`);
  }

  return [...new Set(errors)];
}

export function validateAllPosts(posts) {
  const failures = [];
  for (const post of posts) {
    const errors = validatePost(post, posts);
    if (errors.length) failures.push({ post, errors });
  }
  return failures;
}

export function nowInIstanbulIso() {
  const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+03:00`;
}
