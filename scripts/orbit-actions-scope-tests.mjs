#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { classifyChangedPaths } from './orbit-actions-scope.mjs';

test('classifies documentation-only changes without a deploy', () => {
  assert.equal(classifyChangedPaths(['docs/FUTURE_PLANS.md', 'README.md']), 'docs');
});

test('classifies public content and visual changes as frontend', () => {
  assert.equal(classifyChangedPaths(['src/components/PostCard.astro']), 'frontend');
  assert.equal(classifyChangedPaths(['src/content/records/posts/example/post.md']), 'frontend');
  assert.equal(classifyChangedPaths(['public/favicon.svg', 'docs/design.md']), 'frontend');
});

test('classifies backend and security-sensitive changes as full', () => {
  assert.equal(classifyChangedPaths(['src/server/http/api.ts']), 'full');
  assert.equal(classifyChangedPaths(['migrations/0016_pairing.sql']), 'full');
  assert.equal(classifyChangedPaths(['wrangler.production.live.jsonc']), 'full');
  assert.equal(classifyChangedPaths(['package-lock.json']), 'full');
  assert.equal(classifyChangedPaths(['.github/workflows/deploy-production.yml']), 'full');
});

test('escalates mixed and unknown changes to full', () => {
  assert.equal(classifyChangedPaths(['src/styles/global.css', 'src/server/http/api.ts']), 'full');
  assert.equal(classifyChangedPaths(['unknown/tool.config']), 'full');
  assert.equal(classifyChangedPaths([]), 'full');
});

/* Bölünmüş test listeleri, tam listenin tamamını kapsamak zorunda.
 *
 * Bu kilit bir boşluk bulunduğu için var. `test:d1` on altı dosya sayıyordu ama
 * deploy workflow'u yalnız üç bölünmüş listeyi koşuyor ve üç dosya (MCP
 * yetkilendirme, tek-renderer kilidi, skala kilidi) hiçbir listede değildi.
 * Yani `main`'e doğrudan push edilen bir değişiklik o üç dosya hiç
 * çalışmadan canlıya gidiyordu. Testler PR'da ve gece koşusunda çalıştığı için
 * ("npm run build" tam listeyi çağırıyor) dışarıdan hiçbir şey bozuk
 * görünmüyordu.
 *
 * Asıl kusur listelerin yanlış olması değil, yanlış olduklarının hiçbir yerde
 * görünmemesiydi: bir test dosyası eklemek iki yeri güncellemeyi gerektiriyor
 * ve ikincisini unutmak sessiz kalıyor. Bu test o sessizliği kaldırıyor. */
test('every D1 test file the full suite runs is also in exactly one split', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const testFiles = (script) => script.match(/scripts\/[\w.-]+/gu) ?? [];

  const full = testFiles(packageJson.scripts['test:d1']);
  const splitNames = ['test:d1:core', 'test:d1:publication', 'test:d1:platform'];
  const split = splitNames.flatMap((name) => testFiles(packageJson.scripts[name]));

  const missing = full.filter((file) => !split.includes(file));
  assert.deepEqual(missing, [], 'these files never run on the deploy path');

  const extra = split.filter((file) => !full.includes(file));
  assert.deepEqual(extra, [], 'these files run in a split but not in the full suite');

  const duplicated = split.filter((file, index) => split.indexOf(file) !== index);
  assert.deepEqual(duplicated, [], 'these files would run twice in one deploy');

  /* Bölünmüş listeler workflow'da gerçekten çağrılıyor mu. Dördüncü bir liste
   * eklenip workflow'a bağlanmazsa yukarıdaki üç kontrol yeşil kalır ve boşluk
   * yeni bir kılıkta geri döner. */
  const workflow = await readFile(
    new URL('../.github/workflows/deploy-production.yml', import.meta.url),
    'utf8',
  );
  for (const name of splitNames) {
    assert.ok(
      workflow.includes(`npm run ${name}`),
      `${name} is not run by the production deploy workflow`,
    );
  }
});
