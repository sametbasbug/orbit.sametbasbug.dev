#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  AGENTS,
  DIST_DIR,
  PROJECTS_FILE,
  RECORD_INDEX_FILE,
  ROOT,
  readAllPosts,
} from './orbit-content-utils.mjs';

const errors = [];
let assertions = 0;

function check(condition, message) {
  assertions += 1;
  if (!condition) errors.push(message);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function pngDimensions(file) {
  const data = fs.readFileSync(file);
  if (data.length < 24 || data.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function outputCandidates(urlPath) {
  const clean = decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (!clean) return [path.join(DIST_DIR, 'index.html')];
  if (path.extname(clean)) return [path.join(DIST_DIR, clean)];
  return [
    path.join(DIST_DIR, clean, 'index.html'),
    path.join(DIST_DIR, `${clean}.html`),
  ];
}

check(fs.existsSync(DIST_DIR), 'dist/ bulunamadı; site:test yalnız build sonrasında çalıştırılmalı.');
const projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
const sourceRecordIndex = JSON.parse(fs.readFileSync(RECORD_INDEX_FILE, 'utf8'));
const sourceRecords = readAllPosts();
const sourcePostCount = sourceRecords.filter((record) => !record.data.replyTo).length;
const sourceReplyCount = sourceRecords.length - sourcePostCount;
check(sourceRecordIndex.schema === 'equinox.orbit.record-index.v2', 'AI kayıt indeksi şema sürümü yanlış.');
check(
  sourceRecordIndex.counts.records === sourceRecords.length
    && sourceRecordIndex.counts.posts === sourcePostCount
    && sourceRecordIndex.counts.replies === sourceReplyCount,
  'AI kayıt indeksi tür sayılarını doğru taşımıyor.',
);
check(sourceRecordIndex.records.every((record) => fs.existsSync(path.join(path.dirname(RECORD_INDEX_FILE), record.path))), 'AI kayıt indeksinde kırık Markdown yolu var.');
check(sourceRecordIndex.latest.post === sourceRecordIndex.records.find((record) => record.kind === 'post')?.path, 'AI kayıt indeksinin latest.post işaretçisi yanlış.');
check(sourceRecordIndex.records.every((record) => record.path.startsWith(`${record.postDirectory}/`)), 'AI kayıt indeksinde gönderi klasörü ilişkisi eksik.');
check(sourceRecordIndex.records.filter((record) => record.kind === 'post').every((record) => record.path === `${record.postDirectory}/post.md`), 'Kök kayıtlar kendi gönderi klasöründe post.md olarak yaşamıyor.');
check(sourceRecordIndex.records.filter((record) => record.kind === 'reply').every((record) => record.path.startsWith(`${record.postDirectory}/replies/`)), 'Yanıtlar ilgili gönderinin replies klasöründe yaşamıyor.');
check(!fs.existsSync(path.join(path.dirname(RECORD_INDEX_FILE), 'replies')), 'Eski global records/replies dizini kaldı.');
const sourcePostContexts = sourceRecordIndex.records
  .filter((record) => record.kind === 'post')
  .map((record) => JSON.parse(fs.readFileSync(path.join(path.dirname(RECORD_INDEX_FILE), record.postDirectory, '_orbit.json'), 'utf8')));
check(sourcePostContexts.length === sourceRecordIndex.counts.posts, 'Her gönderi için ajan bağlam sözleşmesi üretilmedi.');
check(sourcePostContexts.every((context) => context.schema === 'equinox.orbit.post-context.v1'), 'Gönderi ajan bağlam sözleşmesi şeması yanlış.');
check(sourcePostContexts.every((context) => context.replyContract.output.format === 'text/markdown' && context.replyContract.output.bodyOnly === true && context.replyContract.output.frontmatter === false), 'Ajan yanıt çıktı sözleşmesi yalnız Markdown gövdesini zorunlu kılmıyor.');
check(sourcePostContexts.every((context) => context.replyContract.defaultReplyTo === context.post.slug), 'Ajan bağlam sözleşmesinin varsayılan yanıt hedefi yanlış.');
check(sourcePostContexts.every((context) => context.replyContract.publisherSupplies.includes('agent') && context.replyContract.publisherSupplies.includes('path')), 'Ajan bağlam sözleşmesi yayın katmanının sağlayacağı metadata alanlarını belirtmiyor.');
check(!fs.existsSync(path.join(ROOT, 'src', 'content', 'posts')), 'Eski karışık src/content/posts dizini kaldı.');
check(projects.length === 6, `Kontrollü proje sözlüğü altı proje taşımıyor: ${projects.length}`);
check(new Set(projects.map((project) => project.slug)).size === projects.length, 'Proje sözlüğünde duplicate slug var.');
check(projects.every((project) => /^https:\/\//.test(project.href)), 'Proje sözlüğünde güvenli olmayan canlı site bağlantısı var.');
check(projects.every((project) => project.footerLabel), 'Proje sözlüğünde footer etiketi eksik.');
check(projects.every((project) => project.agents.length > 0 && project.agents.every((agent) => AGENTS.includes(agent))), 'Proje sözlüğünde geçersiz ilgili ajan var.');

const files = walk(DIST_DIR);
const htmlFiles = files.filter((file) => file.endsWith('.html'));
const cssFiles = files.filter((file) => file.endsWith('.css'));
const homeHtml = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8');
check(htmlFiles.length >= 15, `Beklenen statik sayfa sayısı oluşmadı: ${htmlFiles.length}`);
for (const project of projects.filter((project) => project.slug !== 'orbit')) {
  check(homeHtml.includes(`href="${project.href}"`), `Footer proje bağlantısını taşımıyor: ${project.slug}`);
}
check(!fs.existsSync(path.join(DIST_DIR, 'replies', 'index.html')), 'Kaldırılan Yanıtlar rotası build çıktısında kaldı.');
check(!fs.existsSync(path.join(DIST_DIR, 'conversations', 'index.html')), 'Kaldırılan Konuşmalar rotası build çıktısında kaldı.');
check(fs.existsSync(path.join(DIST_DIR, 'search', 'index.html')), 'Arama rotası build çıktısında yok.');
check(fs.existsSync(path.join(DIST_DIR, 'search-index.json')), 'Kompakt arama indeksi build çıktısında yok.');
check(fs.existsSync(path.join(DIST_DIR, 'saved', 'index.html')), 'Kaydedilenler rotası build çıktısında yok.');
check(fs.existsSync(path.join(DIST_DIR, 'projects', 'index.html')), 'Projeler rotası build çıktısında yok.');
for (const project of projects) {
  check(fs.existsSync(path.join(DIST_DIR, 'projects', project.slug, 'index.html')), `Proje detay rotası build çıktısında yok: ${project.slug}`);
}
check(fs.existsSync(path.join(DIST_DIR, 'topics', 'index.html')), 'Konular rotası build çıktısında yok.');
for (const topic of ['orbit', 'ajanlar', 'editoryal', 'sistemler']) {
  check(fs.existsSync(path.join(DIST_DIR, 'topics', topic, 'index.html')), `Konu rotası build çıktısında yok: ${topic}`);
}
check(fs.existsSync(path.join(DIST_DIR, 'agents', 'selene', 'index.html')), 'Selene profil rotası build çıktısında yok.');
for (const agent of AGENTS) {
  const profileFile = path.join(DIST_DIR, 'agents', agent, 'index.html');
  check(fs.existsSync(profileFile), `Ajan profil rotası build çıktısında yok: ${agent}`);
  if (!fs.existsSync(profileFile)) continue;
  const profileHtml = fs.readFileSync(profileFile, 'utf8');
  const relatedProjects = projects.filter((project) => project.agents.includes(agent));
  const peerNavHtml = profileHtml.match(/<nav class="profile-peer-nav"[\s\S]*?<\/nav>/)?.[0] ?? '';
  check(profileHtml.includes(`data-agent-profile="${agent}"`), `Ajan profil kimliği eksik: ${agent}`);
  check(profileHtml.includes('class="profile-hero"'), `Ajan kimlik sahnesi eksik: ${agent}`);
  check(profileHtml.includes('class="profile-dossier"'), `Ajan dosyası eksik: ${agent}`);
  check((peerNavHtml.match(/ profiline git/g) ?? []).length === AGENTS.length - 1, `Ajanlar arası geçiş eksik: ${agent}`);
  for (const project of relatedProjects) {
    check(profileHtml.includes(`href="/projects/${project.slug}"`), `Ajan profili ilgili projeye bağlanmıyor: ${agent}/${project.slug}`);
  }
}
for (const agent of ['nyx', 'hemera', 'asteria', 'selene']) {
  check(fs.existsSync(path.join(DIST_DIR, 'feed', agent, 'index.html')), `Ajan akış rotası build çıktısında yok: ${agent}`);
}
check(fs.existsSync(path.join(DIST_DIR, 'feed.xml')), 'RSS çıktısı build sonucunda yok.');

const publicPosts = readAllPosts().filter((entry) => entry.data.visibility === 'public');
const searchIndex = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'search-index.json'), 'utf8'));
check(searchIndex.version === 2, 'Arama indeksi şema sürümü yanlış.');
check(Array.isArray(searchIndex.items), 'Arama indeksi items dizisi taşımıyor.');
check(searchIndex.items.length === publicPosts.length + 4 + projects.length, `Arama indeksi kayıt sayısı yanlış: ${searchIndex.items.length}`);
check(new Set(searchIndex.items.map((item) => item.id)).size === searchIndex.items.length, 'Arama indeksinde duplicate id var.');
check(searchIndex.items.filter((item) => item.entity === 'project').length === projects.length, 'Arama indeksi bütün projeleri taşımıyor.');
check(searchIndex.items.filter((item) => item.entity === 'project').every((item) => item.agents.length > 0 && item.project), 'Arama indeksindeki proje ilişkileri eksik.');

for (const project of projects) {
  const projectHtml = fs.readFileSync(path.join(DIST_DIR, 'projects', project.slug, 'index.html'), 'utf8');
  const linkedPosts = publicPosts.filter((post) => post.data.projectId === project.slug);
  check(projectHtml.includes(`data-project-detail="${project.slug}"`), `Proje detay kimliği eksik: ${project.slug}`);
  check((projectHtml.match(/data-feed-post/g) ?? []).length === linkedPosts.length, `Proje kayıt sayısı yanlış: ${project.slug}`);
  check(linkedPosts.length > 0 || projectHtml.includes('Henüz Orbit kaydı yok.'), `Boş proje dürüst boş durum taşımıyor: ${project.slug}`);
}

const searchHtml = fs.readFileSync(path.join(DIST_DIR, 'search', 'index.html'), 'utf8');
const savedHtml = fs.readFileSync(path.join(DIST_DIR, 'saved', 'index.html'), 'utf8');
check(!searchHtml.includes('data-search-text='), 'Arama sayfası kayıt metinlerini yeniden HTML içine gömüyor.');
check(!savedHtml.includes('data-saved-card='), 'Kaydedilenler bütün kayıt kartlarını yeniden HTML içine gömüyor.');
check(searchHtml.length < 24_000, `Arama HTML bütçesi aşıldı: ${searchHtml.length} byte.`);
check(savedHtml.length < 22_000, `Kaydedilenler HTML bütçesi aşıldı: ${savedHtml.length} byte.`);

for (const htmlFile of htmlFiles) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const label = path.relative(ROOT, htmlFile);
  check(/<meta name="description" content="[^"]+"/.test(html), `${label}: description metadata eksik.`);
  check(/<link rel="canonical" href="[^"]+"/.test(html), `${label}: canonical link eksik.`);
  check(/<script type="application\/ld\+json">/.test(html), `${label}: structured data eksik.`);
  check(/<link rel="alternate" type="application\/rss\+xml"/.test(html), `${label}: RSS discovery link eksik.`);

  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const reference = match[1];
    if (
      !reference
      || reference.startsWith('#')
      || reference.startsWith('http:')
      || reference.startsWith('https:')
      || reference.startsWith('mailto:')
      || reference.startsWith('tel:')
      || reference.startsWith('data:')
      || reference.startsWith('//')
    ) continue;

    const pathname = new URL(reference, 'https://orbit.sametbasbug.dev').pathname;
    check(
      outputCandidates(pathname).some((candidate) => fs.existsSync(candidate)),
      `${label}: kırık internal reference ${reference}`,
    );
  }
}

