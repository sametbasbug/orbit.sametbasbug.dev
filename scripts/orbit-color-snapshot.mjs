/**
 * Renk regresyon aracı.
 *
 * Semantik token refactor'ünün görünümü değiştirmediğini kanıtlamak için
 * kullanılıyor: belirlenen sayfalarda, iki temada, her elemanın hesaplanmış
 * renk özelliklerini toplar ve dosyaya yazar. Refactor öncesi/sonrası iki
 * anlık görüntü diff'lenir.
 *
 *   node scripts/orbit-color-snapshot.mjs <cikti.json>
 *   node scripts/orbit-color-snapshot.mjs --diff <once.json> <sonra.json>
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

/** orbit-browser-tests.mjs ile aynı çözümleme: sistemdeki Chrome'u kullan. */
function chromeExecutable() {
  return [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean).find((candidate) => existsSync(candidate));
}

const BASE = process.env.ORBIT_SNAPSHOT_BASE ?? 'http://localhost:4321';
const PAGES = ['/', '/agents', '/agents/nyx', '/posts/katki-kime-ait', '/topics', '/about', '/search', '/saved'];
const THEMES = ['light', 'dark'];
const PROPS = ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor', 'outlineColor', 'boxShadow', 'backgroundImage'];

async function capture(outputPath) {
  const executablePath = chromeExecutable();
  if (!executablePath) throw new Error('Desteklenen Chrome/Chromium executable bulunamadı.');
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const snapshot = {};

  for (const theme of THEMES) {
    for (const path of PAGES) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      await page.evaluate((value) => localStorage.setItem('orbit-theme', value), theme);
      await page.reload({ waitUntil: 'networkidle' });
      const entries = await page.evaluate((props) => {
        const result = [];
        document.querySelectorAll('*').forEach((element, index) => {
          const rect = element.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) return;
          const styles = getComputedStyle(element);
          const key = `${index}:${element.tagName.toLowerCase()}.${typeof element.className === 'string' ? element.className.trim().replace(/\s+/g, '.') : ''}`;
          result.push([key, props.map((prop) => styles[prop]).join('|')]);
        });
        return result;
      }, PROPS);
      snapshot[`${theme} ${path}`] = Object.fromEntries(entries);
    }
  }

  await browser.close();
  writeFileSync(outputPath, JSON.stringify(snapshot, null, 1));
  const count = Object.values(snapshot).reduce((total, page) => total + Object.keys(page).length, 0);
  console.log(`${Object.keys(snapshot).length} sayfa-tema, ${count} eleman yazıldı: ${outputPath}`);
}

function diff(beforePath, afterPath) {
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(readFileSync(afterPath, 'utf8'));
  let changed = 0;
  let compared = 0;

  for (const scope of Object.keys(before)) {
    const a = before[scope];
    const b = after[scope] ?? {};
    for (const [key, value] of Object.entries(a)) {
      compared += 1;
      if (b[key] === undefined) {
        console.log(`[eksik]  ${scope}  ${key}`);
        changed += 1;
        continue;
      }
      if (b[key] !== value) {
        console.log(`[değişti] ${scope}  ${key}\n    önce: ${value}\n    sonra: ${b[key]}`);
        changed += 1;
      }
    }
  }

  console.log(`\n${compared} eleman karşılaştırıldı, ${changed} fark.`);
  process.exitCode = changed === 0 ? 0 : 1;
}

const [first, ...rest] = process.argv.slice(2);
if (first === '--diff') diff(rest[0], rest[1]);
else await capture(first);
