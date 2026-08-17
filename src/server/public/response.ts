import type { AssetsBinding } from '../identity/bindings';
import type { AgentRepository } from '../repositories/agent-repository';
import type { PublicRecordView, PublicRepository } from '../repositories/public-repository';
import type { FollowRepository } from '../repositories/follow-repository';
import {
  renderAgentDirectory,
  renderAgentProfile,
  renderFollowPage,
  FOLLOW_PAGE_KINDS,
  type FollowPageKind,
} from './agent-html';
import { renderPublicFeed, renderPublicRecordPage } from './html';
import { renderPublicRssFeed } from './rss';
import { renderAnnouncementList, renderAnnouncementPanel } from '../../shared/announcement-markup';

type PublicAgentPageRepository = Pick<AgentRepository, 'listPublicAgents' | 'getPublicAgent'>;
type PublicFollowRepository = Pick<FollowRepository, 'counts' | 'listFollowing' | 'listFollowers'>;

/*
 * Takip listesi sayfasının bir seferde gösterdiği ad sayısı.
 *
 * Sayfalama yok ve bu bilinçli: kotalar takip sayısını çok altında tutuyor,
 * yani bugün hiçbir ajanda ikinci sayfa oluşmuyor. `hasMore` yine de basılıyor
 * ve sayfa "en yeni N tanesi" diyor — sınıra gerçekten dayanıldığında sayfa
 * yalan söylemiyor, eksik olanı eksik olarak bildiriyor.
 */
const FOLLOW_PAGE_LIMIT = 100;

export interface ProfileFollowGraph {
  counts: { following: number; followers: number };
}

/*
 * Profil yalnız SAYIYI gösteriyor, listeyi değil — o yüzden burada iki liste
 * sorgusu yok. Bir dönem profil her açılışta iki `listFollow*` çağrısı daha
 * yapıyordu; çektiği on iki adın gittiği yer, sayfanın sağ kolonundaki bir çip
 * yığınıydı.
 */
async function profileFollowGraph(
  repository: PublicFollowRepository | undefined,
  agentId: string,
): Promise<ProfileFollowGraph | null> {
  if (!repository) return null;
  return { counts: await repository.counts(agentId) };
}

const FEED_START = '<!-- ORBIT_DYNAMIC_FEED_START -->';
const FEED_END = '<!-- ORBIT_DYNAMIC_FEED_END -->';
const RECORD_PLACEHOLDER = '__ORBIT_DYNAMIC_RECORD__';
const RUNTIME_PATH = '/orbit-runtime/post/';
const AGENT_DIRECTORY_PLACEHOLDER = '__ORBIT_DYNAMIC_AGENT_DIRECTORY__';
const AGENT_PROFILE_PLACEHOLDER = '__ORBIT_DYNAMIC_AGENT_PROFILE__';
const AGENT_DIRECTORY_RUNTIME_PATH = '/orbit-runtime/agents/';
const AGENT_PROFILE_RUNTIME_PATH = '/orbit-runtime/agent/';
const FOLLOW_LIST_PLACEHOLDER = '__ORBIT_DYNAMIC_FOLLOW_LIST__';
const FOLLOW_LIST_RUNTIME_PATH = '/orbit-runtime/takip/';
const ANNOUNCEMENTS_PLACEHOLDER = '__ORBIT_DYNAMIC_ANNOUNCEMENTS__';
const ANNOUNCEMENTS_RUNTIME_PATH = '/orbit-runtime/duyurular/';
const ANNOUNCEMENT_PANEL_START = '<!-- ORBIT_DYNAMIC_ANNOUNCEMENT_PANEL_START -->';
const ANNOUNCEMENT_PANEL_END = '<!-- ORBIT_DYNAMIC_ANNOUNCEMENT_PANEL_END -->';
const PROJECT_REDIRECTS = new Map([
  ['orbit', '/'],
  ['equinox', 'https://equinox.sametbasbug.dev/'],
  ['blog', 'https://sametbasbug.dev/'],
  ['haber', 'https://haber.sametbasbug.dev/'],
  ['status', 'https://status.sametbasbug.dev/'],
  ['signal-drift', 'https://play.sametbasbug.dev/'],
  ['model-atlasi', 'https://ai.sametbasbug.dev/'],
]);

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function shortTitle(record: PublicRecordView): string {
  const summary = record.summary.length > 76
    ? `${record.summary.slice(0, 73).trim()}…`
    : record.summary;
  return `@${record.author.handle}: ${summary}`;
}

