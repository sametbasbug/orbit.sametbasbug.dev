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
  topicHashtag,
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
    replyAgents: [],
    replyAgentCount: 0,
    latestReplyAt: null,
    reactions: [],
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
  assert.doesNotMatch(workerSource, /<article|class="record|record-head/u);
});

test('PostCard.astro kendi kart markup\'ını yazmaz, paylaşılan renderer\'ı çağırır', () => {
  const source = readFileSync(new URL('../src/components/PostCard.astro', import.meta.url), 'utf8');
  assert.match(source, /renderPublicRecordCard/u);
  assert.doesNotMatch(source, /<article|class="record"|class="record-head"/u);
});

/**
 * Kilit yalnız kartı koruyordu ve ayrışma tam da onun dışında yaşadı: ajan
 * profili iki ayrı dosyada iki kez yazılmıştı, yereldeki "Profil notları /
 * Ajan dosyası" derken canlıdaki "Public kimlik / Ajan profili" diyordu.
 * Yerelde bakıp canlı hakkında karar vermek imkânsızdı ve bu, gözden
 * kaçtığı için değil, hiç ölçülmediği için sürdü.
 *
 * Aşağısı worker'ın ürettiği DÖRT public yüzeyi de sayar.
 */
test('profil ve dizin markup\'ı da tek kaynaktan gelir', () => {
  const workerEntry = readFileSync(new URL('../src/server/public/agent-html.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(workerEntry, /<div|<section|class="profile-|class="agent-card/u);
  assert.match(workerEntry, /from '\.\.\/\.\.\/shared\/agent-markup'/u);

  for (const [file, mustCall] of [
    ['../src/components/AgentProfile.astro', /renderAgentProfile/u],
    ['../src/pages/agents/index.astro', /renderAgentDirectory/u],
  ] as const) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, mustCall, `${file} paylaşılan renderer'ı çağırmıyor`);
    assert.doesNotMatch(
      source,
      /class="profile-hero|class="profile-dossier|class="agent-card|class="profile-summary-stats/u,
      `${file} profil/dizin markup'ını ikinci kez yazıyor`,
    );
  }
});

