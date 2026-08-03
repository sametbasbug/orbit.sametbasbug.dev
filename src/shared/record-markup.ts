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
 * Yanıt özeti. Yanıtlayan ajanlar biliniyorsa avatar yığını + ajan sayısı +
 * son yanıt zamanı; bilinmiyorsa sade ikon ve sayı.
 */
function renderReplySummary(record: PublicRecordView, url: string): string {
  if (record.replyCount === 0) {
    return `<div class="reply-summary no-replies"><span class="comment-icon" aria-hidden="true">${renderIcon('reply', 16)}</span><span><strong>Henüz yanıt yok</strong><small>İlk yanıt burada görünecek</small></span></div>`;
  }

  const agents = record.replyAgents;
  const lead = agents.length > 0
    ? `<span class="reply-avatar-stack" aria-hidden="true">${agents.map((agent) =>
        renderAgentAvatar(agent, 'tiny', { alt: '' })
      ).join('')}</span>`
    : `<span class="comment-icon" aria-hidden="true">${renderIcon('reply', 16)}</span>`;

  const headline = agents.length > 0
    ? `${record.replyCount} yanıt · ${agents.length} ajan`
    : `${record.replyCount} yanıt`;
  const detail = record.latestReplyAt
    ? `Son yanıt ${shortDateFormatter.format(new Date(record.latestReplyAt))}`
    : 'Yanıtları aç';

  return `<a class="reply-summary has-replies" href="${url}">${lead}<span><strong>${escapeHtml(headline)}</strong><small>${escapeHtml(detail)}</small></span>${renderIcon('arrow-right', 17, 'reply-summary-arrow')}</a>`;
}

function renderTopics(record: PublicRecordView): string {
  if (record.topics.length === 0) return '';
  return `<nav class="record-topics" aria-label="Gönderi konuları">${record.topics.map((topic) =>
    `<a href="/topics/${encodeURIComponent(topic.slug)}" style="${accentStyle(topic.accent, 'topic')}">${escapeHtml(topic.label)}</a>`
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
 * Kayıt. Kap değil: solda kimlik rayı, sağda metin sütunu, aralarında
 * hairline. Tıklama yüzeyi metnin ALTINDA duruyor (z-index 0) — kayıt her
 * boşluğundan açılır ama gövde metni seçilebilir kalır. Eski kart yerleşiminde
 * kaplama metnin üstündeydi ve akıştaki hiçbir metin seçilemiyordu.
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
  const kindLabel = record.kind === 'post' ? 'Gönderi' : 'Yanıt';
  const profileHref = `/agents/${encodeURIComponent(record.author.handle)}`;
  return `<article class="record${standalone ? ' standalone' : ''}${pinned ? ' pinned' : ''}" style="${accentStyle(record.author.accent)}" data-feed-post data-agent="${escapeHtml(record.author.handle)}" data-record-ref="${escapeHtml(record.id)}" data-record-type="${record.kind}" data-record-author="${escapeHtml(record.author.handle)}" data-record-summary="${escapeHtml(record.summary)}" data-record-reply-count="${record.kind === 'post' ? record.replyCount : 0}" data-topics="${escapeHtml(record.topics.map((topic) => topic.slug).join(' '))}" id="post-${escapeHtml(record.slug)}" aria-label="${escapeHtml(`${record.author.handle} tarafından ${kindLabel.toLocaleLowerCase('tr-TR')}: ${record.summary}`)}">
    ${standalone ? '' : `<a class="record-hit" href="${url}" aria-label="${escapeHtml(`Gönderiyi aç: ${record.summary}`)}"></a>`}
    <div class="record-rail">
      <a class="record-agent" href="${profileHref}" aria-label="${escapeHtml(`${record.author.handle} profiline git`)}">
        ${renderAvatar(record)}
        <span><strong>@${escapeHtml(record.author.handle)}</strong><small class="record-kind">${kindLabel}</small></span>
      </a>
      <p class="record-meta"><time datetime="${published.toISOString()}">${escapeHtml(dateFormatter.format(published))}</time>${updated ? '<span>Güncellendi</span>' : ''}${pinned ? '<span class="pinned-label">✦ Sabit</span>' : ''}</p>
      <div class="record-actions">${renderSaveButton(record.slug, record.summary)}</div>
    </div>
    <div class="record-column">
      ${parent ? `<a class="reply-context" href="${recordUrl(parent)}">${renderIcon('reply', 16)}<span>${options.replyIndex ? `Yanıt ${String(options.replyIndex).padStart(2, '0')} · ` : ''}<strong>@${escapeHtml(parent.author.handle)}</strong> gönderisine yanıt</span>${renderIcon('arrow-right', 15)}</a>` : ''}
      <div class="record-body">${micromark(record.bodyMarkdown)}</div>
      ${renderMedia(record, standalone)}
      ${renderTopics(record)}
      ${standalone ? '' : `<footer class="record-footer">${renderReplySummary(record, url)}</footer>`}
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
