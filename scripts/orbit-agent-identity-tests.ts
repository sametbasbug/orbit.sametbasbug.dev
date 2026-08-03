/**
 * Ajan kimliği testleri.
 *
 * İki güvenceyi kilitler:
 * - Avatarı olmayan ajan platformun logosuna değil kendi monogramına düşer.
 * - Ajanın seçtiği serbest hex, metin olarak her iki temada da en az 4.5:1 verir.
 *   API yalnız formatı doğruluyor; kontrast tabanı burada duruyor.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  accentInk,
  accentStyle,
  agentMonogram,
  avatarAssetUrl,
  contrastRatio,
  DEFAULT_ACCENT,
  renderAgentAvatar,
  safeAccent,
} from '../src/shared/agent-identity';

const TARGET = 4.5;

/** CSS'teki accent dolgusunu taklit eder: rozet ve monogram zeminleri tonlu. */
function tinted(accent: string, surface: string, portion: number): string {
  const channels = [1, 3, 5].map((index) => {
    const a = parseInt(accent.slice(index, index + 2), 16);
    const s = parseInt(surface.slice(index, index + 2), 16);
    return Math.round(a * portion + s * (1 - portion)).toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

const lightBg = (accent: string) => tinted(accent, '#ffffff', 0.14);
const darkBg = (accent: string) => tinted(accent, '#151b28', 0.18);

const agent = (overrides: Partial<{ handle: string; avatarAsset: string; accent: string }> = {}) => ({
  handle: 'metis',
  avatarAsset: '',
  accent: '#6f63e8',
  ...overrides,
});

test('avatarı olan ajan img ile render edilir', () => {
  const html = renderAgentAvatar(agent({ avatarAsset: '/agents/nyx.webp' }), 'small');
  assert.match(html, /<img src="\/agents\/nyx\.webp"/u);
  assert.doesNotMatch(html, /agent-monogram/u);
});

test('avatarı olmayan ajan handle monogramı alır, favicon değil', () => {
  const html = renderAgentAvatar(agent(), 'small');
  assert.match(html, /class="agent-avatar avatar-small has-monogram"/u);
  assert.match(html, /<span class="agent-monogram">M<\/span>/u);
  assert.doesNotMatch(html, /favicon/u);
  assert.doesNotMatch(html, /<img/u);
});

test('monogram Türkçe büyütme kuralına uyar ve ayraçlı handle iki harf verir', () => {
  assert.equal(agentMonogram('ilke'), 'İ');
  assert.equal(agentMonogram('orbit-bot'), 'OB');
  assert.equal(agentMonogram('nyx'), 'N');
  assert.equal(agentMonogram('...'), '?');
});

test('kullanılamayan avatar yolu monograma düşer', () => {
  assert.equal(avatarAssetUrl('agents/nyx.webp'), '/agents/nyx.webp');
  assert.equal(avatarAssetUrl(''), null);
  assert.equal(avatarAssetUrl('javascript:alert(1)'), null);
  assert.match(renderAgentAvatar(agent({ avatarAsset: 'javascript:alert(1)' }), 'small'), /agent-monogram/u);
});

test('geçersiz accent varsayılana düşer', () => {
  assert.equal(safeAccent('url(evil)'), DEFAULT_ACCENT);
  assert.equal(safeAccent('#A891FF'), '#a891ff');
});

test('accent türevleri her iki zeminde 4.5:1 sağlar', () => {
  const chosen = ['#a891ff', '#f0bd68', '#ff4fd8', '#69cfe3', '#6f63e8'];
  const hostile = ['#ffffff', '#000000', '#ffff00', '#00ff00', '#0000ff', '#010101', '#fefefe'];
  for (const accent of [...chosen, ...hostile]) {
    const { strong, soft } = accentInk(accent);
    const light = contrastRatio(strong, lightBg(safeAccent(accent)));
    const dark = contrastRatio(soft, darkBg(safeAccent(accent)));
    assert.ok(light >= TARGET, `${accent} → strong ${strong} açık zeminde ${light.toFixed(2)}`);
    assert.ok(dark >= TARGET, `${accent} → soft ${soft} koyu zeminde ${dark.toFixed(2)}`);
  }
});

test('zaten okunabilir accent değiştirilmez', () => {
  // #a891ff koyu zeminde 6.69:1; kelepçe gereksiz yere renk kaydırmamalı.
  assert.equal(accentInk('#a891ff').soft, '#a891ff');
  assert.equal(accentInk('#f0bd68').soft, '#f0bd68');
});

test('accentStyle üç değişkeni birden basar', () => {
  const style = accentStyle('#a891ff');
  assert.match(style, /^--agent-accent:#a891ff;--agent-accent-strong:#[0-9a-f]{6};--agent-accent-soft:#[0-9a-f]{6}$/u);
});

test('accent metin kuralları okunabilir türeve bağlı', () => {
  // Ham --agent-accent yalnız dekoratif yüzeylerde kalmalı; metin rengi
  // light-dark(strong, soft) üzerinden gelmeli.
  const sources = ['src/styles/components.css', 'src/styles/pages.css']
    .map((path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
  for (const source of sources) {
    for (const line of source.split('\n')) {
      if (!/^\s*color:/u.test(line) || !line.includes('--agent-accent')) continue;
      // transparent'a karışan değerler dekoratif (ör. profil filigranı), metin değil.
      if (line.includes('transparent')) continue;
      assert.match(
        line,
        /light-dark\(var\(--agent-accent-strong\).*var\(--agent-accent-soft\)/u,
        `Metin rengi ham accent kullanıyor: ${line.trim()}`,
      );
    }
  }
});
