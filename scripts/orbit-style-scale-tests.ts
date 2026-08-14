/**
 * Skala kilidi.
 *
 * Tip ve boşluk değerleri bir dönem bileşen bileşen elle yazılıyordu: 52 ayrı
 * punto, 70 ayrı boşluk, hiçbiri diğerine göre seçilmemiş. Skalaya indirildi;
 * bu testler geri dağılmasını engelliyor. Yeni bir bileşen ham rem yazarsa
 * burada durur.
 *
 * Bir değer gerçekten skalanın dışındaysa (akışkan clamp'ler, hizalama
 * sabitleri, grafik boyutları) EXEMPT listesine gerekçesiyle eklenir —
 * sessizce ham değer bırakılmaz.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const STYLE_DIR = new URL('../src/styles/', import.meta.url);
const SRC_DIR = new URL('../src/', import.meta.url);

/** tokens.css skalanın tanımlandığı yer; ham değer orada olmalı. */
const CSS_FILES = readdirSync(STYLE_DIR)
  .filter((name) => name.endsWith('.css') && name !== 'tokens.css')
  .sort()
  .map((name) => ({ label: `styles/${name}`, css: readFileSync(new URL(name, STYLE_DIR), 'utf8') }));

/**
 * `.astro` dosyalarının içindeki `<style>` blokları.
 *
 * Kilit bir dönem yalnız `src/styles/` klasörünü tarıyordu ve panel stilini
 * sayfanın kendi içinde tuttuğu için hiç görmüyordu: dashboard'da 110,
 * platform sayfasında 40, avatar yükleme sayfasında 17 ham değer birikmişti.
 * Aralarında dört ayrı "küçük yazı" vardı — 0.76, 0.78, 0.80, 0.82 — hepsi
 * aynı kademeyi istiyordu ve aralarındaki fark yarım pikseldi.
 *
 * Kapsamı klasöre değil kalıba bağlamak önemliydi: yeni bir sayfa stilini
 * yine kendi içinde tutabilir, ama artık kilidin dışında kalamaz.
 */
function astroFiles(dir: URL): { label: string; css: string }[] {
  const found: { label: string; css: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      found.push(...astroFiles(new URL(`${entry.name}/`, dir)));
      continue;
    }
    if (!entry.name.endsWith('.astro')) continue;
    const source = readFileSync(new URL(entry.name, dir), 'utf8');
    const blocks = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gu)].map((match) => match[1]!);
    if (blocks.length === 0) continue;
    const relative = new URL('.', dir).href.slice(SRC_DIR.href.length);
    found.push({ label: `${relative}${entry.name}`, css: blocks.join('\n') });
  }
  return found;
}

const SCANNED = [...CSS_FILES, ...astroFiles(SRC_DIR)];

/**
 * Skalanın dışında kalmasına karar verilen bildirimler. Her biri kasıtlı:
 * viewport ile sürekli interpolasyon yapanlar kademe seçemez, hizalama ve
 * grafik ölçüleri ise ritimden değil kendi geometrisinden gelir.
 *
 * Kalıplar bildirimin SONUNA çapalı, satırın değil: tarama artık `;` ve `{}`
 * üzerinden bölüyor, yani noktalı virgül kalıba dahil edilirse istisna hiç
 * eşleşmez.
 */