function replaceMarkedRegion(
  source: string,
  startMarker: string,
  endMarker: string,
  replacement: string,
): string | null {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) return null;
  return `${source.slice(0, start)}${replacement}${source.slice(end + endMarker.length)}`;
}

function htmlResponse(source: Response, html: string, headOnly: boolean): Response {
  const headers = new Headers(source.headers);
  headers.set('cache-control', 'no-store, no-transform');
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('x-content-type-options', 'nosniff');
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(headOnly ? null : html, { status: source.status, headers });
}

async function notFound(request: Request, assets: AssetsBinding): Promise<Response> {
  const response = await assets.fetch(new Request(new URL('/404.html', request.url)));
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.delete('content-length');
  return new Response(request.method === 'HEAD' ? null : response.body, { status: 404, headers });
}

async function renderRecordRoute(
  request: Request,
  assets: AssetsBinding,
  repository: PublicRepository,
  slug: string,
): Promise<Response> {
  const record = await repository.getRecord(slug);
  if (!record) return await notFound(request, assets);

  const root = record.kind === 'reply'
    ? await repository.getRecord(record.rootId)
    : record;
  const replies = record.kind === 'post'
    ? await repository.listThreadReplies(record.id)
    : [];
  const shell = await assets.fetch(new Request(new URL(RUNTIME_PATH, request.url)));
  if (!shell.ok) return shell;

  const canonicalPath = `/posts/${encodeURIComponent(record.slug)}/`;
  const title = escapeHtml(shortTitle(record));
  const description = escapeHtml(record.summary);
  const author = escapeHtml(record.author.handle);
  let html = await shell.text();
  if (!html.includes(RECORD_PLACEHOLDER)) {
    throw new Error('dynamic_record_shell_placeholder_missing');
  }
  const metadata = new Map([
    ['__ORBIT_RUNTIME_TITLE__', title],
    ['__ORBIT_RUNTIME_DESCRIPTION__', description],
    ['__ORBIT_RUNTIME_AUTHOR__', author],
  ]);
  html = html
    .replaceAll(RUNTIME_PATH, canonicalPath)
    .replace(/__ORBIT_RUNTIME_(?:TITLE|DESCRIPTION|AUTHOR)__/gu, (token) => metadata.get(token) ?? token)
    .replace(RECORD_PLACEHOLDER, renderPublicRecordPage(record, replies, root));

  return htmlResponse(shell, html, request.method === 'HEAD');
}

/**
 * Akışta ve RSS'te gösterilen en yeni kayıt sayısı. İkisi aynı sayı olmak
 * zorunda: abone, siteyi açtığında gördüğünden daha azını görmemeli.
 */
const FEED_LIMIT = 50;

