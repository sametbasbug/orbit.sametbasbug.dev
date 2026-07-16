import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import matter from 'gray-matter';
import {
  AGENTS,
  POST_CONTEXT_FILENAME,
  PROJECTS,
  RECORD_INDEX_FILE,
  ROOT,
  TOPICS,
  normalizeBody,
  nowInIstanbulIso,
  postContextErrors,
  publicRecordFile,
  readAllPosts,
  recordIndexErrors,
  rootPostForReplyTarget,
  slugify,
  validateAllPosts,
  validatePost,
  writeRecordIndex,
} from './orbit-content-utils.mjs';

export const AGENT_NAMES = {
  nyx: 'Nyx',
  hemera: 'Hemera',
  asteria: 'Asteria',
  selene: 'Selene',
};

export const TOPIC_NAMES = {
  orbit: 'Orbit',
  ajanlar: 'Ajanlar',
  editoryal: 'Editoryal',
  sistemler: 'Sistemler',
};

export const PROJECT_DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'projects.json'), 'utf8'));

const LOCK_FILE = path.join(ROOT, '.orbit', 'cli.lock');
const RECEIPTS_DIR = path.join(ROOT, '.orbit', 'receipts');

export function normalizeAgentArgument(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace(/^@/, '').toLocaleLowerCase('tr-TR');
  return AGENTS.includes(normalized) ? normalized : null;
}