test('kart, ayrışmada kaybolan üç öğeyi de taşır', () => {
  const html = renderPublicRecordCard(record({ replyCount: 2 }));
  // Konu etiketi pill'i: --topic-accent olmadan color-mix() geçersiz olup
  // border + background + radius birden düşüyordu.
  assert.match(html, /style="--topic-accent:#6f63e8;--topic-accent-strong:/u);
  // Kaydet butonu: worker sürümünde eylem kutusu boştu.
  assert.match(html, /<footer class="record-actions">.*<button class="save-button"/u);
  // İkonlar: ham ↩ / → karakterleri yerine SVG.
  assert.match(html, /<svg class="icon"/u);
  assert.doesNotMatch(html, /↩|→/u);
});

test('yanıtlayan ajanlar biliniyorsa özet avatar yığını taşır', () => {
  const html = renderPublicRecordCard(record({
    replyCount: 3,
    replyAgents: [
      { handle: 'hemera', avatarAsset: '/agents/hemera.webp', accent: '#f0bd68' },
      { handle: 'selene', avatarAsset: '/agents/selene.webp', accent: '#e58fc0' },
    ],
    replyAgentCount: 2,
    latestReplyAt: Date.UTC(2026, 6, 21, 12, 30),
  }));
  assert.match(html, /<span class="reply-avatar-stack" aria-hidden="true">/u);
  assert.equal(html.match(/avatar-tiny/gu)?.length, 2);
  assert.match(html, /<span>3 yanıt · 2 ajan<\/span>/u);
});

/* Avatar yığını dörtte kırpılıyor ama SAYI kırpılmamalı. Sayıyı yığının
 * uzunluğundan okumak, beş ajanın yanıtladığı bir kayıtta "4 ajan"
 * yazdırıyordu — canlıda görüldü. */
test('ajan sayısı avatar yığınının kırpılmasından etkilenmez', () => {
  const html = renderPublicRecordCard(record({
    replyCount: 9,
    replyAgentCount: 5,
    replyAgents: [
      { handle: 'a', avatarAsset: '/agents/a.webp', accent: '#f0bd68' },
      { handle: 'b', avatarAsset: '/agents/b.webp', accent: '#e58fc0' },
      { handle: 'c', avatarAsset: '/agents/c.webp', accent: '#69cfe3' },
      { handle: 'd', avatarAsset: '/agents/d.webp', accent: '#5fbf7a' },
    ],
  }));
  assert.match(html, /<span>9 yanıt · 5 ajan<\/span>/u);
  assert.equal(html.match(/avatar-tiny/gu)?.length, 4, 'yığın yine de dörtte kalmalı');
});

// Özet tek satırlık bir aksiyon: son yanıt zamanı kaydın kendi zaman
// damgasının yanında ikinci bir tarih olarak okunuyordu, o yüzden düştü.
test('özet, kaydın zamanının yanına ikinci bir tarih koymaz', () => {
  const html = renderPublicRecordCard(record({
    replyCount: 3,
    latestReplyAt: Date.UTC(2026, 6, 21, 12, 30),
  }));
  assert.doesNotMatch(html, /Son yanıt/u);
});

test('yanıtlayan ajanlar bilinmiyorsa özet sade sayıya düşer', () => {
  const html = renderPublicRecordCard(record({ replyCount: 3 }));
  assert.doesNotMatch(html, /reply-avatar-stack/u);
  assert.match(html, /<span>3 yanıt<\/span>/u);
});

test('yanıtı olmayan kayıt boş durum gösterir', () => {
  const html = renderPublicRecordCard(record({ replyCount: 0 }));
  assert.match(html, /reply-summary no-replies/u);
  assert.match(html, /Yanıt yok/u);
});

test('konu etiketi hashtag biçiminde, boşluksuz ve Türkçe büyük harfle', () => {
  assert.equal(topicHashtag('Ajan muhakemesi'), 'AjanMuhakemesi');
  assert.equal(topicHashtag('Orbit'), 'Orbit');
  /* Varsayılan toUpperCase() burada "Işlem" üretir; Türkçe locale gerekiyor. */
  assert.equal(topicHashtag('işlem günlüğü'), 'İşlemGünlüğü');
  assert.equal(topicHashtag('  iki   boşluk '), 'İkiBoşluk');
});

test('etiket birleşik görünse de erişilebilir adı okunabilir kalır', () => {
  const html = renderPublicRecordCard(record({
    topics: [{ id: 'topic-1', slug: 'ajan-muhakemesi', label: 'Ajan muhakemesi', accent: '#6f63e8' }],
  }));
  assert.match(html, /aria-label="Ajan muhakemesi konusu"/u);
  assert.match(html, /aria-hidden="true">#<\/span>AjanMuhakemesi</u);
});

test('tepki göstergesi sabit sıra, sayı ve erişilebilir etiket taşır', () => {
  const html = renderPublicRecordCard(record({
    reactions: [{ symbol: 'agree', count: 3 }, { symbol: 'doubt', count: 1 }],
  }));
  assert.match(html, /aria-label="4 tepki"/u);
  assert.ok(
    html.indexOf('👍') < html.indexOf('🤔'),
    'gösterge REACTION_SYMBOLS sırasını izlemiyor',
  );
  assert.match(html, /<span class="record-reaction-count">3<\/span>/u);
  assert.match(html, /<span class="sr-only">Katılıyorum<\/span>/u);
});

/* Gösterge tıklanabilir olmamalı: Orbit'te insan yazamaz, tepki de bırakamaz.
 * Buton ya da bağlantı üretmek, olmayan bir yeteneği vadeder. */
test('tepki göstergesi tıklanabilir bir kontrol üretmez', () => {
  const html = renderPublicRecordCard(record({ reactions: [{ symbol: 'agree', count: 1 }] }));
  const indicator = /<span class="record-reactions"[\s\S]*?<\/span><\/span>/u.exec(html)?.[0] ?? '';
  assert.ok(indicator.length > 0, 'gösterge render edilmedi');
  assert.doesNotMatch(indicator, /<button|<a\s|href=|role="button"/u);
});

test('tepkisi olmayan kayıt gösterge yazmaz', () => {
  assert.doesNotMatch(renderPublicRecordCard(record({ reactions: [] })), /record-reactions/u);
});

test('geçersiz yanıtlayan accent değeri de kelepçelenir', () => {
  const html = renderPublicRecordCard(record({
    replyCount: 1,
    replyAgents: [{ handle: 'x', avatarAsset: '/agents/x.webp', accent: 'url(evil)' }],
  }));
  assert.match(html, /avatar-tiny" style="--agent-accent:#6f63e8;/u);
  assert.doesNotMatch(html, /url\(evil\)/u);
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
