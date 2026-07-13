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
          navDisplay: getComputedStyle(navigation).display,
          headerSearch: rect('.header-search-form'),
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
      check(await page.locator('.header-search-form').count() === 1, `${label}: header arama formu eksik.`);
      check(pageErrors.length === 0, `${label}: sayfa hatası: ${pageErrors.join(' | ')}`);

      if (viewport.width <= 780) {
        check(layout.navDisplay === 'flex', `${label}: mobil alt navigasyon görünür değil.`);
        check(layout.headerSearch?.width === 0 || layout.headerSearch?.height === 0, `${label}: masaüstü arama formu mobilde gizlenmedi.`);
        check(await page.locator('.header-mobile-search').isVisible(), `${label}: mobil arama erişimi görünür değil.`);
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
          const rail = document.querySelector('.network-rail').getBoundingClientRect();
          const footer = document.querySelector('.site-footer').getBoundingClientRect();
          const footerLinks = [...document.querySelectorAll('.site-footer a')];
          const lastLinkBottom = Math.max(...footerLinks.map((link) => link.getBoundingClientRect().bottom));
          return { navTop: nav.top, lastLinkBottom, railBottom: rail.bottom, footerTop: footer.top };
        });
        check(footerClearance.railBottom <= footerClearance.footerTop + 0.5, `${label}: Equinox ağı ile footer çakışıyor.`);
        check(footerClearance.lastLinkBottom <= footerClearance.navTop - 2, `${label}: alt navigasyon footer bağlantılarını kapatıyor.`);
      } else {
        check(layout.navPosition !== 'fixed', `${label}: masaüstü navigasyonu yanlışlıkla fixed alt bara dönüştü.`);
        check(layout.navDisplay === 'none', `${label}: üstteki kopya ana navigasyon masaüstünde gizlenmedi.`);
        check(layout.headerSearch && layout.headerSearch.width >= 220, `${label}: masaüstü arama formu yeterli genişlikte değil.`);
        check(!(await page.locator('.header-mobile-search').isVisible()), `${label}: mobil arama düğmesi masaüstünde görünür kaldı.`);
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

      if (viewport.width === 1440) {
        await page.goto(baseUrl, { waitUntil: 'networkidle' });
        await page.locator('#header-search-input').fill('Selene');
        await page.locator('#header-search-input').press('Enter');
        await page.waitForURL(/\/search\?q=Selene$/);
        check(new URL(page.url()).searchParams.get('q') === 'Selene', `${label}: header araması sorguyu URL'ye taşımadı.`);
        check((await page.locator('[data-search-summary]').textContent())?.trim() === '3 eşleşme bulundu', `${label}: header araması doğru sonuç özetini üretmedi.`);
      }

      if (viewport.width === 390 || viewport.width === 1440) {
        await page.goto(baseUrl, { waitUntil: 'networkidle' });
        await page.locator('[data-feed-view="replies"]').click();
        let feedState = await page.evaluate(() => ({
          url: location.href,
          visible: [...document.querySelectorAll('[data-feed-post]')]
            .filter((item) => !item.hidden)
            .map((item) => ({ agent: item.dataset.agent, type: item.dataset.recordType })),
        }));
        check(feedState.url.includes('view=replies'), `${label}: yanıt görünümü URL state yazmadı.`);
        check(feedState.visible.length === 5, `${label}: yanıt görünümü beş gerçek yanıt döndürmedi (${feedState.visible.length}).`);
        check(feedState.visible.every((item) => item.type === 'reply'), `${label}: yanıt görünümünde kök gönderi kaldı.`);
        await page.locator('[data-feed-filter="selene"]').click();
        feedState = await page.evaluate(() => ({
          url: location.href,
          visible: [...document.querySelectorAll('[data-feed-post]')]
            .filter((item) => !item.hidden)
            .map((item) => ({ agent: item.dataset.agent, type: item.dataset.recordType })),
        }));
        check(feedState.url.includes('agent=selene'), `${label}: birleşik ajan filtresi URL state yazmadı.`);
        check(feedState.visible.length === 1 && feedState.visible[0].agent === 'selene' && feedState.visible[0].type === 'reply', `${label}: Selene + Yanıtlar birleşik filtresi yanlış.`);

        await page.goto(`${baseUrl}/search?q=Selene`, { waitUntil: 'networkidle' });
        const searchState = await page.evaluate(() => ({
          innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          summary: document.querySelector('[data-search-summary]')?.textContent?.trim(),
          visible: [...document.querySelectorAll('[data-search-item]')]
            .filter((item) => getComputedStyle(item).display !== 'none')
            .map((item) => item.textContent.trim().replace(/\s+/g, ' ')),
        }));
        check(searchState.scrollWidth <= searchState.innerWidth, `${label}: arama sayfası yatay taşıyor.`);
        check(searchState.summary === '3 eşleşme bulundu', `${label}: Selene arama özeti yanlış (${searchState.summary}).`);
        check(searchState.visible.length === 3, `${label}: Selene araması üç sonuç döndürmedi (${searchState.visible.length}).`);
        check(searchState.visible.every((item) => item.includes('Selene')), `${label}: Selene aramasında ilgisiz sonuç var.`);

        await page.locator('[data-search-topic]').selectOption('editoryal');
        const topicFiltered = await page.evaluate(() => ({
          url: location.href,
          visible: [...document.querySelectorAll('[data-search-item]')]
            .filter((item) => getComputedStyle(item).display !== 'none')
            .map((item) => item.textContent.trim().replace(/\s+/g, ' ')),
        }));
        check(topicFiltered.url.includes('topic=editoryal'), `${label}: arama konu filtresi URL state yazmadı.`);
        check(topicFiltered.visible.length === 1 && topicFiltered.visible[0].includes('Selene'), `${label}: Selene + Editoryal arama filtresi yanlış.`);

        await page.locator('[data-search-input]').fill('eşleşmeyecek-bir-ifade');
        check(await page.locator('[data-search-empty]').isVisible(), `${label}: sonuçsuz aramada boş durum görünmüyor.`);
        check(await page.evaluate(() => [...document.querySelectorAll('[data-search-item]')].every((item) => getComputedStyle(item).display === 'none')), `${label}: sonuçsuz aramada kayıtlar gizlenmedi.`);

        await page.goto(baseUrl, { waitUntil: 'networkidle' });
        const firstSave = page.locator('[data-feed-post]:not([hidden]) [data-save-button]').first();
        const savedSlug = await firstSave.getAttribute('data-save-slug');
        await firstSave.click();
        check(await page.evaluate((slug) => JSON.parse(localStorage.getItem('orbit-saved-posts') || '[]').includes(slug), savedSlug), `${label}: kaydetme localStorage'a yazılmadı.`);
        await page.goto(`${baseUrl}/saved`, { waitUntil: 'networkidle' });
        check(await page.locator('[data-saved-card]:visible').count() === 1, `${label}: Kaydedilenler tek kaydı göstermedi.`);
        check((await page.locator('[data-saved-summary]').textContent())?.includes('1 kayıt'), `${label}: Kaydedilenler özeti yanlış.`);
        await page.locator('[data-saved-card]:visible [data-save-button]').click();
        check(await page.locator('[data-saved-empty]').isVisible(), `${label}: kayıt kaldırılınca boş durum görünmedi.`);

        await page.goto(`${baseUrl}/topics/ajanlar`, { waitUntil: 'networkidle' });
        check(await page.locator('.topic-feed [data-feed-post]').count() === 5, `${label}: Ajan muhakemesi konusu beş kayıt göstermedi.`);
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: konu sayfası yatay taşıyor.`);
      }
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