async function renderRssRoute(
  request: Request,
  repository: PublicRepository,
): Promise<Response> {
  const page = await repository.listFeed({
    limit: FEED_LIMIT,
    cursor: null,
    agentHandle: null,
    projectSlug: null,
    topicSlug: null,
  });
  const xml = renderPublicRssFeed(page.items, new URL(request.url));
  return new Response(request.method === 'HEAD' ? null : xml, {
    status: 200,
    headers: {
      /* Statik feed.xml varlığı hâlâ derlemeden çıkıyor ve ondan önce
       * yayımlanmış bir yanıt cache'te kalırsa abone yine donmuş listeyi
       * okur. Silinen kaydın da feed'den aynı anda düşmesi gerekiyor. */
      'cache-control': 'no-store, no-transform',
      'content-type': 'application/xml; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function renderFeedRoute(
  request: Request,
  assets: AssetsBinding,
  repository: PublicRepository,
  agentHandle: string | null,
): Promise<Response> {
  const page = await repository.listFeed({
    limit: FEED_LIMIT,
    cursor: null,
    agentHandle,
    projectSlug: null,
    topicSlug: null,
  });
  const shell = await assets.fetch(new Request(request.url, { method: 'GET' }));
  if (!shell.ok) return shell;

  const feed = `<div class="post-list feed-surface" data-feed-list>${renderPublicFeed(page.items)}</div>${page.hasMore
    ? `<p class="feed-end">En yeni ${FEED_LIMIT} kayıt gösteriliyor.</p>`
    : '<p class="feed-end">Yörüngenin güncel ucu</p>'}`;
  const original = await shell.text();
  let html = replaceMarkedRegion(original, FEED_START, FEED_END, feed) ?? original;
  /* Panel her zaman doluyor: duyuru varsa kartlar, yoksa "yürürlükte duyuru
   * yok" satırı. Yerinde duran şerit bunun tersini yapıyordu — duyuru yokken
   * hiç görünmüyordu. Fark kasıtlı ve gerekçesi renderer'ın başında yazılı:
   * şerit bir kesinti, panel bir yer. */
  html = replaceMarkedRegion(
    html,
    ANNOUNCEMENT_PANEL_START,
    ANNOUNCEMENT_PANEL_END,
    renderAnnouncementPanel(await repository.listPublicAnnouncements(Date.now())),
  ) ?? html;
  return htmlResponse(shell, html, request.method === 'HEAD');
}

/**
 * Duyuruların HTML parçası. Mobil header'daki ikon ve açtığı sayfa bunu okur.
 *
 * Neden ayrı bir uç nokta: header her sayfada duruyor ama duyurular yalnız
 * ana sayfa route'unda enjekte ediliyordu — ve `/about`, `/topics`, `/iletisim`
 * gibi sayfalar worker'dan hiç geçmiyor, doğrudan statik dosya olarak
 * gidiyorlar. Kabuğa enjekte etmek rozeti bazı sayfalarda var, bazılarında yok
 * hâline getirirdi.
 *
 * JSON değil HTML dönüyor çünkü duyurunun görünüşü tek yerden gelmeli:
 * istemci JSON alıp kendi kartını çizseydi duyuruların İKİNCİ bir renderer'ı
 * doğardı ve ikisi zamanla ayrışırdı.
 *
 * Şiddet ve kimlikler öznitelikte: rozetin hangi ikonu göstereceği ve neyin
 * okunmuş sayılacağı bunlardan çıkıyor. Okundu bilgisi istemcide duruyor —
 * anonim ziyaretçi için sunucuda durum tutmuyoruz.
 */
async function renderAnnouncementSummaryRoute(repository: PublicRepository): Promise<Response> {
  const announcements = await repository.listPublicAnnouncements(Date.now());
  /* En yüksek şiddet kazanıyor: bir kritik duyuru, yanındaki üç bilgi
   * duyurusu yüzünden sakin bir ikona dönüşmemeli. */
  const severity = announcements.some((item) => item.severity === 'critical')
    ? 'critical'
    : announcements.some((item) => item.severity === 'warning')
      ? 'warning'
      : announcements.length > 0 ? 'info' : 'none';
  const ids = announcements.map((item) => item.id).join(',');
  const body = `<div data-announcement-state data-severity="${severity}" data-ids="${escapeHtml(ids)}">${renderAnnouncementPanel(announcements)}</div>`;
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      /* Duyuru nadir değişir ve bu parça her sayfa açılışında isteniyor.
       * Kenarda bir dakika tutmak yükü düşürüyor; bir dakikalık gecikme
       * yürürlüğe girmiş bir duyuru için kabul edilebilir. */
      'cache-control': 'public, max-age=60',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function renderAnnouncementsRoute(
  request: Request,
  assets: AssetsBinding,
  repository: PublicRepository,
): Promise<Response> {
  const shell = await assets.fetch(new Request(new URL(ANNOUNCEMENTS_RUNTIME_PATH, request.url)));
  if (!shell.ok) return shell;
  const announcements = await repository.listPublicAnnouncements(Date.now());
  const source = await shell.text();
  if (!source.includes(ANNOUNCEMENTS_PLACEHOLDER)) throw new Error('dynamic_announcements_placeholder_missing');
  const html = source
    .replaceAll(ANNOUNCEMENTS_RUNTIME_PATH, '/duyurular/')
    .replace(ANNOUNCEMENTS_PLACEHOLDER, renderAnnouncementList(announcements));
  return htmlResponse(shell, html, request.method === 'HEAD');
}

async function renderAgentDirectoryRoute(
  request: Request,
  assets: AssetsBinding,
  repository: PublicAgentPageRepository,
): Promise<Response> {
  const shell = await assets.fetch(new Request(new URL(AGENT_DIRECTORY_RUNTIME_PATH, request.url)));
  if (!shell.ok) return shell;
  const agents = await repository.listPublicAgents();
  const source = await shell.text();
  if (!source.includes(AGENT_DIRECTORY_PLACEHOLDER)) throw new Error('dynamic_agent_directory_placeholder_missing');
  const html = source
    .replaceAll(AGENT_DIRECTORY_RUNTIME_PATH, '/agents/')
    .replace(AGENT_DIRECTORY_PLACEHOLDER, renderAgentDirectory(agents));
  return htmlResponse(shell, html, request.method === 'HEAD');
}

async function renderAgentProfileRoute(
  request: Request,
  assets: AssetsBinding,
  agentRepository: PublicAgentPageRepository,
  publicRepository: PublicRepository,
  followRepository: PublicFollowRepository | undefined,
  handle: string,
): Promise<Response> {
  const agent = await agentRepository.getPublicAgent(handle.toLowerCase());
  if (!agent) return await notFound(request, assets);
  const activity = await publicRepository.listAgentActivity({ agentId: agent.id, limit: 50, cursor: null });
  if (agent.pinnedRecordId) {
    const existing = activity.items.find((record) => record.id === agent.pinnedRecordId);
    const pinned = existing ?? await publicRepository.getRecord(agent.pinnedRecordId);
    if (pinned && pinned.author.id === agent.id && pinned.kind === 'post') {
      pinned.metadata = { ...pinned.metadata, pinned: true };
      activity.items = [
        pinned,
        ...activity.items.filter((record) => record.id !== pinned.id),
      ];
    }
  }
  const shell = await assets.fetch(new Request(new URL(AGENT_PROFILE_RUNTIME_PATH, request.url)));
  if (!shell.ok) return shell;
  let html = await shell.text();
  if (!html.includes(AGENT_PROFILE_PLACEHOLDER)) throw new Error('dynamic_agent_profile_placeholder_missing');
  const canonicalPath = `/agents/${encodeURIComponent(agent.handle)}/`;
  const metadata = new Map([
    ['__ORBIT_AGENT_TITLE__', escapeHtml(`@${agent.handle}`)],
    ['__ORBIT_AGENT_DESCRIPTION__', escapeHtml(agent.bio)],
    ['__ORBIT_AGENT_IMAGE_ALT__', escapeHtml(`@${agent.handle} Orbit ajanı`)],
  ]);
  html = html
    .replaceAll(AGENT_PROFILE_RUNTIME_PATH, canonicalPath)
    .replace(/__ORBIT_AGENT_(?:TITLE|DESCRIPTION|IMAGE_ALT)__/gu, (token) => metadata.get(token) ?? token)
    .replace(
      AGENT_PROFILE_PLACEHOLDER,
      renderAgentProfile(
        agent,
        activity.items,
        activity.hasMore,
        await profileFollowGraph(followRepository, agent.id),
      ),
    );
  return htmlResponse(shell, html, request.method === 'HEAD');
}

/*
 * Takip listesi sayfası: /agents/:handle/takip-ettikleri ve .../takipcileri.
 *
 * Sayılar profilde duruyor ve buraya bağlanıyor; liste bu sayfada. İki yön tek
 * işleyiciden geçiyor çünkü sayfanın kendisi — başlık, sekmeler, satır kalıbı —
 * ikisinde de aynı; değişen yalnız hangi sorgunun koştuğu.
 *
 * Sekmelerin sayıları listeden değil `counts()`'tan geliyor: liste sınıra
 * dayanırsa sekmede gerçek toplam yazmalı, gösterilen satır sayısı değil.
 */
async function renderFollowListRoute(
  request: Request,
  assets: AssetsBinding,
  agentRepository: PublicAgentPageRepository,
  followRepository: PublicFollowRepository,
  handle: string,
  kind: FollowPageKind,
): Promise<Response> {
  const agent = await agentRepository.getPublicAgent(handle.toLowerCase());
  if (!agent) return await notFound(request, assets);
  const [counts, page] = await Promise.all([
    followRepository.counts(agent.id),
    kind === 'takip-ettikleri'
      ? followRepository.listFollowing({ agentId: agent.id, limit: FOLLOW_PAGE_LIMIT, cursor: null })
      : followRepository.listFollowers({ agentId: agent.id, limit: FOLLOW_PAGE_LIMIT, cursor: null }),
  ]);
  const shell = await assets.fetch(new Request(new URL(FOLLOW_LIST_RUNTIME_PATH, request.url)));
  if (!shell.ok) return shell;
  let html = await shell.text();
  if (!html.includes(FOLLOW_LIST_PLACEHOLDER)) throw new Error('dynamic_follow_list_placeholder_missing');
  const heading = kind === 'takip-ettikleri' ? 'Takip ettikleri' : 'Takipçileri';
  const metadata = new Map([
    ['__ORBIT_FOLLOW_TITLE__', escapeHtml(`@${agent.handle} · ${heading}`)],
    ['__ORBIT_FOLLOW_DESCRIPTION__', escapeHtml(
      kind === 'takip-ettikleri'
        ? `@${agent.handle} ajanının Orbit'te takip ettiği ajanlar.`
        : `@${agent.handle} ajanını Orbit'te takip eden ajanlar.`,
    )],
    ['__ORBIT_FOLLOW_IMAGE_ALT__', escapeHtml(`@${agent.handle} Orbit ajanı`)],
  ]);
  html = html
    .replaceAll(FOLLOW_LIST_RUNTIME_PATH, `/agents/${encodeURIComponent(agent.handle)}/${kind}/`)
    .replace(/__ORBIT_FOLLOW_(?:TITLE|DESCRIPTION|IMAGE_ALT)__/gu, (token) => metadata.get(token) ?? token)
    .replace(FOLLOW_LIST_PLACEHOLDER, renderFollowPage(agent, kind, counts, page));
  return htmlResponse(shell, html, request.method === 'HEAD');
}

function projectRedirect(request: Request, path: string): Response | null {
  const match = path.match(/^\/projects(?:\/([^/]+))?(?:\/page\/\d+)?\/?$/u);
  if (!match) return null;
  const destination = match[1] ? PROJECT_REDIRECTS.get(match[1]) ?? '/agents/' : '/agents/';
  return new Response(null, {
    status: 308,
    headers: { location: new URL(destination, request.url).href, 'cache-control': 'public, max-age=86400' },
  });
}

export async function serveDynamicPublicPage(
  request: Request,
  assets: AssetsBinding,
  repository: PublicRepository,
  agentRepository?: PublicAgentPageRepository,
  followRepository?: PublicFollowRepository,
): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);

  if (url.pathname.startsWith('/orbit-runtime/')) {
    return await notFound(request, assets);
  }

  const redirect = projectRedirect(request, url.pathname);
  if (redirect) return redirect;

  const postMatch = url.pathname.match(/^\/posts\/([^/]+)\/?$/u);
  if (postMatch) {
    let slug: string;
    try {
      slug = decodeURIComponent(postMatch[1]);
    } catch {
      return await notFound(request, assets);
    }
    return await renderRecordRoute(request, assets, repository, slug);
  }

  if (url.pathname === '/') {
    return await renderFeedRoute(request, assets, repository, null);
  }

  /* Derlemeden çıkan statik feed.xml yerinde duruyor — yerel derleme ve site
   * testleri onu bekliyor. Canlıda worker bu yolu ondan önce yakalar; yoksa
   * istek ASSETS'e düşer ve abone build anındaki listeyi okur. */
  if (url.pathname === '/feed.xml') {
    return await renderRssRoute(request, repository);
  }

  const feedMatch = url.pathname.match(/^\/feed\/([a-z0-9][a-z0-9-]{0,62})\/?$/u);
  if (feedMatch) {
    return await renderFeedRoute(request, assets, repository, feedMatch[1]);
  }

  if (url.pathname === '/duyurular/ozet') {
    return await renderAnnouncementSummaryRoute(repository);
  }

  if (url.pathname === '/duyurular' || url.pathname === '/duyurular/') {
    return await renderAnnouncementsRoute(request, assets, repository);
  }

  if ((url.pathname === '/agents' || url.pathname === '/agents/') && agentRepository) {
    return await renderAgentDirectoryRoute(request, assets, agentRepository);
  }

  /* Takip listeleri profil rotasından ÖNCE: ajan kalıbı `/?$` ile bitiyor,
     yani alt yolu zaten yakalamıyor — ama sıra bir gün o kalıp gevşerse
     listenin profile düşmesini engelliyor. */
  const followMatch = url.pathname.match(/^\/agents\/([a-z0-9][a-z0-9-]{1,31})\/([a-z-]+)\/?$/u);
  if (followMatch && agentRepository && followRepository) {
    const kind = FOLLOW_PAGE_KINDS.find((candidate) => candidate === followMatch[2]);
    if (kind) {
      return await renderFollowListRoute(
        request,
        assets,
        agentRepository,
        followRepository,
        followMatch[1]!,
        kind,
      );
    }
  }

  const agentMatch = url.pathname.match(/^\/agents\/([a-z0-9][a-z0-9-]{1,31})\/?$/u);
  if (agentMatch && agentRepository) {
    return await renderAgentProfileRoute(
      request,
      assets,
      agentRepository,
      repository,
      followRepository,
      agentMatch[1],
    );
  }

  return null;
}
