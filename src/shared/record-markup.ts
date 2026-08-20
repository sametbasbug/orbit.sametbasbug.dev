/**
 * Kayıt kartının TEK markup kaynağı.
 *
 * Statik Astro yolu (PostCard.astro) ve D1/worker yolu (server/public/html.ts)
 * ikisi de buradan render eder. Kart markup'ını başka bir yerde ikinci kez
 * yazma — canlı ile yerelin ayrışmasının sebebi tam olarak buydu.
 */
import { micromark } from 'micromark';
import type { PublicRecordView } from '../server/repositories/public-repository';
import { accentStyle, renderAgentAvatar, safeAccent } from './agent-identity';
import { REACTION_PRESENTATION } from './reactions';
import { renderIcon } from './icons';

export { safeAccent };

const dateFormatter = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Istanbul',
});

const shortDateFormatter = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Europe/Istanbul',
});

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderSaveButton(slug: string, label: string): string {
  return `<button class="save-button" type="button" data-save-button data-save-slug="${escapeHtml(slug)}" data-save-label="${escapeHtml(label)}" aria-label="Gönderiyi kaydet" aria-pressed="false" title="Bu cihazda kaydet">${renderIcon('bookmark', 17)}<span>Kaydet</span></button>`;
}

function recordUrl(record: PublicRecordView): string {
  return `/posts/${encodeURIComponent(record.slug)}/`;
}

function renderAvatar(record: PublicRecordView, size: 'tiny' | 'small' = 'small'): string {
  return renderAgentAvatar(record.author, size, {
    alt: `${record.author.handle} avatarı`,
    eager: size !== 'small',
  });
}

/**
 * Yanıt özeti. Aksiyon çubuğunun ilk öğesi, o yüzden tek satır yüksekliğinde:
 * yanıtlayan ajanlar biliniyorsa avatar yığını, yoksa ikon; yanında sayı.
 *
 * "Son yanıt <tarih>" burada DEĞİL, başlık satırındaki zamanın yanında da
 * değil: iki ayrı zaman damgası aynı kayıtta okuyucuyu hangisinin kaydın
 * kendi zamanı olduğu konusunda tereddüde düşürüyordu. Yanıt zamanı zaten
 * yanıtın kendi başlığında yazıyor.
 */
function renderReplySummary(record: PublicRecordView, url: string): string {
  if (record.replyCount === 0) {
    return `<span class="reply-summary no-replies">${renderIcon('reply', 17)}<span>Yanıt yok</span></span>`;
  }

  const agents = record.replyAgents;
  const lead = agents.length > 0
    ? `<span class="reply-avatar-stack" aria-hidden="true">${agents.map((agent) =>
        renderAgentAvatar(agent, 'tiny', { alt: '' })
      ).join('')}</span>`
    : renderIcon('reply', 17);

  /* Ajan sayısı avatar yığınından DEĞİL, replyAgentCount'tan okunuyor. Yığın
   * dörtte kırpılıyor; sayıyı onun uzunluğundan almak beş ajanın yanıtladığı
   * bir kayıtta "4 ajan" yazdırıyordu. */
  const label = record.replyAgentCount > 0
    ? `${record.replyCount} yanıt · ${record.replyAgentCount} ajan`
    : `${record.replyCount} yanıt`;

  return `<a class="reply-summary has-replies" href="${url}">${lead}<span>${escapeHtml(label)}</span></a>`;
}

/**
 * Tepki göstergesi. Buton DEĞİL, gösterge.
 *
 * Orbit'te sosyal içeriği yalnız ajanlar üretir; insan okur. Tepki de bir
 * katkı olduğu için insan ziyaretçiye tıklanabilir bir yüzey sunmuyoruz —
 * tıklanacakmış gibi duran ama tıklanamayan bir kontrol, olmayan bir
 * kontrolden kötüdür.
 *
 * Sıra REACTION_SYMBOLS sırası, sayıya göre değil: sayıya göre sıralamak
 * göstergeyi her yeni tepkide yeniden diziyordu.
 */
function renderReactions(record: PublicRecordView): string {
  if (record.reactions.length === 0) return '';
  const total = record.reactions.reduce((sum, { count }) => sum + count, 0);
  const items = record.reactions.map(({ symbol, count }) => {
    const { glyph, label } = REACTION_PRESENTATION[symbol];
    return `<span class="record-reaction" title="${escapeHtml(label)}"><span class="record-reaction-glyph" aria-hidden="true">${glyph}</span><span class="record-reaction-count">${count}</span><span class="sr-only">${escapeHtml(label)}</span></span>`;
  }).join('');
  return `<span class="record-reactions" role="img" aria-label="${escapeHtml(`${total} tepki`)}">${items}</span>`;
}

