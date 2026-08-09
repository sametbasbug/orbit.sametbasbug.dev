/* Engelli kelime listesini özet dosyasına çevirir.
 *
 * Kaynak `.local/blocked-words.txt` — sürüm kontrolünün dışında ve öyle
 * kalmalı. Depoya giren tek şey bu betiğin ürettiği özet dosyası.
 *
 * Çalıştırma:  npm run words:build
 *
 * Kaynak dosya yalnız bu makinede duruyor. Kaybolursa liste geri gelmez —
 * özetler tek yönlü. Yeni kelime eklemek isteyen, kaynağı düzenleyip bu
 * betiği yeniden çalıştırır; kaynağı olmayan biri listeye ekleme yapamaz.
 * Bu bilinçli bir takas: listeyi düzenlemeyi zorlaştırıyor, ama depoda
 * sayfalarca hakaret durmuyor.
 *
 * Biçim: satır başına bir kelime, `#` ile başlayanlar yorum, boş satırlar
 * atlanır. Kelimeler burada da iskelete çevriliyor — yani kaynağa `sik`
 * yazmak `s1k` ve `siiik` biçimlerini de kapsıyor, ayrıca yazmak gerekmiyor.
 *
 * `=` ile başlayan satır "yalnız tam parça" demek: kelime bir handle'ın ya da
 * tire ile ayrılmış bir parçanın TAMAMINA eşitse yakalanır, içinde geçtiğinde
 * yakalanmaz. Bu işaret uzun ama masum kelimelerin içinde geçen sözcükler
 * için: `nazi` alt dize olarak arandığında Nazım ve Nazif'i, `rape` ise
 * "grape"i keser. Yanlış pozitifin bedeli burada gerçek bir isim.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fold, handleSkeleton } from '../src/server/identity/handle-skeleton.ts';

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, '../.local/blocked-words.txt');
const outputPath = resolve(here, '../src/server/identity/blocked-word-digests.json');

/* Alt dize olarak aranacak en kısa uzunluk. Dörtten kısa kelimeler alt dize
 * olarak aranmaz — `am`, `got` gibi parçalar sayısız masum adın içinde geçer
 * ve öyle bir liste engellediğinden çok fazlasını keser. Kısa kelimeler
 * yalnız tam parça eşleşmesiyle yakalanır. */
const MIN_SUBSTRING_LENGTH = 4;

let raw: string;
try {
  raw = readFileSync(sourcePath, 'utf8');
} catch {
  console.error(
    `Kaynak liste bulunamadı: ${sourcePath}\n`
    + 'Bu dosya kasıtlı olarak depoda değil. Satır başına bir kelime yazıp yeniden çalıştır.',
  );
  process.exit(1);
}

const entries = raw
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))
  .map((line) => ({
    exactOnly: line.startsWith('='),
    skeleton: handleSkeleton(line.startsWith('=') ? line.slice(1) : line),
  }))
  .filter((entry) => entry.skeleton !== '');

const substrings = new Set<string>();
const segments = new Set<string>();
let maxSubstringLength = MIN_SUBSTRING_LENGTH;

for (const { exactOnly, skeleton } of entries) {
  /* Her kelime parça kümesine de giriyor: alt dize taramasının uzunluk
   * penceresi ileride daralsa bile tam eşleşme kaçmasın. */
  segments.add(fold(skeleton));
  if (exactOnly || skeleton.length < MIN_SUBSTRING_LENGTH) continue;
  substrings.add(fold(skeleton));
  maxSubstringLength = Math.max(maxSubstringLength, skeleton.length);
}

const output = {
  /* ÜRETİLMİŞ DOSYA — elle düzenleme. Kaynak: .local/blocked-words.txt
   * Yeniden üretmek için: npm run words:build */
  generatedBy: 'scripts/build-blocked-words.ts',
  minSubstringLength: MIN_SUBSTRING_LENGTH,
  maxSubstringLength,
  substrings: [...substrings].sort(),
  segments: [...segments].sort(),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

console.log(
  `${entries.length} kelime → ${output.substrings.length} alt dize, `
  + `${output.segments.length} parça özeti yazıldı.`,
);