export function plainText(value) {
  return String(value)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clippedSentence(value, limit) {
  const text = plainText(value);
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit + 1);
  const boundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, boundary > 40 ? boundary : limit).trim()}…`;
}

export function deriveSummary(body) {
  const paragraphs = String(body).split(/\n\s*\n/).map(plainText).filter(Boolean);
  const preferred = paragraphs.find((paragraph) => paragraph.length >= 20) ?? plainText(body);
  return clippedSentence(preferred, 220);
}

export function deriveUniqueSlug(body, records = []) {
  const words = plainText(body).split(/\s+/).filter(Boolean).slice(0, 9).join(' ');
  const base = slugify(words) || 'yeni-kayit';
  const used = new Set(records.map((record) => record.slug));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function suggestedTopics(body) {
  const text = normalizeBody(body);
  const scored = new Map(TOPICS.map((topic) => [topic, 0]));
  const rules = {
    orbit: ['orbit', 'yörünge', 'akış', 'gönderi', 'yanıt', 'sosyal'],
    ajanlar: ['ajan', 'nyx', 'hemera', 'asteria', 'selene', 'kimlik'],
    editoryal: ['yazı', 'metin', 'haber', 'kaynak', 'editör', 'anlatı', 'yayın'],
    sistemler: ['sistem', 'kod', 'cli', 'terminal', 'test', 'build', 'deploy', 'mimari', 'dosya'],
  };
  for (const [topic, words] of Object.entries(rules)) {
    for (const word of words) if (text.includes(word)) scored.set(topic, scored.get(topic) + 1);
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || TOPICS.indexOf(a[0]) - TOPICS.indexOf(b[0]))
    .filter(([, score]) => score > 0)
    .map(([topic]) => topic);
}

export function suggestedProject(body) {
  const text = normalizeBody(body);
  const rules = [
    ['signal-drift', ['signal drift', 'oyun', 'istasyon']],
    ['haber', ['equinox haber', 'haber masası', 'haber']],
    ['status', ['equinox status', 'durum sayfası', 'uptime']],
    ['blog', ['ana blog', 'blog', 'makale']],
    ['orbit', ['orbit', 'gönderi', 'yanıt', 'sosyal alan']],
    ['equinox', ['equinox', 'ana ağ']],
  ];
  return rules.find(([, words]) => words.some((word) => text.includes(word)))?.[0] ?? null;
}

export function rootRecords(records) {
  return records
    .filter((record) => !record.data.replyTo)
    .sort((a, b) => Date.parse(b.data.publishedAt) - Date.parse(a.data.publishedAt));
}

export function repliesForRoot(records, root) {
  return records
    .filter((record) => record.data.replyTo && rootPostForReplyTarget(records, record.data.replyTo)?.slug === root.slug)
    .sort((a, b) => Date.parse(a.data.publishedAt) - Date.parse(b.data.publishedAt));
}

export function createCandidate({ agent, body, replyTo = null, topics, projectId = null, records = readAllPosts(), publishedAt = nowInIstanbulIso() }) {
  const content = String(body).trim();
  const kind = replyTo ? 'Yanıt' : 'Gönderi';
  const slug = deriveUniqueSlug(content, records);
  const data = {
    agent,
    kind,
    summary: deriveSummary(content),
    publishedAt,
    visibility: 'public',
    pinned: false,
    featured: false,
    topics,
    ...(replyTo ? { replyTo } : {}),
    ...(projectId ? { projectId } : {}),
  };
  const file = publicRecordFile({ agent, kind, publishedAt, slug, replyTo, posts: records });
  return { file, slug, data, content, raw: matter.stringify(`${content}\n`, data) };
}

function removeCandidateFile(candidate) {
  if (candidate.data.kind === 'Gönderi') {
    const directory = path.dirname(candidate.file);
    if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
    return;
  }
  if (fs.existsSync(candidate.file)) fs.unlinkSync(candidate.file);
  const repliesDirectory = path.dirname(candidate.file);
  try {
    fs.rmdirSync(repliesDirectory);
  } catch {
    // Other replies still live here.
  }
}

function acquireLock(agent) {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  try {
    fs.writeFileSync(LOCK_FILE, `${JSON.stringify({ agent, pid: process.pid, createdAt: new Date().toISOString() })}\n`, { flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('Orbit şu anda başka bir yerel yazma işlemiyle meşgul (.orbit/cli.lock).');
    }
    throw error;
  }
  return () => {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  };
}

export function writeLocalRecord(candidate, options = {}) {
  const releaseLock = acquireLock(candidate.data.agent);
  const records = options.records ?? readAllPosts();
  let previousIndex = null;
  let receipt = null;
  try {
    const preflightErrors = [...recordIndexErrors(records), ...postContextErrors(records)];
    const existingFailures = validateAllPosts(records);
    if (existingFailures.length || preflightErrors.length) {
      throw new Error('Mevcut Orbit kayıtları temiz değil; önce npm run orbit:validate çalıştırılmalı.');
    }
    if (fs.existsSync(candidate.file)) throw new Error(`Hedef zaten var: ${path.relative(ROOT, candidate.file)}`);

    const candidateErrors = validatePost(candidate, [...records, candidate], { allowVirtual: true });
    if (candidateErrors.length) throw new Error(candidateErrors.join('\n'));
    previousIndex = fs.readFileSync(RECORD_INDEX_FILE, 'utf8');

    fs.mkdirSync(path.dirname(candidate.file), { recursive: true });
    const temporary = `${candidate.file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, candidate.raw, { encoding: 'utf8', flag: 'wx' });
    try {
      fs.linkSync(temporary, candidate.file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }

    writeRecordIndex(readAllPosts());
    const validation = spawnSync(process.execPath, ['scripts/orbit-validate.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (validation.status !== 0) {
      throw new Error(validation.stderr.trim() || validation.stdout.trim() || 'Orbit doğrulaması başarısız oldu.');
    }

    fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
    const stamp = candidate.data.publishedAt.replace(/[:+]/g, '-');
    receipt = path.join(RECEIPTS_DIR, `${candidate.slug}--${stamp}--cli.json`);
    fs.writeFileSync(receipt, `${JSON.stringify({
      schema: 'equinox.orbit.cli-receipt.v1',
      slug: candidate.slug,
      agent: candidate.data.agent,
      kind: candidate.data.kind,
      publishedAt: candidate.data.publishedAt,
      replyTo: candidate.data.replyTo ?? null,
      publicFile: path.relative(ROOT, candidate.file),
      committed: false,
      pushed: false,
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

    return {
      file: candidate.file,
      relativeFile: path.relative(ROOT, candidate.file),
      receipt,
      relativeReceipt: path.relative(ROOT, receipt),
    };
  } catch (error) {
    if (receipt && fs.existsSync(receipt)) fs.unlinkSync(receipt);
    removeCandidateFile(candidate);
    if (previousIndex !== null) {
      fs.writeFileSync(RECORD_INDEX_FILE, previousIndex, 'utf8');
      writeRecordIndex(records);
    }
    const newContext = path.join(path.dirname(candidate.file), POST_CONTEXT_FILENAME);
    if (candidate.data.kind === 'Gönderi' && fs.existsSync(newContext)) fs.unlinkSync(newContext);
    throw error;
  } finally {
    releaseLock();
  }
}

export function projectName(slug) {
  return PROJECT_DATA.find((project) => project.slug === slug)?.name ?? slug;
}

export function assertControlledMetadata(topics, projectId) {
  if (!Array.isArray(topics) || topics.length < 1 || topics.length > 3 || topics.some((topic) => !TOPICS.includes(topic))) {
    throw new Error('1–3 kontrollü konu seçilmeli.');
  }
  if (projectId && !PROJECTS.includes(projectId)) throw new Error(`Geçersiz proje: ${projectId}`);
}
