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

/** tokens.css skalanın tanımlandığı yer; ham değer orada olmalı. */
const SCANNED = readdirSync(STYLE_DIR)
  .filter((name) => name.endsWith('.css') && name !== 'tokens.css')
  .sort();

/**
 * Skalanın dışında kalmasına karar verilen satırlar. Her biri kasıtlı:
 * viewport ile sürekli interpolasyon yapanlar kademe seçemez, hizalama ve
 * grafik ölçüleri ise ritimden değil kendi geometrisinden gelir.
 */
const EXEMPT: readonly RegExp[] = [
  /clamp\(/u,                    // akışkan hero başlıkları ve kabuk boşlukları
  /env\(safe-area-inset/u,       // cihaz çentiği, tasarım kararı değil
  /font-size:\s*(?:10|16)rem/u,  // dev monogram filigranı: tip değil grafik
  /letter-spacing:\s*-0\.1em/u,  // aynı filigranın sıkışması
  /line-height:\s*0;/u,          // ikon kutusunu çökerten yerleşim sıfırlaması
  /gap:\s*0\.02rem/u,            // 0.32px: boşluk değil, kıl payı itme
  /margin:\s*-1px !important/u,  // ekran okuyucu gizleme kalıbı, yerleşim değil
  /padding:\s*2px;/u,            // avatar halkası: kalınlığı kenarlığa bağlı, ritme değil
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

for (const file of SCANNED) {
  test(`${file} tip ve boşluk değerlerini skaladan alıyor`, () => {
    const source = readFileSync(new URL(file, STYLE_DIR), 'utf8');
    const offenders: string[] = [];

    for (const raw of source.split('\n')) {
      const line = raw.trim();
      if (!carriesLength(line)) continue;
      if (EXEMPT.some((pattern) => pattern.test(line))) continue;
      const axis = AXES.find(({ property }) => property.test(raw));
      if (!axis) continue;
      if (!line.includes(`var(${axis.token}`) || hasRawLength(line)) offenders.push(line);
    }

    assert.deepEqual(offenders, [], `${file} içinde skala dışı değer:\n  ${offenders.join('\n  ')}`);
  });
}

test('skalanın kendisi tokens.css dışında tanımlanmıyor', () => {
  for (const file of SCANNED) {
    const source = readFileSync(new URL(file, STYLE_DIR), 'utf8');
    assert.doesNotMatch(
      source,
      /^\s*--(?:text|weight|tracking|leading|space)-[\w-]+:/mu,
      `${file} skalayı yeniden tanımlıyor; kademe eklenecekse yeri tokens.css.`,
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
