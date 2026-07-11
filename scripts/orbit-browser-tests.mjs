#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { DIST_DIR } from './orbit-content-utils.mjs';

const errors = [];
let assertions = 0;

function check(condition, message) {
  assertions += 1;
  if (!condition) errors.push(message);
}

function chromeExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function staticFileFor(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  const clean = pathname.replace(/^\/+/, '');
  const candidates = !clean
    ? [path.join(DIST_DIR, 'index.html')]
    : path.extname(clean)
      ? [path.join(DIST_DIR, clean)]
      : [path.join(DIST_DIR, clean, 'index.html'), path.join(DIST_DIR, `${clean}.html`)];

  return candidates.find((candidate) => {
    const relative = path.relative(DIST_DIR, candidate);
    return !relative.startsWith('..') && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  });
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
};

check(fs.existsSync(DIST_DIR), 'dist/ bulunamadı; browser:test yalnız build sonrasında çalıştırılmalı.');
const executablePath = chromeExecutable();
check(Boolean(executablePath), 'Desteklenen Chrome/Chromium executable bulunamadı.');

if (errors.length === 0) {
  const server = http.createServer((request, response) => {
    const file = staticFileFor(request.url ?? '/');
    if (!file) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': mimeTypes[path.extname(file)] ?? 'application/octet-stream',
    });
    fs.createReadStream(file).pipe(response);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  const viewports = [
    { width: 320, height: 700 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ];

  try {
    for (const viewport of viewports) {
      const label = `${viewport.width}x${viewport.height}`;
      const context = await browser.newContext({ viewport, colorScheme: 'light' });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(baseUrl, { waitUntil: 'networkidle' });

      const layout = await page.evaluate(() => {
        const rect = (selector) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const box = element.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
        };
        const navigation = document.querySelector('.primary-nav');
        const navLinks = [...navigation.querySelectorAll('a')];
        const feedPosts = [...document.querySelectorAll('[data-feed-post]')];
        const featuredPosts = feedPosts.filter((post) => post.dataset.featured === 'true');
        return {
          innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          hero: rect('.orbit-welcome'),
          feedHeading: rect('.feed-heading'),
          filter: rect('.feed-filter'),
          firstPost: rect('[data-feed-post]'),
          featuredCount: featuredPosts.length,
          firstPostFeatured: feedPosts[0]?.dataset.featured === 'true',
          nav: rect('.primary-nav'),
          navPosition: getComputedStyle(navigation).position,
          navLinks: navLinks.map((link) => ({
            rect: (() => {
              const box = link.getBoundingClientRect();
              return { x: box.x, width: box.width, right: box.right };
            })(),
            flex: getComputedStyle(link).flex,
            minWidth: getComputedStyle(link).minWidth,
          })),
        };
      });

      check(layout.scrollWidth <= layout.innerWidth, `${label}: document yatay taşıyor (${layout.scrollWidth}/${layout.innerWidth}).`);
      check(layout.bodyScrollWidth <= layout.innerWidth, `${label}: body yatay taşıyor (${layout.bodyScrollWidth}/${layout.innerWidth}).`);
      for (const [name, box] of Object.entries({ hero: layout.hero, filter: layout.filter, firstPost: layout.firstPost })) {
        check(box && box.x >= -0.5 && box.right <= layout.innerWidth + 0.5, `${label}: ${name} viewport dışına taşıyor.`);
      }
      check(layout.hero.bottom <= layout.feedHeading.y + 0.5, `${label}: hero ile akış başlığı çakışıyor.`);
      check(layout.feedHeading.bottom <= layout.filter.y + 0.5, `${label}: akış başlığı ile filtre çakışıyor.`);
      check(layout.filter.bottom <= layout.firstPost.y + 0.5, `${label}: filtre ile ilk gönderi çakışıyor.`);
      check(layout.featuredCount <= 1, `${label}: ana akışta birden fazla featured gönderi var (${layout.featuredCount}).`);
      check(layout.featuredCount === 0 || layout.firstPostFeatured, `${label}: featured gönderi ana akışın ilk sırasında değil.`);
      check(pageErrors.length === 0, `${label}: sayfa hatası: ${pageErrors.join(' | ')}`);

      if (viewport.width <= 780) {
        check(layout.navPosition === 'fixed', `${label}: mobil alt navigasyon fixed değil.`);
        check(layout.nav.x >= 0 && layout.nav.right <= layout.innerWidth && layout.nav.bottom <= viewport.height, `${label}: mobil alt navigasyon kırpılıyor.`);
        check(layout.navLinks.length === 4, `${label}: mobil navigasyonda dört öğe yok.`);
        check(layout.navLinks.every((link) => link.flex.startsWith('1 1 0') && link.minWidth === '0px'), `${label}: mobil navigasyon öğeleri eşit flex tabanında değil.`);
        const navWidths = layout.navLinks.map((link) => link.rect.width);
        check(Math.max(...navWidths) - Math.min(...navWidths) <= 1, `${label}: mobil navigasyon öğeleri eşit genişlikte değil (${navWidths.join(', ')}).`);
        check(layout.navLinks.every((link, index) => index === 0 || layout.navLinks[index - 1].rect.right <= link.rect.x + 0.5), `${label}: mobil navigasyon öğeleri birbiriyle çakışıyor.`);
        check(layout.firstPost.y < viewport.height, `${label}: ilk gönderi ilk viewport'ta görünmüyor.`);

        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const footerClearance = await page.evaluate(() => {
          const nav = document.querySelector('.primary-nav').getBoundingClientRect();
          const footerLinks = [...document.querySelectorAll('.site-footer a')];
          const lastLinkBottom = Math.max(...footerLinks.map((link) => link.getBoundingClientRect().bottom));
          return { navTop: nav.top, lastLinkBottom };
        });
        check(footerClearance.lastLinkBottom <= footerClearance.navTop - 2, `${label}: alt navigasyon footer bağlantılarını kapatıyor.`);
      } else {
        check(layout.navPosition !== 'fixed', `${label}: masaüstü navigasyonu yanlışlıkla fixed alt bara dönüştü.`);
      }

      check(await page.locator('html').getAttribute('data-theme') === 'light', `${label}: başlangıç teması light değil.`);
      await page.locator('[data-theme-toggle]').click();
      check(await page.locator('html').getAttribute('data-theme') === 'dark', `${label}: tema dark durumuna geçmedi.`);
      check(await page.evaluate(() => localStorage.getItem('orbit-theme')) === 'dark', `${label}: dark tema localStorage'a yazılmadı.`);
      await page.reload({ waitUntil: 'networkidle' });
      check(await page.locator('html').getAttribute('data-theme') === 'dark', `${label}: dark tema reload sonrasında korunmadı.`);
      await page.locator('[data-theme-toggle]').click();
      check(await page.locator('html').getAttribute('data-theme') === 'light', `${label}: tema light durumuna geri dönmedi.`);
      check(await page.evaluate(() => localStorage.getItem('orbit-theme')) === 'light', `${label}: light tema localStorage'a yazılmadı.`);
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

if (errors.length) {
  process.stderr.write(`${errors.map((error) => `- ${error}`).join('\n')}\n`);
  process.stderr.write(`Orbit browser regression tests failed (${errors.length}/${assertions}).\n`);
  process.exit(1);
}

process.stdout.write(`Orbit browser regression tests passed (${assertions} assertions).\n`);
