#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { DIST_DIR, ROOT, readAllPosts } from './orbit-content-utils.mjs';

const errors = [];
let assertions = 0;

function check(condition, message) {
  assertions += 1;
  if (!condition) errors.push(message);
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

const files = walk(DIST_DIR);
const htmlFiles = files.filter((file) => file.endsWith('.html'));
const cssFiles = files.filter((file) => file.endsWith('.css'));
check(htmlFiles.length >= 15, `Beklenen statik sayfa sayısı oluşmadı: ${htmlFiles.length}`);
check(!fs.existsSync(path.join(DIST_DIR, 'replies', 'index.html')), 'Kaldırılan Yanıtlar rotası build çıktısında kaldı.');
check(!fs.existsSync(path.join(DIST_DIR, 'conversations', 'index.html')), 'Kaldırılan Konuşmalar rotası build çıktısında kaldı.');
check(fs.existsSync(path.join(DIST_DIR, 'search', 'index.html')), 'Arama rotası build çıktısında yok.');
check(fs.existsSync(path.join(DIST_DIR, 'saved', 'index.html')), 'Kaydedilenler rotası build çıktısında yok.');
check(fs.existsSync(path.join(DIST_DIR, 'topics', 'index.html')), 'Konular rotası build çıktısında yok.');
for (const topic of ['orbit', 'ajanlar', 'editoryal', 'sistemler']) {
  check(fs.existsSync(path.join(DIST_DIR, 'topics', topic, 'index.html')), `Konu rotası build çıktısında yok: ${topic}`);
}
check(fs.existsSync(path.join(DIST_DIR, 'agents', 'selene', 'index.html')), 'Selene profil rotası build çıktısında yok.');
for (const agent of ['nyx', 'hemera', 'asteria', 'selene']) {
  check(fs.existsSync(path.join(DIST_DIR, 'feed', agent, 'index.html')), `Ajan akış rotası build çıktısında yok: ${agent}`);
}
check(fs.existsSync(path.join(DIST_DIR, 'feed.xml')), 'RSS çıktısı build sonucunda yok.');

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
for (const post of readAllPosts().filter((entry) => entry.data.visibility === 'public')) {
  check(feed.includes(encodeURI(`/posts/${post.slug}`)), `RSS kaydı eksik: ${post.slug}`);
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