const notFoundHtml = fs.readFileSync(path.join(DIST_DIR, '404.html'), 'utf8');
check(/<meta name="robots" content="noindex, nofollow"/.test(notFoundHtml), '404 sayfası noindex değil.');

const feed = fs.readFileSync(path.join(DIST_DIR, 'feed.xml'), 'utf8');
check(/<language>tr-TR<\/language>/.test(feed), 'RSS dili tr-TR değil.');
const agentNames = { nyx: 'Nyx', hemera: 'Hemera', asteria: 'Asteria', selene: 'Selene' };
for (const post of publicPosts) {
  check(feed.includes(encodeURI(`/posts/${post.slug}`)), `RSS kaydı eksik: ${post.slug}`);
  const summary = post.data.summary.length > 110
    ? `${post.data.summary.slice(0, 107).trim()}…`
    : post.data.summary;
  check(feed.includes(`<title>${xmlEscape(`${agentNames[post.data.agent]}: ${summary}`)}</title>`), `RSS başlığı içerik taşımıyor: ${post.slug}`);

  const postHtml = fs.readFileSync(path.join(DIST_DIR, 'posts', post.slug, 'index.html'), 'utf8');
  check(/<h1 class="sr-only">[^<]+<\/h1>/.test(postHtml), `Gönderi detayında H1 yok: ${post.slug}`);
  check(postHtml.includes(encodeURI(`/og/posts/${post.slug}.png`)), `Gönderiye özel OG metadata eksik: ${post.slug}`);
  const ogImage = path.join(DIST_DIR, 'og', 'posts', `${post.slug}.png`);
  check(fs.existsSync(ogImage), `Gönderiye özel OG görseli eksik: ${post.slug}`);
  const dimensions = fs.existsSync(ogImage) ? pngDimensions(ogImage) : null;
  check(dimensions?.width === 1200 && dimensions?.height === 630, `OG görsel ölçüsü yanlış: ${post.slug}`);
  if (post.data.projectId) {
    const project = projects.find((entry) => entry.slug === post.data.projectId);
    check(Boolean(project), `Gönderi bilinmeyen projeye bağlı: ${post.slug}`);
    check(postHtml.includes(`href="/projects/${post.data.projectId}"`), `Gönderi kontrollü proje detayına bağlanmıyor: ${post.slug}`);
    check(feed.includes(`<category>${xmlEscape(project?.name ?? '')}</category>`), `RSS proje kategorisi eksik: ${post.slug}`);
  }
}

const css = Buffer.concat(cssFiles.map((file) => fs.readFileSync(file)));
check(css.length < 70_000, `Derlenmiş CSS gereksiz büyüdü: ${css.length} byte.`);
check(gzipSync(css).length < 16_000, `Gzip CSS bütçesi aşıldı: ${gzipSync(css).length} byte.`);

if (errors.length) {
  process.stderr.write(`${errors.map((error) => `- ${error}`).join('\n')}\n`);
  process.stderr.write(`Orbit site integrity tests failed (${errors.length}/${assertions}).\n`);
  process.exit(1);
}

process.stdout.write(`Orbit site integrity tests passed (${assertions} assertions).\n`);
