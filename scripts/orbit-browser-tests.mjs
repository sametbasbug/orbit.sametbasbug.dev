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
const searchIndex = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'search-index.json'), 'utf8'));
const normalizeSearchText = (value) => String(value)
  .toLocaleLowerCase('tr-TR')
  .replaceAll('ı', 'i')
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .trim();
const seleneSearchCount = searchIndex.items.filter((item) => normalizeSearchText(item.searchText).includes('selene')).length;
const seleneEditorialCount = searchIndex.items.filter((item) => (
  normalizeSearchText(item.searchText).includes('selene') && item.topics.includes('editoryal')
)).length;
const orbitProjectSearchCount = searchIndex.items.filter((item) => item.project === 'orbit').length;
const orbitProjectRecordCount = searchIndex.items.filter((item) => item.entity === 'record' && item.project === 'orbit').length;
const agentTopicRecordCount = searchIndex.items.filter((item) => item.entity === 'record' && item.topics.includes('ajanlar')).length;

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
    { width: 1536, height: 900 },
  ];

  try {
    await Promise.all(viewports.map(async (viewport) => {
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
          filter: rect('.feed-filter'),
          firstPost: rect('[data-feed-post]'),
          feedPostCount: feedPosts.length,
          feedReplyCount: feedPosts.filter((post) => post.dataset.recordType === 'reply').length,
          feedRootTypeCount: feedPosts.filter((post) => post.dataset.recordType === 'post').length,
          replySummaryCount: document.querySelectorAll('.reply-summary.has-replies').length,
          cardHitAreaCount: document.querySelectorAll('.post-card-hit-area').length,
          noReplyStateCount: document.querySelectorAll('.reply-summary.no-replies').length,
          postAnchorCount: document.querySelectorAll('.post-anchor').length,
          feedViewFilterCount: document.querySelectorAll('[data-feed-view], .feed-view-filter').length,
          feedFilterLinkCount: document.querySelectorAll('.feed-filter a').length,
          activeFeedFilterText: document.querySelector('.feed-filter a[aria-current="page"]')?.textContent?.trim().replace(/\s+/g, ' '),
          paginationCount: document.querySelectorAll('[data-pagination]').length,
          heroExtraCount: document.querySelectorAll('.welcome-copy .section-label, .welcome-actions, .welcome-agents').length,
          feedHeadingCount: document.querySelectorAll('.feed-heading, #feed-title, [data-feed-result]').length,
          featuredCount: featuredPosts.length,
          nav: rect('.primary-nav'),
          navDisplay: getComputedStyle(navigation).display,
          headerSearch: rect('.header-search-form'),
          headerTopicCount: document.querySelectorAll('.header-topic').length,
          sideTopicVisible: (rect('.side-nav a[href="/topics"]')?.width || 0) > 0,
          brandEyebrow: document.querySelector('.brand-copy small')?.textContent?.trim(),
          brandEyebrowDisplay: getComputedStyle(document.querySelector('.brand-copy small')).display,
          brandName: document.querySelector('.brand-copy strong')?.textContent?.trim(),
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
      check(layout.hero.bottom <= layout.filter.y + 0.5, `${label}: hero ile ajan filtresi çakışıyor.`);
      check(layout.filter.y - layout.hero.bottom <= 24, `${label}: hero ile ajan filtresi arasındaki boşluk fazla (${layout.filter.y - layout.hero.bottom}px).`);
      check(layout.filter.bottom <= layout.firstPost.y + 0.5, `${label}: filtre ile ilk gönderi çakışıyor.`);
      check(layout.feedPostCount > 0 && layout.feedReplyCount === 0, `${label}: ana akışta kök olmayan yanıt kaydı var.`);
      check(layout.feedRootTypeCount === layout.feedPostCount, `${label}: ana akışta Gönderi/Yanıt dışında kayıt türü var.`);
      check(layout.cardHitAreaCount === layout.feedPostCount, `${label}: bütün akış kartları tıklanabilir yüzey taşımıyor.`);
      check(layout.replySummaryCount + layout.noReplyStateCount === layout.feedPostCount, `${label}: gönderilerin yanıt özeti veya yanıtsız durumu eksik.`);
      check(layout.postAnchorCount === 0, `${label}: kaldırılan kalıcı bağlantı simgesi DOM'da kaldı.`);
      check(layout.feedViewFilterCount === 0, `${label}: kaldırılan kayıt türü filtresi DOM'da kaldı.`);
      check(layout.feedFilterLinkCount === 5, `${label}: akış filtreleri gerçek rota bağlantılarına dönüşmedi.`);
      check(layout.activeFeedFilterText?.startsWith('Tüm ajanlar'), `${label}: ana akış filtresi aktif görünmüyor.`);
      check(layout.paginationCount === 0, `${label}: tek sayfalık mevcut akışta gereksiz pagination görünüyor.`);
      check(layout.heroExtraCount === 0, `${label}: kaldırılan hero öğeleri DOM'da kaldı.`);
      check(layout.feedHeadingCount === 0, `${label}: kaldırılan akış başlığı veya kayıt özeti DOM'da kaldı.`);
      check(layout.featuredCount <= 1, `${label}: ana akışta birden fazla featured gönderi var (${layout.featuredCount}).`);
      check(layout.featuredCount === 0, `${label}: kuruluş dönemi sonrası ana akışta featured kayıt kaldı.`);
      check(await page.locator('.header-search-form').count() === 1, `${label}: header arama formu eksik.`);
      check(layout.headerTopicCount === 0, `${label}: üst barda yinelenen Konular düğmesi kaldı.`);
      check(layout.sideTopicVisible === (viewport.width > 1260), `${label}: masaüstü sol rayındaki Konular bağlantısı yanlış.`);
      check(layout.brandEyebrow === 'Equinox' && layout.brandEyebrowDisplay !== 'none' && layout.brandName === 'Orbit', `${label}: marka adı Equinox Orbit olarak görünmüyor.`);
      check(pageErrors.length === 0, `${label}: sayfa hatası: ${pageErrors.join(' | ')}`);

      if (viewport.width <= 780) {
        check(layout.navDisplay === 'flex', `${label}: mobil alt navigasyon görünür değil.`);
        check(layout.headerSearch?.width === 0 || layout.headerSearch?.height === 0, `${label}: masaüstü arama formu mobilde gizlenmedi.`);
        check(await page.locator('.header-mobile-search').isVisible(), `${label}: mobil arama erişimi görünür değil.`);
        check(layout.navPosition === 'fixed', `${label}: mobil alt navigasyon fixed değil.`);
        check(layout.nav.x >= 0 && layout.nav.right <= layout.innerWidth && layout.nav.bottom <= viewport.height, `${label}: mobil alt navigasyon kırpılıyor.`);
        check(layout.navLinks.length === 5, `${label}: mobil navigasyonda beş öğe yok.`);
        const mobileNavText = (await page.locator('.primary-nav').textContent()) || '';
        check(mobileNavText.includes('Projeler'), `${label}: mobil navigasyonda Projeler bağlantısı yok.`);
        check(mobileNavText.includes('Konular'), `${label}: mobil navigasyonda Konular bağlantısı yok.`);
        check(mobileNavText.includes('Katıl'), `${label}: mobil navigasyonda ajan rehberi bağlantısı yok.`);
        check(!mobileNavText.includes('Yanıtlar'), `${label}: mobil navigasyonda kaldırılan Yanıtlar bağlantısı kaldı.`);
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
        check(Math.abs(layout.headerSearch.x - layout.hero.x) <= 1, `${label}: header araması ana içerik kolonuyla hizalı değil (${layout.headerSearch.x}/${layout.hero.x}).`);
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
        check((await page.locator('[data-search-summary]').textContent())?.trim() === `${seleneSearchCount} eşleşme bulundu`, `${label}: header araması doğru sonuç özetini üretmedi.`);
      }

      if (viewport.width === 390 || viewport.width === 1440) {
        await page.goto(`${baseUrl}/join`, { waitUntil: 'networkidle' });
        const joinState = await page.evaluate(() => {
          const flow = document.querySelector('.join-flow')?.getBoundingClientRect();
          return {
            innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            h1: document.querySelector('h1')?.textContent?.trim(),
            flowColumns: document.querySelector('.join-flow') ? getComputedStyle(document.querySelector('.join-flow')).gridTemplateColumns.split(' ').length : 0,
            flowRight: flow?.right ?? 0,
            activeNav: document.querySelector('.primary-nav a[aria-current="page"]')?.textContent?.trim(),
            machineHref: document.querySelector('a[href="/agent-guide.md"]')?.getAttribute('href'),
          };
        });
        check(joinState.h1 === 'Orbit’e katılmak isteyen ajanlar için giriş kapısı.', `${label}: ajan rehberi başlığı yanlış.`);
        check(joinState.scrollWidth <= joinState.innerWidth && joinState.flowRight <= joinState.innerWidth + 0.5, `${label}: ajan rehberi yatay taşıyor.`);
        check(joinState.flowColumns === (viewport.width <= 620 ? 1 : 5), `${label}: ajan rehberi kayıt akışı yanlış sütun sayısında.`);
        check(joinState.activeNav?.includes('Katıl'), `${label}: ajan rehberi mobil navigasyonda aktif değil.`);
        check(joinState.machineHref === '/agent-guide.md', `${label}: ajan rehberi Markdown sözleşmesine bağlanmıyor.`);

        await page.goto(`${baseUrl}/?view=replies`, { waitUntil: 'networkidle' });
        let feedState = await page.evaluate(() => ({
          url: location.href,
          visible: [...document.querySelectorAll('[data-feed-post]')]
            .filter((item) => !item.hidden)
            .map((item) => ({ agent: item.dataset.agent, type: item.dataset.recordType })),
        }));
        check(!feedState.url.includes('view='), `${label}: kaldırılan görünüm filtresi URL'de kaldı.`);
        check(feedState.visible.length > 0 && feedState.visible.every((item) => item.type !== 'reply'), `${label}: ana akışta yanıt kaydı kaldı.`);
        await page.locator('.feed-filter a[href="/feed/selene"]').click();
        await page.waitForURL(/\/feed\/selene$/);
        feedState = await page.evaluate(() => ({
          url: location.href,
          visible: [...document.querySelectorAll('[data-feed-post]')]
            .filter((item) => !item.hidden)
            .map((item) => ({ agent: item.dataset.agent, type: item.dataset.recordType })),
        }));
        check(new URL(feedState.url).pathname === '/feed/selene', `${label}: Selene filtresi kendi akış rotasını açmadı.`);
        check(feedState.visible.length > 0 && feedState.visible.every((item) => item.agent === 'selene' && item.type !== 'reply'), `${label}: Selene filtresi ilgisiz veya yanıt kaydı gösterdi.`);
        check((await page.locator('.feed-filter a[aria-current="page"]').textContent())?.includes('Selene'), `${label}: Selene filtresi aktif görünmüyor.`);
        const activeFilterVisibility = await page.evaluate(() => {
          const rail = document.querySelector('.feed-filter').getBoundingClientRect();
          const active = document.querySelector('.feed-filter a[aria-current="page"]').getBoundingClientRect();
          return active.left >= rail.left - 0.5 && active.right <= rail.right + 0.5;
        });
        check(activeFilterVisibility, `${label}: aktif Selene filtresi yatay şeritte görünür değil.`);

        await page.goto(`${baseUrl}/?agent=selene`, { waitUntil: 'networkidle' });
        await page.waitForURL(/\/feed\/selene$/);
        check(new URL(page.url()).pathname === '/feed/selene', `${label}: eski agent sorgusu filtrelenmiş akışa yönlenmedi.`);

        await page.goto(baseUrl, { waitUntil: 'networkidle' });
        await page.evaluate(() => {
          window.scrollTo(0, document.documentElement.scrollHeight);
          sessionStorage.setItem('orbit-pagination-scroll-top', 'true');
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForFunction(() => window.scrollY === 0);
        check(await page.evaluate(() => window.scrollY === 0), `${label}: pagination geçiş işareti sayfayı en üste taşımadı.`);

        await page.goto(`${baseUrl}/search?q=Selene`, { waitUntil: 'networkidle' });
        await page.waitForSelector('[data-search-item]:not([hidden])');
        const searchState = await page.evaluate(() => ({
          innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          summary: document.querySelector('[data-search-summary]')?.textContent?.trim(),
          visible: [...document.querySelectorAll('[data-search-item]')]
            .filter((item) => getComputedStyle(item).display !== 'none')
            .map((item) => item.textContent.trim().replace(/\s+/g, ' ')),
        }));
        check(searchState.scrollWidth <= searchState.innerWidth, `${label}: arama sayfası yatay taşıyor.`);
        check(searchState.summary === `${seleneSearchCount} eşleşme bulundu`, `${label}: Selene arama özeti yanlış (${searchState.summary}).`);
        check(searchState.visible.length === seleneSearchCount, `${label}: Selene araması indeksle aynı sayıda sonuç döndürmedi (${searchState.visible.length}/${seleneSearchCount}).`);
        check(searchState.visible.every((item) => item.includes('Selene')), `${label}: Selene aramasında ilgisiz sonuç var.`);

        await page.locator('[data-search-topic-filter]').selectOption('editoryal');
        const topicFiltered = await page.evaluate(() => ({
          url: location.href,
          visible: [...document.querySelectorAll('[data-search-item]')]
            .filter((item) => getComputedStyle(item).display !== 'none')
            .map((item) => item.textContent.trim().replace(/\s+/g, ' ')),
        }));
        check(topicFiltered.url.includes('topic=editoryal'), `${label}: arama konu filtresi URL state yazmadı.`);
        check(topicFiltered.visible.length === seleneEditorialCount && topicFiltered.visible.every((item) => item.includes('Selene')), `${label}: Selene + Editoryal arama filtresi yanlış.`);

        await page.goto(`${baseUrl}/search?q=katki`, { waitUntil: 'networkidle' });
        await page.waitForSelector('[data-search-item]:not([hidden])');
        const asciiTurkishSearch = await page.evaluate(() => ({
          summary: document.querySelector('[data-search-summary]')?.textContent?.trim(),
          visibleHrefs: [...document.querySelectorAll('[data-search-item]')]
            .filter((item) => getComputedStyle(item).display !== 'none')
            .map((item) => item.getAttribute('href')),
        }));
        check(!asciiTurkishSearch.summary?.startsWith('0 '), `${label}: ASCII katki sorgusu Türkçe katkı metnini bulmadı.`);
        check(asciiTurkishSearch.visibleHrefs.includes('/posts/katki-kime-ait'), `${label}: katki sorgusunda ana katkı gönderisi yok.`);

        await page.goto(`${baseUrl}/search`, { waitUntil: 'networkidle' });
        await page.waitForSelector('[data-search-item]:not([hidden])');
        await page.locator('[data-search-agent-filter]').selectOption('nyx');
        const filteredWithoutQuery = await page.evaluate(() => {
          const visible = [...document.querySelectorAll('[data-search-item]')]
            .filter((item) => getComputedStyle(item).display !== 'none').length;
          return { visible, summary: document.querySelector('[data-search-summary]')?.textContent?.trim() };
        });
        check(filteredWithoutQuery.summary === `${filteredWithoutQuery.visible} eşleşme bulundu`, `${label}: sorgusuz filtre sonucu yanlış sayılıyor.`);

        await page.locator('[data-search-input]').fill('eşleşmeyecek-bir-ifade');
        check(await page.locator('[data-search-empty]').isVisible(), `${label}: sonuçsuz aramada boş durum görünmüyor.`);
        check(await page.evaluate(() => [...document.querySelectorAll('[data-search-item]')].every((item) => getComputedStyle(item).display === 'none')), `${label}: sonuçsuz aramada kayıtlar gizlenmedi.`);

        await page.goto(`${baseUrl}/search?q=Equinox%20Haber`, { waitUntil: 'networkidle' });
        await page.waitForSelector('[data-search-item]:not([hidden])');
        const projectSearch = await page.evaluate(() => ({
          hrefs: [...document.querySelectorAll('[data-search-item]')]
            .filter((item) => getComputedStyle(item).display !== 'none')
            .map((item) => item.getAttribute('href')),
          overflow: document.documentElement.scrollWidth > innerWidth,
        }));
        check(projectSearch.hrefs.includes('/projects/haber'), `${label}: Equinox Haber aramasında proje sonucu yok.`);
        check(projectSearch.hrefs.includes('/posts/akis-gundem-degildir'), `${label}: Equinox Haber aramasında bağlı kayıt yok.`);
        check(!projectSearch.overflow, `${label}: proje araması yatay taşıyor.`);

        await page.goto(`${baseUrl}/search?project=orbit`, { waitUntil: 'networkidle' });
        await page.waitForSelector('[data-search-item]:not([hidden])');
        const projectFiltered = await page.evaluate(() => ({
          items: [...document.querySelectorAll('[data-search-item]')]
            .filter((item) => getComputedStyle(item).display !== 'none')
            .map((item) => ({ href: item.getAttribute('href'), project: item.dataset.searchProject })),
          summary: document.querySelector('[data-search-summary]')?.textContent?.trim(),
        }));
        check(projectFiltered.items.length === orbitProjectSearchCount && projectFiltered.items.every((item) => item.project === 'orbit'), `${label}: Orbit proje filtresi indeksle aynı sayıda sonuç döndürmedi.`);
        check(projectFiltered.summary === `${orbitProjectSearchCount} eşleşme bulundu`, `${label}: Orbit proje filtresi özeti yanlış (${projectFiltered.summary}).`);

        await page.goto(`${baseUrl}/projects`, { waitUntil: 'networkidle' });
        check(await page.locator('.project-directory [data-project-card]').count() === 6, `${label}: proje dizini altı kontrollü proje göstermiyor.`);
        check(await page.locator('[data-project-card="signal-drift"]').count() === 1, `${label}: Signal Drift proje dizininde görünmüyor.`);
        check(await page.locator('.footer-nav a[href="https://play.sametbasbug.dev"]').count() === 1, `${label}: Signal Drift footer bağlantısı eksik.`);
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: proje dizini yatay taşıyor.`);

        await page.goto(`${baseUrl}/projects/orbit`, { waitUntil: 'networkidle' });
        check(await page.locator('[data-project-detail="orbit"] .project-feed [data-feed-post]').count() === orbitProjectRecordCount, `${label}: Orbit proje sayfası indeksle aynı sayıda gerçek kayıt göstermiyor.`);
        check((await page.locator('.primary-nav a[aria-current="page"]').textContent())?.includes('Projeler'), `${label}: proje detayında Projeler navigasyonu aktif değil.`);
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: Orbit proje sayfası yatay taşıyor.`);

        await page.goto(`${baseUrl}/projects/status`, { waitUntil: 'networkidle' });
        check(await page.locator('.project-empty').isVisible(), `${label}: kayıtsız projede dürüst boş durum görünmüyor.`);
        check((await page.locator('.project-empty').textContent())?.includes('Henüz Orbit kaydı yok.'), `${label}: kayıtsız proje boş durum metni yanlış.`);

        await page.goto(`${baseUrl}/agents/nyx`, { waitUntil: 'networkidle' });
        const profileState = await page.evaluate(() => {
          const rect = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const box = element.getBoundingClientRect();
            return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
          };
          const stats = document.querySelector('.profile-summary-stats');
          return {
            innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            profile: document.querySelector('[data-agent-profile]')?.dataset.agentProfile,
            h1Count: document.querySelectorAll('h1').length,
            h1Text: document.querySelector('h1')?.textContent?.trim(),
            peerCount: document.querySelectorAll('.profile-peer-nav a').length,
            statCount: document.querySelectorAll('.profile-summary-stats > div').length,
            statColumns: stats ? getComputedStyle(stats).gridTemplateColumns.split(' ').length : 0,
            projectHrefs: [...document.querySelectorAll('.profile-project-links a')].map((link) => link.getAttribute('href')),
            oldCoverCount: document.querySelectorAll('.profile-cover').length,
            hero: rect('.profile-hero'),
            heroMain: rect('.profile-hero-main'),
            heroCopy: rect('.profile-hero-copy'),
            dossier: rect('.profile-dossier'),
            feedHeading: rect('.profile-feed-heading'),
          };
        });
        check(profileState.profile === 'nyx', `${label}: Nyx profil kimliği eksik.`);
        check(profileState.h1Count === 1 && profileState.h1Text === 'Nyx', `${label}: Nyx profil başlığı semantik olarak yanlış.`);
        check(profileState.peerCount === 3, `${label}: profilde diğer üç ajana geçiş yok.`);
        check(profileState.statCount === 4, `${label}: profil aktivite özeti dört gerçek ölçüm taşımıyor.`);
        check(profileState.projectHrefs.length === 4 && profileState.projectHrefs.includes('/projects/signal-drift'), `${label}: Nyx proje hatları Signal Drift dahil dört proje taşımıyor.`);
        check(profileState.oldCoverCount === 0, `${label}: kaldırılan tam genişlik profil kapağı DOM'da kaldı.`);
        check(profileState.scrollWidth <= profileState.innerWidth, `${label}: ajan profili yatay taşıyor.`);
        check(profileState.hero && profileState.hero.x >= 0 && profileState.hero.right <= profileState.innerWidth, `${label}: profil kimlik sahnesi viewport dışına taşıyor.`);
        check(profileState.dossier && profileState.feedHeading, `${label}: ajan dosyası veya aktivite başlığı ölçülemedi.`);
        if (viewport.width <= 520) {
          check(profileState.statColumns === 2, `${label}: mobil profil özeti iki sütuna düşmedi.`);
          check(profileState.heroMain.bottom <= profileState.heroCopy.y + 0.5, `${label}: mobil kimlik ve tanıtım metni çakışıyor.`);
          check(profileState.dossier.bottom <= profileState.feedHeading.y + 0.5, `${label}: mobil ajan dosyası aktivite başlığıyla çakışıyor.`);
        } else {
          check(profileState.statColumns === 4, `${label}: masaüstü profil özeti dört sütun değil.`);
          check(profileState.heroMain.right <= profileState.heroCopy.x + 0.5, `${label}: masaüstü kimlik ve tanıtım alanı çakışıyor.`);
          check(profileState.dossier.right <= profileState.feedHeading.x + 0.5, `${label}: masaüstü ajan dosyası aktivite kolonuyla çakışıyor.`);
        }
        check(pageErrors.length === 0, `${label}: profil turunda sayfa hatası: ${pageErrors.join(' | ')}`);

        await page.goto(baseUrl, { waitUntil: 'networkidle' });
        const firstSave = page.locator('[data-feed-post]:not([hidden]) [data-save-button]').first();
        const savedSlug = await firstSave.getAttribute('data-save-slug');
        await firstSave.click();
        check(await page.evaluate((slug) => JSON.parse(localStorage.getItem('orbit-saved-posts') || '[]').includes(slug), savedSlug), `${label}: kaydetme localStorage'a yazılmadı.`);
        await page.goto(`${baseUrl}/saved`, { waitUntil: 'networkidle' });
        await page.waitForSelector('[data-saved-card]');
        check(await page.locator('[data-saved-card]:visible').count() === 1, `${label}: Kaydedilenler tek kaydı göstermedi.`);
        check((await page.locator('[data-saved-summary]').textContent())?.includes('1 kayıt'), `${label}: Kaydedilenler özeti yanlış.`);
        await page.locator('[data-saved-card]:visible [data-saved-remove]').click();
        check(await page.locator('[data-saved-empty]').isVisible(), `${label}: kayıt kaldırılınca boş durum görünmedi.`);

        if (viewport.width === 1440) {
          await page.goto(baseUrl, { waitUntil: 'networkidle' });
          const firstCard = page.locator('[data-feed-post]').first();
          const hitArea = firstCard.locator('.post-card-hit-area');
          const hitAreaBox = await hitArea.boundingBox();
          const cardHref = await hitArea.getAttribute('href');
          check(Boolean(hitAreaBox && cardHref), `${label}: kart tıklama yüzeyi ölçülemedi.`);
          if (hitAreaBox && cardHref) {
            await page.mouse.click(hitAreaBox.x + hitAreaBox.width - 12, hitAreaBox.y + 12);
            await page.waitForURL((url) => decodeURIComponent(url.pathname) === cardHref);
            check(decodeURIComponent(new URL(page.url()).pathname) === cardHref, `${label}: kartın boş alanı gönderi sayfasını açmadı.`);
          }
        }

        await page.goto(`${baseUrl}/topics/ajanlar`, { waitUntil: 'networkidle' });
        check(await page.locator('.topic-feed [data-feed-post]').count() === agentTopicRecordCount, `${label}: Ajan muhakemesi konusu indeksle aynı sayıda kayıt göstermedi.`);
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: konu sayfası yatay taşıyor.`);

      }
      await context.close();
    }));
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
