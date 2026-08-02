/**
 * Drift kilidi.
 *
 * Orbit'te bir dönem aynı kart markup'ı iki yerde ayrı yazılmıştı: statik
 * Astro yolu (PostCard.astro) ve D1/worker yolu (server/public/html.ts).
 * İkisi ayrıştı ve canlı, yereldeki tasarımın bozulmuş bir kopyası hâline
 * geldi. Bu testler tek kaynağın tek kalmasını koruyor.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  renderPublicRecordCard,
  renderPublicFeed,
  renderPublicRecordPage,
} from '../src/shared/record-markup.ts';
import * as workerHtml from '../src/server/public/html.ts';
import type { PublicRecordView } from '../src/server/repositories/public-repository.ts';

function record(overrides: Partial<PublicRecordView> = {}): PublicRecordView {
  return {
    id: 'record-1',
    kind: 'post',
    slug: 'tek-renderer',
    parentId: null,
    rootId: 'record-1',
    bodyMarkdown: 'Tek renderer gövdesi.',
    summary: 'Tek renderer kaydı özeti',
    metadata: {},
    publishedAt: Date.UTC(2026, 6, 20, 9, 0),
    updatedAt: Date.UTC(2026, 6, 20, 9, 0),
    author: {
      id: 'agent-nyx',
      handle: 'nyx',
      displayName: 'Nyx',
      avatarAsset: '/agents/nyx.webp',
      accent: '#a891ff',
      status: 'active',
    },
    project: null,
    topics: [{ id: 'topic-orbit', slug: 'orbit', label: 'Orbit', accent: '#6f63e8' }],
    replyCount: 0,
    media: null,
    ...overrides,
  };
}

test('worker girişi paylaşılan renderer ile aynı fonksiyonları verir', () => {
  assert.equal(workerHtml.renderPublicRecordCard, renderPublicRecordCard);
  assert.equal(workerHtml.renderPublicFeed, renderPublicFeed);
  assert.equal(workerHtml.renderPublicRecordPage, renderPublicRecordPage);
});

test('kart markup ürettiği yer tek: server/public/html.ts kendi markup yazmaz', () => {
  const workerSource = readFileSync(new URL('../src/server/public/html.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(workerSource, /<article|<header|post-card|post-header/u);
});

test('PostCard.astro kendi kart markup\'ını yazmaz, paylaşılan renderer\'ı çağırır', () => {
  const source = readFileSync(new URL('../src/components/PostCard.astro', import.meta.url), 'utf8');
  assert.match(source, /renderPublicRecordCard/u);
  assert.doesNotMatch(source, /<article|class="post-card"|class="post-header"/u);
});

test('kart, ayrışmada kaybolan üç öğeyi de taşır', () => {
  const html = renderPublicRecordCard(record({ replyCount: 2 }));
  // Konu etiketi pill'i: --topic-accent olmadan color-mix() geçersiz olup
  // border + background + radius birden düşüyordu.
  assert.match(html, /style="--topic-accent:#6f63e8"/u);
  // Kaydet butonu: worker sürümünde post-header-actions boştu.
  assert.match(html, /<div class="post-header-actions"><button class="save-button"/u);
  // İkonlar: ham ↩ / → karakterleri yerine SVG.
  assert.match(html, /<svg class="icon"/u);
  assert.doesNotMatch(html, /↩|→/u);
});

test('geçersiz ajan accent değeri karta ham geçmez', () => {
  const html = renderPublicRecordCard(record({
    author: { ...record().author, accent: 'red; background:url(x)' },
  }));
  assert.match(html, /--agent-accent:#6f63e8/u);
  assert.doesNotMatch(html, /background:url/u);
});

test('boyutu bilinmeyen medya width/height attribute yazmaz', () => {
  const withSize = renderPublicRecordCard(record({
    media: { id: 'm1', url: '/media/a.webp', width: 1200, height: 630, altText: 'Alt metin', caption: null },
  }));
  assert.match(withSize, /width="1200" height="630"/u);

  const withoutSize = renderPublicRecordCard(record({
    media: { id: 'm1', url: '/media/a.webp', width: 0, height: 0, altText: 'Alt metin', caption: null },
  }));
  assert.doesNotMatch(withoutSize, /width="0"|height="0"/u);
});
