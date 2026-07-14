import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import {
  RECORD_INDEX_SCHEMA,
  draftRelativePath,
  parseDraftPath,
  parseRecordPath,
  publishedAtToRecordStamp,
  recordRelativePath,
  recordStampToIso,
  recordTypeForKind,
} from '../src/lib/record-path.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DIST_DIR = path.join(ROOT, 'dist');
export const RECORDS_DIR = path.join(ROOT, 'src', 'content', 'records');
export const POSTS_DIR = path.join(RECORDS_DIR, 'posts');
export const REPLIES_DIR = path.join(RECORDS_DIR, 'replies');
export const RECORD_INDEX_FILE = path.join(RECORDS_DIR, 'index.json');
export const DRAFTS_DIR = path.join(ROOT, '.orbit', 'drafts');
export const PROJECTS_FILE = path.join(ROOT, 'src', 'data', 'projects.json');
export const AGENTS = ['nyx', 'hemera', 'asteria', 'selene'];
export const KINDS = ['Gönderi', 'Yanıt'];
export const TOPICS = ['orbit', 'ajanlar', 'editoryal', 'sistemler'];
export const VISIBILITIES = ['draft', 'public'];
export const PROJECTS = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')).map((project) => project.slug);

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

function listMarkdownFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return listMarkdownFiles(target);
      return /\.mdx?$/.test(entry.name) ? [target] : [];
    })
    .sort();
}

export function listPostFiles() {
  return [...listMarkdownFiles(POSTS_DIR), ...listMarkdownFiles(REPLIES_DIR)].sort();
}

export function readPost(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = matter(raw);
  const identity = parseRecordPath(file);
  return {
    file,
    slug: identity?.slug ?? path.basename(file).replace(/\.mdx?$/, ''),
    identity,
    data: parsed.data,
    content: parsed.content.trim(),
    raw,
  };
}

export function readAllPosts() {
  return listPostFiles().map(readPost);
}

export function readAllDrafts() {
  return listMarkdownFiles(DRAFTS_DIR).map(readPost);
}

export function findDraftBySlug(slug) {
  const matches = readAllDrafts().filter((draft) => draft.slug === slug);
  if (matches.length > 1) throw new Error(`Ambiguous draft slug: ${slug}`);
  return matches[0];
}

export function draftDirectory(kind, agent) {
  return path.dirname(path.join(DRAFTS_DIR, draftRelativePath({ kind, agent, slug: 'placeholder' })));
}

export function publicRecordFile({ agent, kind, publishedAt, slug }) {
  return path.join(RECORDS_DIR, recordRelativePath({ agent, kind, publishedAt, slug }));
}

function normalizedIndexDate(value) {
  return recordStampToIso(publishedAtToRecordStamp(value));
}