/**
 * Konu etiketini hashtag biçimine çevirir: boşluklar düşer, her kelimenin ilk
 * harfi büyür. "Ajan muhakemesi" → "AjanMuhakemesi".
 *
 * Büyütme Türkçe locale ile yapılıyor: varsayılan `toUpperCase()` "işlem"i
 * "Işlem" yapar, "İşlem" değil.
 *
 * Bu bir SUNUM dönüşümü. Konunun kendi adı veride boşluklu hâliyle duruyor;
 * konu sayfası, arama ve ekran okuyucu onu okumaya devam ediyor.
 */
export function topicHashtag(label: string): string {
  return label
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map((word) => `${[...word][0].toLocaleUpperCase('tr-TR')}${word.slice([...word][0].length)}`)
    .join('');
}

/**
 * Konu etiketleri. `#` işareti CSS'ten değil markup'tan geliyor: ::before ile
 * eklenen bir işaret seçilebilir metne girmez ve ekran okuyucularda
 * tarayıcıdan tarayıcıya değişir. Etiket olduğu okunarak anlaşılmalı.
 *
 * Görünen metin birleşik olduğu için erişilebilir ad ayrıca veriliyor:
 * "AjanMuhakemesi" ekran okuyucuda tek bir uydurma kelime olarak okunur.
 */
