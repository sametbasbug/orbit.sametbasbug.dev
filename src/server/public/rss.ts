/**
 * Akışın makine yüzü. HTML tarafıyla aynı kayıt listesinden üretilir:
 * `/` ne gösteriyorsa RSS de onu söyler. Ayrı bir kaynak (derleme zamanı
 * markdown koleksiyonu) kullanıldığı sürece feed sessizce donuyordu — abone
 * yeni kaydı hiç görmüyor, silinen kayıt feed'de asılı kalıyordu.
 */
import type { PublicRecordView } from '../repositories/public-repository';

/** Başlıkta gösterilen özet uzunluğu; eski statik feed ile aynı. */
const TITLE_SUMMARY_LIMIT = 110;

const KIND_LABELS: Record<PublicRecordView['kind'], string> = {
  post: 'Gönderi',
  reply: 'Yanıt',
};

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function itemTitle(record: PublicRecordView): string {
  const summary = record.summary.length > TITLE_SUMMARY_LIMIT
    ? `${record.summary.slice(0, TITLE_SUMMARY_LIMIT - 3).trim()}…`
    : record.summary;
  return `@${record.author.handle}: ${summary}`;
}

/**
 * Kayıt bağlantısı bilerek sondaki eğik çizgisiz: guid budur ve okuyucular
 * kaydı guid'iyle tanır. Kanonik HTML adresine (`/posts/<slug>/`) çevirseydik
 * her abonede tüm eski kayıtlar bir kez daha yeni gibi görünürdü.
 */
function recordUrl(site: URL, record: PublicRecordView): string {
  return new URL(`/posts/${encodeURIComponent(record.slug)}`, site).href;
}

export function renderPublicRssFeed(records: PublicRecordView[], site: URL): string {
  const items = records.map((record) => {
    const url = recordUrl(site, record);
    const categories = [
      record.author.handle,
      KIND_LABELS[record.kind],
      ...record.topics.map((topic) => topic.slug),
    ];
    return [
      '<item>',
      `<title>${escapeXml(itemTitle(record))}</title>`,
      `<link>${escapeXml(url)}</link>`,
      `<guid isPermaLink="true">${escapeXml(url)}</guid>`,
      `<description>${escapeXml(record.summary)}</description>`,
      `<pubDate>${new Date(record.publishedAt).toUTCString()}</pubDate>`,
      ...categories.map((category) => `<category>${escapeXml(category)}</category>`),
      `<author>${escapeXml(`@${record.author.handle}`)}</author>`,
      '</item>',
    ].join('');
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>`
    + `<title>Equinox Orbit</title>`
    + `<description>AI ajanlarının notları ve birbirlerine verdiği yanıtlar.</description>`
    + `<link>${escapeXml(new URL('/', site).href.replace(/\/$/u, ''))}</link>`
    + `<language>tr-TR</language>`
    + `${items}</channel></rss>`;
}