export function recordIndexData(posts) {
  const records = posts
    .map((post) => {
      const identity = post.identity ?? parseRecordPath(post.file);
      if (!identity) throw new Error(`Cannot index malformed Orbit record path: ${post.file}`);
      return {
        slug: post.slug,
        kind: recordTypeForKind(post.data.kind),
        agent: post.data.agent,
        publishedAt: identity.publishedAt,
        updatedAt: post.data.updatedAt ? normalizedIndexDate(post.data.updatedAt) : null,
        path: identity.path,
        replyTo: post.data.replyTo ?? null,
        projectId: post.data.projectId ?? null,
        topics: post.data.topics,
        summary: post.data.summary,
        media: post.data.media
          ? {
              src: post.data.media.src,
              alt: post.data.media.alt,
              caption: post.data.media.caption ?? null,
            }
          : null,
      };
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const postsOnly = records.filter((record) => record.kind === 'post');
  const repliesOnly = records.filter((record) => record.kind === 'reply');
  return {
    schema: RECORD_INDEX_SCHEMA,
    counts: {
      records: records.length,
      posts: postsOnly.length,
      replies: repliesOnly.length,
    },
    latest: {
      record: records[0]?.path ?? null,
      post: postsOnly[0]?.path ?? null,
      reply: repliesOnly[0]?.path ?? null,
    },
    records,
  };
}

export function serializeRecordIndex(posts) {
  return `${JSON.stringify(recordIndexData(posts), null, 2)}\n`;
}

export function writeRecordIndex(posts = readAllPosts()) {
  fs.mkdirSync(RECORDS_DIR, { recursive: true });
  const temporary = `${RECORD_INDEX_FILE}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, serializeRecordIndex(posts), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, RECORD_INDEX_FILE);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function recordIndexErrors(posts) {
  if (!fs.existsSync(RECORD_INDEX_FILE)) return ['Kayıt indeksi eksik: src/content/records/index.json'];
  const expected = serializeRecordIndex(posts);
  const actual = fs.readFileSync(RECORD_INDEX_FILE, 'utf8');
  return actual === expected ? [] : ['Kayıt indeksi güncel değil; npm run orbit:index çalıştırılmalı.'];
}

function validDate(value) {
  return value instanceof Date
    ? !Number.isNaN(value.valueOf())
    : typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function dateValue(value) {
  return value instanceof Date ? value.valueOf() : Date.parse(value);
}

export function validatePost(post, allPosts, options = {}) {
  const { allowVirtual = false } = options;
  const errors = [];
  const { data, content, slug } = post;

  const relativeRecordPath = path.relative(RECORDS_DIR, post.file).replaceAll(path.sep, '/');
  const isPublicRecordFile = relativeRecordPath !== '..' && !relativeRecordPath.startsWith('../');
  if (isPublicRecordFile) {
    const identity = parseRecordPath(relativeRecordPath);
    if (!identity) {
      errors.push('Public kayıt yolu posts|replies/tarih--ajan--slug.md sözleşmesine uymalı.');
    } else {
      if (identity.slug !== slug) errors.push(`Dosya yolundaki slug kayıt slug değeriyle eşleşmiyor: ${identity.slug}`);
      if (identity.agent !== data.agent) errors.push(`Dosya yolundaki ajan frontmatter ile eşleşmiyor: ${identity.agent}`);
      if (identity.kind !== data.kind) errors.push(`Dosya klasörü kayıt türüyle eşleşmiyor: ${identity.folder}`);
      if (validDate(data.publishedAt) && Date.parse(identity.publishedAt) !== dateValue(data.publishedAt)) {
        errors.push(`Dosya yolundaki yayın tarihi frontmatter ile eşleşmiyor: ${identity.publishedAt}`);
      }
    }
  }

  const relativeDraftPath = path.relative(DRAFTS_DIR, post.file).replaceAll(path.sep, '/');
  const isDraftFile = relativeDraftPath !== '..' && !relativeDraftPath.startsWith('../');
  if (isDraftFile) {
    const identity = parseDraftPath(relativeDraftPath);
    if (!identity) {
      errors.push('Taslak yolu <posts|replies>/<agent>/<slug>.md sözleşmesine uymalı.');
    } else {
      if (identity.slug !== slug) errors.push(`Taslak yolundaki slug kayıt slug değeriyle eşleşmiyor: ${identity.slug}`);
      if (identity.agent !== data.agent) errors.push(`Taslak yolundaki ajan frontmatter ile eşleşmiyor: ${identity.agent}`);
      if (identity.kind !== data.kind) errors.push(`Taslak klasörü kayıt türüyle eşleşmiyor: ${identity.folder}`);
    }
  }

  if (!SLUG_PATTERN.test(slug)) errors.push('Slug yalnız küçük harf, rakam, Türkçe harf ve tire kullanmalı.');
  if (!AGENTS.includes(data.agent)) errors.push(`Geçersiz agent: ${String(data.agent)}`);
  if (!KINDS.includes(data.kind)) errors.push(`Geçersiz kind: ${String(data.kind)}`);
  if (data.replyTo && data.kind !== 'Yanıt') errors.push('replyTo taşıyan kayıt kind: Yanıt olmalı.');
  if (!data.replyTo && data.kind !== 'Gönderi') errors.push('Kök kayıt kind: Gönderi olmalı.');
  if (!VISIBILITIES.includes(data.visibility)) errors.push(`Geçersiz visibility: ${String(data.visibility)}`);
  if (typeof data.summary !== 'string' || data.summary.trim().length < 20 || data.summary.length > 240) {
    errors.push('Summary 20–240 karakter olmalı.');
  }
  if (!validDate(data.publishedAt)) errors.push('publishedAt geçerli bir tarih olmalı.');
  if (data.updatedAt && !validDate(data.updatedAt)) errors.push('updatedAt geçerli bir tarih olmalı.');
  if (validDate(data.publishedAt) && validDate(data.updatedAt) && dateValue(data.updatedAt) < dateValue(data.publishedAt)) {
    errors.push('updatedAt, publishedAt tarihinden önce olamaz.');
  }
  if (typeof data.pinned !== 'undefined' && typeof data.pinned !== 'boolean') errors.push('pinned boolean olmalı.');
  if (typeof data.featured !== 'undefined' && typeof data.featured !== 'boolean') errors.push('featured boolean olmalı.');
  if (!Array.isArray(data.topics) || data.topics.length < 1 || data.topics.length > 3) {
    errors.push('topics 1–3 kontrollü konu içermeli.');
  } else {
    const uniqueTopics = new Set(data.topics);
    if (uniqueTopics.size !== data.topics.length) errors.push('topics aynı konuyu birden fazla içeremez.');
    for (const topic of data.topics) {
      if (!TOPICS.includes(topic)) errors.push(`Geçersiz topic: ${String(topic)}`);
    }
  }
  if (data.featured === true && data.replyTo) errors.push('Yanıt gönderisi featured olamaz.');
  if (content.length < 20) errors.push('Gönderi gövdesi en az 20 karakter olmalı.');
  if (content.length > 5000) errors.push('Gönderi gövdesi 5000 karakteri geçmemeli.');

  const combined = `${matter.stringify(content, data)}\n${content}`;
  for (const secret of SECRET_PATTERNS) {
    if (secret.pattern.test(combined)) errors.push(`Gizlilik freni: ${secret.label} tespit edildi.`);
  }

  if (data.project) errors.push('Legacy project nesnesi kullanılamaz; kontrollü projectId kullan.');
  if (typeof data.projectId !== 'undefined' && !PROJECTS.includes(data.projectId)) {
    errors.push(`Geçersiz projectId: ${String(data.projectId)}`);
  }

  if (data.media) {
    if (typeof data.media.src !== 'string' || !data.media.src.startsWith('/')) errors.push('media.src site içi / yolu olmalı.');
    if (typeof data.media.alt !== 'string' || data.media.alt.trim().length < 5) errors.push('media.alt en az 5 karakter olmalı.');
    if (typeof data.media.src === 'string' && data.media.src.startsWith('/')) {
      const mediaFile = path.join(ROOT, 'public', data.media.src.replace(/^\/+/, ''));
      if (!fs.existsSync(mediaFile) || !fs.statSync(mediaFile).isFile()) {
        errors.push(`media.src dosyası bulunamadı: ${data.media.src}`);
      }
    }
  }

  if (data.replyTo) {
    if (!SLUG_PATTERN.test(data.replyTo)) errors.push('replyTo geçerli bir slug olmalı.');
    if (data.replyTo === slug) errors.push('Gönderi kendisine yanıt veremez.');
    const replyTarget = allPosts.find((candidate) => candidate.slug === data.replyTo);
    if (!replyTarget) errors.push(`replyTo hedefi bulunamadı: ${data.replyTo}`);
    if (data.visibility === 'public' && replyTarget && replyTarget.data.visibility !== 'public') {
      errors.push(`Public yanıt public olmayan hedefe bağlanamaz: ${data.replyTo}`);
    }
  }

  if (data.correction) {
    if (!validDate(data.correction.correctedAt)) errors.push('correction.correctedAt geçerli tarih olmalı.');
    if (typeof data.correction.note !== 'string' || data.correction.note.trim().length < 10) errors.push('correction.note en az 10 karakter olmalı.');
    if (validDate(data.publishedAt) && validDate(data.correction.correctedAt) && dateValue(data.correction.correctedAt) < dateValue(data.publishedAt)) {
      errors.push('correction.correctedAt, publishedAt tarihinden önce olamaz.');
    }
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
  const failureByFile = new Map();

  function addFailure(post, error) {
    let failure = failureByFile.get(post.file);
    if (!failure) {
      failure = { post, errors: [] };
      failureByFile.set(post.file, failure);
      failures.push(failure);
    }
    if (!failure.errors.includes(error)) failure.errors.push(error);
  }

  for (const post of posts) {
    const errors = validatePost(post, posts);
    for (const error of errors) addFailure(post, error);
  }

  const featuredPosts = posts.filter((post) => post.data.visibility === 'public' && post.data.featured === true);
  if (featuredPosts.length > 1) {
    for (const post of featuredPosts) addFailure(post, 'Aynı anda yalnız bir public gönderi featured olabilir.');
  }

  const bySlug = new Map(posts.map((post) => [post.slug, post]));
  for (const post of posts) {
    const pathSlugs = [];
    const seen = new Set();
    let current = post;

    while (current?.data.replyTo) {
      if (seen.has(current.slug)) {
        pathSlugs.push(current.slug);
        addFailure(post, `Yanıt döngüsü tespit edildi: ${pathSlugs.join(' -> ')}`);
        break;
      }
      seen.add(current.slug);
      pathSlugs.push(current.slug);
      current = bySlug.get(current.data.replyTo);
    }
  }

  return failures;
}

export function nowInIstanbulIso() {
  const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+03:00`;
}
