/**
 * Görünüm regresyon aracı.
 *
 * Token refactor'ünün görünümü değiştirmediğini kanıtlamak için kullanılıyor:
 * belirlenen sayfalarda, iki temada, her elemanın hesaplanmış özelliklerini
 * toplar ve dosyaya yazar. Refactor öncesi/sonrası iki anlık görüntü diff'lenir.
 *
 *   node scripts/orbit-style-snapshot.mjs [--group renk|tip] <cikti.json>
 *   node scripts/orbit-style-snapshot.mjs --diff <once.json> <sonra.json>
 *
 * Tip grubunda diff, px cinsinden kaymayı da yazar; skala refactor'ünde amaç
 * sıfır fark değil, farkın eşiğin altında kaldığını görmek.
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
const GROUPS = {
  renk: ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor', 'outlineColor', 'boxShadow', 'backgroundImage'],
  tip: ['fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'textTransform', 'fontFamily'],
};

async function capture(outputPath, group) {
  const PROPS = GROUPS[group];
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
  writeFileSync(outputPath, JSON.stringify({ group, pages: snapshot }, null, 1));
  const count = Object.values(snapshot).reduce((total, page) => total + Object.keys(page).length, 0);
  console.log(`${group}: ${Object.keys(snapshot).length} sayfa-tema, ${count} eleman yazıldı: ${outputPath}`);
}

/** "13.6px|750|0.08em|..." içindeki px değerlerini çıkar. */
function pixels(value) {
  return [...value.matchAll(/(-?[\d.]+)px/gu)].map((match) => Number(match[1]));
}

/** İki kaydın px alanları arasındaki en büyük mutlak fark; px yoksa null. */
function drift(before, after) {
  const a = pixels(before);
  const b = pixels(after);
  if (a.length === 0 || a.length !== b.length) return null;
  return Math.max(...a.map((value, index) => Math.abs(value - b[index])));
}

function diff(beforePath, afterPath) {
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(readFileSync(afterPath, 'utf8'));
  if (before.group !== after.group) {
    throw new Error(`Farklı gruplar karşılaştırılamaz: ${before.group} ve ${after.group}`);
  }
  let changed = 0;
  let compared = 0;
  let worst = 0;

  for (const scope of Object.keys(before.pages)) {
    const a = before.pages[scope];
    const b = after.pages[scope] ?? {};
    for (const [key, value] of Object.entries(a)) {
      compared += 1;
      if (b[key] === undefined) {
        console.log(`[eksik]  ${scope}  ${key}`);
        changed += 1;
        continue;
      }
      if (b[key] !== value) {
        const shift = drift(value, b[key]);
        if (shift !== null) worst = Math.max(worst, shift);
        console.log(`[değişti] ${scope}  ${key}${shift === null ? '' : `  (${shift.toFixed(2)}px)`}\n    önce: ${value}\n    sonra: ${b[key]}`);
        changed += 1;
      }
    }
  }

  console.log(`\n${compared} eleman karşılaştırıldı, ${changed} fark.${worst ? ` En büyük kayma ${worst.toFixed(2)}px.` : ''}`);
  process.exitCode = changed === 0 ? 0 : 1;
}

const args = process.argv.slice(2);
if (args[0] === '--diff') {
  diff(args[1], args[2]);
} else {
  const group = args[0] === '--group' ? args[1] : 'renk';
  const output = args[0] === '--group' ? args[2] : args[0];
  if (!GROUPS[group]) throw new Error(`Bilinmeyen grup: ${group}. Seçenekler: ${Object.keys(GROUPS).join(', ')}`);
  await capture(output, group);
}
