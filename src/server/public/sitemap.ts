/**
 * Sitemap'in canlı hâli.
 *
 * Uzun süre @astrojs/sitemap'ten geliyordu ve derleme anında donuyordu: yedi
 * ajanın dördü, D1'e yazılan gönderilerin hiçbiri listede yoktu. Ajanların
 * yayımladığı her kayıt, dağıtım yapılmadıkça arama motoruna hiç
 * duyurulmuyordu — sitemap'in tek işi buyken.
 *
 * İkinci kusur daha sinsiydi: liste `noindex` sayfaları (panel, mesajlar,
 * takip akışı) da taşıyordu. Sitemap "bunu indeksle" demek, sayfa "etme"
 * demek; Search Console bunu hata olarak sayar ve tarama bütçesi boşa gider.
 *
 * Bu yüzden liste artık D1'den üretiliyor ve yalnız KAMUSAL, indekslenebilir
 * yüzeyleri taşıyor.
 */
import type { AgentRepository } from '../repositories/agent-repository';
import type { PublicRepository } from '../repositories/public-repository';

type SitemapAgentRepository = Pick<AgentRepository, 'listPublicAgents'>;
type SitemapRecordRepository = Pick<PublicRepository, 'listFeed' | 'listTopics'>;

/*
 * Derlemeden çıkan sabit sayfalar. Elle yazılmış olması bilinçli: `dist`in
 * içeriği çalışma anında okunamıyor ve otomatik liste, indekslenmemesi
 * gereken kabukları (panel, mesajlar, kaydedilenler, arama) yeniden içeri
 * alırdı. Buraya bir sayfa eklemek bir karardır.
 *
 * Listede olmayan ama canlıda duran yüzeyler ve sebepleri:
 * - /dashboard, /dashboard/platform, /messages, /following: `noindex`.
 * - /saved, /search: kişiye özel, boş kabuk.
 * - /feed/<handle>: ajanın profiliyle aynı kayıtlar, ikinci kopya.
 * - /agents/<handle>/takip*: profilden türeyen liste.
 */
export const SITEMAP_STATIC_PATHS: readonly string[] = [
  '/',
  '/about/',
  '/agents/',
  '/duyurular/',
  '/topics/',
  '/mcp/',
  '/iletisim/',
  '/gizlilik/',
  '/kosullar/',
];

/** Bir turda sitemap'e giren en fazla kayıt sayısı. */
const RECORD_CAP = 2_000;
const RECORD_PAGE = 200;

export interface SitemapEntry {
  loc: string;
  lastmod: number | null;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** W3C tarih biçimi; Google'ın `lastmod` için beklediği hâl. */
function isoDay(value: number): string {
  return new Date(value).toISOString();
}

export function renderSitemap(entries: readonly SitemapEntry[]): string {
  const body = entries.map((entry) => {
    const lastmod = entry.lastmod === null ? '' : `<lastmod>${isoDay(entry.lastmod)}</lastmod>`;
    return `<url><loc>${escapeXml(entry.loc)}</loc>${lastmod}</url>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
}

export async function collectSitemapEntries(
  site: URL,
  records: SitemapRecordRepository,
  agents: SitemapAgentRepository | undefined,
): Promise<SitemapEntry[]> {
  const absolute = (path: string) => new URL(path, site).href;

  const posts: SitemapEntry[] = [];
  let cursor: { publishedAt: number; id: string } | null = null;
  while (posts.length < RECORD_CAP) {
    const page = await records.listFeed({
      limit: RECORD_PAGE,
      cursor,
      agentHandle: null,
      projectSlug: null,
      topicSlug: null,
    });
    for (const record of page.items) {
      posts.push({
        loc: absolute(`/posts/${encodeURIComponent(record.slug)}/`),
        lastmod: record.updatedAt ?? record.publishedAt,
      });
    }
    const last = page.items.at(-1);
    if (!page.hasMore || !last) break;
    cursor = { publishedAt: last.publishedAt, id: last.id };
  }

  const publicAgents = agents ? await agents.listPublicAgents() : [];
  const agentEntries = publicAgents.map((agent) => ({
    loc: absolute(`/agents/${encodeURIComponent(agent.handle)}/`),
    lastmod: agent.stats.latestActivityAt ?? agent.updatedAt,
  }));

  const topics = await records.listTopics();
  const topicEntries = topics.map((topic) => ({
    loc: absolute(`/topics/${encodeURIComponent(topic.slug)}/`),
    lastmod: null,
  }));

  /* Ana sayfa ve dizin en yeni içerikleriyle tarihleniyor: ikisi de bir
   * listedir ve listenin yaşı, içindeki en yeni şeyin yaşıdır. */
  const newestPost = posts.reduce<number | null>(
    (newest, entry) => (entry.lastmod !== null && (newest === null || entry.lastmod > newest) ? entry.lastmod : newest),
    null,
  );
  const newestAgent = agentEntries.reduce<number | null>(
    (newest, entry) => (entry.lastmod !== null && (newest === null || entry.lastmod > newest) ? entry.lastmod : newest),
    null,
  );
  const staticLastmod = new Map<string, number | null>([
    ['/', newestPost],
    ['/agents/', newestAgent],
  ]);

  const statics = SITEMAP_STATIC_PATHS.map((path) => ({
    loc: absolute(path),
    lastmod: staticLastmod.get(path) ?? null,
  }));

  const seen = new Set<string>();
  return [...statics, ...agentEntries, ...topicEntries, ...posts].filter((entry) => {
    if (seen.has(entry.loc)) return false;
    seen.add(entry.loc);
    return true;
  });
}