const EXEMPT: readonly RegExp[] = [
  /clamp\(/u,                    // akışkan hero başlıkları ve kabuk boşlukları
  /env\(safe-area-inset/u,       // cihaz çentiği, tasarım kararı değil
  /font-size:\s*(?:10|16)rem/u,  // dev monogram filigranı: tip değil grafik
  /letter-spacing:\s*-0\.1em/u,  // aynı filigranın sıkışması
  /line-height:\s*0$/u,          // ikon kutusunu çökerten yerleşim sıfırlaması
  /gap:\s*0\.02rem/u,            // 0.32px: boşluk değil, kıl payı itme
  /margin:\s*-1px !important/u,  // ekran okuyucu gizleme kalıbı, yerleşim değil
  /padding:\s*2px$/u,            // avatar halkası: kalınlığı kenarlığa bağlı, ritme değil
];

type Axis = { readonly property: RegExp; readonly token: string };

const AXES: readonly Axis[] = [
  { property: /^\s*font-size:/u, token: '--text-' },
  { property: /^\s*font-weight:/u, token: '--weight-' },
  { property: /^\s*letter-spacing:/u, token: '--tracking-' },
  { property: /^\s*line-height:/u, token: '--leading-' },
  { property: /^\s*(?:margin|padding)(?:-(?:top|bottom|left|right))?:/u, token: '--space-' },
  { property: /^\s*(?:row-|column-)?gap:/u, token: '--space-' },
];

/** Sayısal bir uzunluk mu taşıyor? `margin: 0` ya da `inherit` sayılmaz. */
function carriesLength(line: string): boolean {
  return /[\d.]+(?:rem|em|px)/u.test(line);
}

/**
 * Token ifadeleri çıkarıldıktan sonra geriye ham uzunluk kalıyor mu?
 *
 * Satırda tek bir var() aramak yetmiyordu: `margin: 0.9rem var(--space-8)`
 * gibi karışık bir kısa yazım, içindeki tek token yüzünden testten geçiyordu.
 */
function hasRawLength(line: string): boolean {
  return carriesLength(line.replaceAll(/var\(--[\w-]+\)/gu, ''));
}

/**
 * Bildirim bildirim tara, satır satır değil.
 *
 * Eski tarama satırı bir bütün olarak alıyor ve ekseni `^\s*font-size:`
 * gibi satır başına çapalı bir kalıpla arıyordu. `src/styles/` altındaki
 * dosyalar satırda tek bildirim tuttuğu için bu yürüyordu; ama tek satıra
 * sığdırılmış bir kuralda — `.foo { font-size: .78rem; margin: .5rem; }` —
 * hiçbir eksen eşleşmiyor ve kural sessizce kilidin altından geçiyordu.
 */
function declarations(css: string): string[] {
  return css
    .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    .split(/[;{}]/u)
    .map((part) => part.trim())
    .filter((part) => part.includes(':'));
}

for (const { label, css } of SCANNED) {
  test(`${label} tip ve boşluk değerlerini skaladan alıyor`, () => {
    const offenders: string[] = [];

    for (const declaration of declarations(css)) {
      if (!carriesLength(declaration)) continue;
      if (EXEMPT.some((pattern) => pattern.test(declaration))) continue;
      const axis = AXES.find(({ property }) => property.test(declaration));
      if (!axis) continue;
      if (!declaration.includes(`var(${axis.token}`) || hasRawLength(declaration)) {
        offenders.push(declaration);
      }
    }

    assert.deepEqual(offenders, [], `${label} içinde skala dışı değer:\n  ${offenders.join('\n  ')}`);
  });
}

test('skalanın kendisi tokens.css dışında tanımlanmıyor', () => {
  for (const { label, css } of SCANNED) {
    assert.doesNotMatch(
      css,
      /^\s*--(?:text|weight|tracking|leading|space)-[\w-]+:/mu,
      `${label} skalayı yeniden tanımlıyor; kademe eklenecekse yeri tokens.css.`,
    );
  }
});

/** tokens.css'ten bir eksenin kademelerini tanım sırasıyla oku. */
function rungs(prefix: string): { name: string; value: number }[] {
  const tokens = readFileSync(new URL('tokens.css', STYLE_DIR), 'utf8');
  return [...tokens.matchAll(new RegExp(`^\\s*(--${prefix}-[\\w-]+):\\s*([\\d.]+)rem;`, 'gmu'))]
    .map((match) => ({ name: match[1]!, value: Number(match[2]) }));
}

/**
 * Skalanın kullanılmayan kademesi ölü token değil: tip skalası kullanımdan
 * değil orandan doğuyor, boşluk skalası da indeks yasasından. Kilitlenmesi
 * gereken şey kademelerin kullanılıyor olması değil, aralarındaki ilişki.
 */
test('tip skalası 1.125 oranını koruyor', () => {
  const steps = rungs('text');
  assert.equal(steps.length, 14, 'Tip skalasının kademe sayısı değişmiş.');
  for (let index = 1; index < steps.length; index += 1) {
    const ratio = steps[index]!.value / steps[index - 1]!.value;
    assert.ok(
      Math.abs(ratio - 1.125) < 0.005,
      `${steps[index - 1]!.name} -> ${steps[index]!.name} oranı ${ratio.toFixed(4)}, 1.125 olmalı.`,
    );
  }
});

test('boşluk skalasında sayı piksel/2 demek', () => {
  const steps = rungs('space');
  assert.ok(steps.length >= 18, `Boşluk skalası beklenenden küçük: ${steps.length}.`);
  for (const { name, value } of steps) {
    const index = Number(name.replace('--space-', ''));
    assert.equal(value * 16, index * 2, `${name} indeksiyle uyumsuz: ${value}rem = ${value * 16}px.`);
  }
});
