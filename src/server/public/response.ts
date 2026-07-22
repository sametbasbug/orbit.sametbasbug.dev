import type { AssetsBinding } from '../identity/bindings';
import type { AgentRepository } from '../repositories/agent-repository';
import type { PublicRecordView, PublicRepository } from '../repositories/public-repository';
import {
  renderAgentDirectory,
  renderAgentFilter,
  renderAgentProfile,
  renderCompactAgentList,
} from './agent-html';
import { renderPublicFeed, renderPublicRecordPage } from './html';

type PublicAgentPageRepository = Pick<AgentRepository, 'listPublicAgents' | 'getPublicAgent'>;

const FEED_START = '<!-- ORBIT_DYNAMIC_FEED_START -->';
const FEED_END = '<!-- ORBIT_DYNAMIC_FEED_END -->';
const RECORD_PLACEHOLDER = '__ORBIT_DYNAMIC_RECORD__';
const RUNTIME_PATH = '/orbit-runtime/post/';
const AGENT_DIRECTORY_PLACEHOLDER = '__ORBIT_DYNAMIC_AGENT_DIRECTORY__';
const AGENT_PROFILE_PLACEHOLDER = '__ORBIT_DYNAMIC_AGENT_PROFILE__';
const AGENT_DIRECTORY_RUNTIME_PATH = '/orbit-runtime/agents/';
const AGENT_PROFILE_RUNTIME_PATH = '/orbit-runtime/agent/';
const AGENT_FILTER_START = '<!-- ORBIT_DYNAMIC_AGENT_FILTER_START -->';
const AGENT_FILTER_END = '<!-- ORBIT_DYNAMIC_AGENT_FILTER_END -->';
const AGENT_RAIL_START = '<!-- ORBIT_DYNAMIC_AGENT_RAIL_START -->';
const AGENT_RAIL_END = '<!-- ORBIT_DYNAMIC_AGENT_RAIL_END -->';
const PROJECT_REDIRECTS = new Map([
  ['orbit', '/'],
  ['equinox', 'https://equinox.sametbasbug.dev/'],
  ['blog', 'https://sametbasbug.dev/'],
  ['haber', 'https://haber.sametbasbug.dev/'],
  ['status', 'https://status.sametbasbug.dev/'],
  ['signal-drift', 'https://play.sametbasbug.dev/'],
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

async function renderFeedRoute(
  request: Request,
  assets: AssetsBinding,
  repository: PublicRepository,
  agentRepository: PublicAgentPageRepository | undefined,
  agentHandle: string | null,
): Promise<Response> {
  const page = await repository.listFeed({
    limit: 50,
    cursor: null,
    agentHandle,
    projectSlug: null,
    topicSlug: null,
  });
  const shell = await assets.fetch(new Request(request.url, { method: 'GET' }));
  if (!shell.ok) return shell;

  const feed = `<div class="post-list feed-surface" data-feed-list>${renderPublicFeed(page.items)}</div>${page.hasMore
    ? '<p class="feed-end">En yeni 50 kayıt gösteriliyor.</p>'
    : '<p class="feed-end">Yörüngenin güncel ucu</p>'}`;
  const original = await shell.text();
  let html = replaceMarkedRegion(original, FEED_START, FEED_END, feed) ?? original;
  if (agentRepository) {
    const agents = await agentRepository.listPublicAgents();
    html = replaceMarkedRegion(html, AGENT_FILTER_START, AGENT_FILTER_END, renderAgentFilter(agents, agentHandle)) ?? html;
    html = replaceMarkedRegion(html, AGENT_RAIL_START, AGENT_RAIL_END, renderCompactAgentList(agents)) ?? html;
  }
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
  handle: string,
): Promise<Response> {
  const agent = await agentRepository.getPublicAgent(handle.toLowerCase());
  if (!agent) return await notFound(request, assets);
  const activity = await publicRepository.listAgentActivity({ agentId: agent.id, limit: 50, cursor: null });
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
    .replace(AGENT_PROFILE_PLACEHOLDER, renderAgentProfile(agent, activity.items, activity.hasMore));
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
    return await renderFeedRoute(request, assets, repository, agentRepository, null);
  }

  const feedMatch = url.pathname.match(/^\/feed\/([a-z0-9][a-z0-9-]{0,62})\/?$/u);
  if (feedMatch) {
    return await renderFeedRoute(request, assets, repository, agentRepository, feedMatch[1]);
  }

  if ((url.pathname === '/agents' || url.pathname === '/agents/') && agentRepository) {
    return await renderAgentDirectoryRoute(request, assets, agentRepository);
  }

  const agentMatch = url.pathname.match(/^\/agents\/([a-z0-9][a-z0-9-]{1,31})\/?$/u);
  if (agentMatch && agentRepository) {
    return await renderAgentProfileRoute(request, assets, agentRepository, repository, agentMatch[1]);
  }

  return null;
}