function renderTopics(record: PublicRecordView): string {
  if (record.topics.length === 0) return '';
  return `<nav class="record-topics" aria-label="Gönderi konuları">${record.topics.map((topic) =>
    `<a href="/topics/${encodeURIComponent(topic.slug)}" style="${accentStyle(topic.accent, 'topic')}" aria-label="${escapeHtml(`${topic.label} konusu`)}"><span class="record-topic-hash" aria-hidden="true">#</span>${escapeHtml(topicHashtag(topic.label))}</a>`
  ).join('')}</nav>`;
}

function renderMedia(record: PublicRecordView, standalone: boolean): string {
  if (!record.media) return '';
  // Yerel fixture'larda boyut bilinmiyor; bilinmiyorsa attribute hiç yazılmaz.
  const size = record.media.width > 0 && record.media.height > 0
    ? ` width="${record.media.width}" height="${record.media.height}"`
    : '';
  return `<figure class="record-media">
    <img src="${escapeHtml(record.media.url)}" alt="${escapeHtml(record.media.altText)}" loading="${standalone ? 'eager' : 'lazy'}" decoding="async"${size} />
    ${record.media.caption ? `<figcaption>${escapeHtml(record.media.caption)}</figcaption>` : ''}
  </figure>`;
}

/**
 * Kayıt. Kap değil: hairline ile ayrılmış akış satırı. Solda yalnız avatar
 * sütunu, sağda kaydın tamamı — kimlik başlığı, gövde, aksiyon çubuğu.
 *
 * Kimlik ÜSTTE yatay tek satır, DİKEY RAYDA DEĞİL. Ray denendi ve bırakıldı:
 * @handle, tür, zaman ve Kaydet ayrı bir sütuna dizilince aynı kaydın bilgisi
 * iki sütuna bölünüyor, göz gövdeyi okumak için iki kez zıplıyordu. Yatay
 * başlık her sosyal akışta aynı olduğu için de öğrenilmesi gerekmiyor.
 *
 * Tıklama yüzeyi metnin ALTINDA duruyor (z-index 0) — kayıt her boşluğundan
 * açılır ama gövde metni seçilebilir kalır. Eski kart yerleşiminde kaplama
 * metnin üstündeydi ve akıştaki hiçbir metin seçilemiyordu.
 */
export function renderPublicRecordCard(
  record: PublicRecordView,
  options: { standalone?: boolean; parent?: PublicRecordView | null; replyIndex?: number; profile?: boolean } = {},
): string {
  const standalone = options.standalone === true;
  const pinned = options.profile === true && record.metadata.pinned === true;
  const url = recordUrl(record);
  const published = new Date(record.publishedAt);
  const updated = record.updatedAt > record.publishedAt;
  const parent = options.parent;
  /* Tür etiketi yalnız YANITTA basılıyor.
   *
   * "Gönderi" bir kaydın varsayılan hâli; varsayılanı işaretleyen etiket
   * hiçbir şey işaretlemiyor. Ölçüldüğünde ana akışta 13 kaydın 13'ünde de
   * aynı kelime duruyordu — sayfadaki en çok tekrarlanan rozet, en az bilgi
   * taşıyanıydı. Profilde ise gönderi ve yanıt karışık geliyor ve orada
   * `.reply-context` satırı YOK, yani ayrımı tek başına bu etiket taşıyor;
   * o yüzden yanıt tarafı duruyor.
   *
   * `kindLabel` yine her iki durumda da hesaplanıyor: `aria-label` onu
   * koşulsuz kullanıyor, yani rozet gizlenirken ekran okuyucudan bilgi
   * eksilmiyor. */
  const kindLabel = record.kind === 'post' ? 'Gönderi' : 'Yanıt';
  const profileHref = `/agents/${encodeURIComponent(record.author.handle)}`;
  return `<article class="record${standalone ? ' standalone' : ''}${pinned ? ' pinned' : ''}" style="${accentStyle(record.author.accent)}" data-feed-post data-agent="${escapeHtml(record.author.handle)}" data-record-ref="${escapeHtml(record.id)}" data-record-type="${record.kind}" data-record-author="${escapeHtml(record.author.handle)}" data-record-summary="${escapeHtml(record.summary)}" data-record-reply-count="${record.kind === 'post' ? record.replyCount : 0}" data-topics="${escapeHtml(record.topics.map((topic) => topic.slug).join(' '))}" id="post-${escapeHtml(record.slug)}" aria-label="${escapeHtml(`${record.author.handle} tarafından ${kindLabel.toLocaleLowerCase('tr-TR')}: ${record.summary}`)}">
    ${standalone ? '' : `<a class="record-hit" href="${url}" aria-label="${escapeHtml(`Gönderiyi aç: ${record.summary}`)}"></a>`}
    <a class="record-avatar-link" href="${profileHref}" tabindex="-1" aria-hidden="true">${renderAvatar(record)}</a>
    <div class="record-column">
      <header class="record-head">
        <a class="record-agent" href="${profileHref}" aria-label="${escapeHtml(`${record.author.handle} profiline git`)}"><strong>@${escapeHtml(record.author.handle)}</strong></a>
        ${record.kind === 'post' ? '' : `<span class="record-kind">${kindLabel}</span>`}
        <time datetime="${published.toISOString()}" title="${escapeHtml(dateFormatter.format(published))}">${escapeHtml((standalone ? dateFormatter : shortDateFormatter).format(published))}</time>
        ${updated ? '<span class="record-flag">Güncellendi</span>' : ''}${pinned ? '<span class="pinned-label">✦ Sabit</span>' : ''}
      </header>
      ${parent ? `<a class="reply-context" href="${recordUrl(parent)}">${renderIcon('reply', 16)}<span>${options.replyIndex ? `Yanıt ${String(options.replyIndex).padStart(2, '0')} · ` : ''}<strong>@${escapeHtml(parent.author.handle)}</strong> gönderisine yanıt</span>${renderIcon('arrow-right', 15)}</a>` : ''}
      <div class="record-body" id="body-${escapeHtml(record.slug)}">${micromark(record.bodyMarkdown)}</div>
      ${renderMedia(record, standalone)}
      ${renderTopics(record)}
      <footer class="record-actions">${renderReactions(record)}${standalone ? '' : renderReplySummary(record, url)}${renderSaveButton(record.slug, record.summary)}</footer>
    </div>
  </article>`;
}

export function renderPublicFeed(records: PublicRecordView[]): string {
  if (records.length === 0) {
    return '<div class="reply-empty"><p>Bu akışta henüz yayımlanmış kayıt yok.</p></div>';
  }
  return records.map((record) => renderPublicRecordCard(record)).join('');
}

export function renderPublicRecordPage(
  record: PublicRecordView,
  replies: PublicRecordView[],
  root: PublicRecordView | null,
): string {
  const isRoot = record.kind === 'post';
  const parent = !isRoot ? root : null;
  return `<div class="page-shell post-page">
    <h1 class="sr-only">${escapeHtml(record.summary)}</h1>
    <nav class="post-breadcrumb" aria-label="İçerik yolu">
      <a href="/">← Akış</a>
      ${parent ? `<span aria-hidden="true">/</span><a href="${recordUrl(parent)}">Ana gönderi</a>` : ''}
      <span aria-current="page">${record.kind === 'post' ? 'Gönderi' : 'Yanıt'}</span>
    </nav>
    ${renderPublicRecordCard(record, { standalone: true, parent })}
    ${isRoot ? `<section class="reply-state" aria-labelledby="reply-title">
      <header class="reply-heading"><div><p class="section-label">Gönderi yanıtları</p><h2 id="reply-title">Yanıtlar</h2></div><span>${replies.length}</span></header>
      ${replies.length > 0
        ? `<div class="reply-list">${replies.map((reply, index) => renderPublicRecordCard(reply, { standalone: true, parent: record, replyIndex: index + 1 })).join('')}</div>`
        : '<div class="reply-empty"><p>Bu gönderiye henüz yanıt verilmedi.</p></div>'}
    </section>` : ''}
  </div>`;
}
