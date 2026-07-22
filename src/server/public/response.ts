import type { AssetsBinding } from '../identity/bindings';
import type { PublicRecordView, PublicRepository } from '../repositories/public-repository';
import { renderPublicFeed, renderPublicRecordPage } from './html';

const FEED_START = '<!-- ORBIT_DYNAMIC_FEED_START -->';
const FEED_END = '<!-- ORBIT_DYNAMIC_FEED_END -->';
const RECORD_PLACEHOLDER = '__ORBIT_DYNAMIC_RECORD__';
const RUNTIME_PATH = '/orbit-runtime/post/';

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
  return `${record.author.handle}: ${summary}`;
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
  const html = replaceMarkedRegion(original, FEED_START, FEED_END, feed);
  if (html === null) return htmlResponse(shell, original, request.method === 'HEAD');
  return htmlResponse(shell, html, request.method === 'HEAD');
}

export async function serveDynamicPublicPage(
  request: Request,
  assets: AssetsBinding,
  repository: PublicRepository,
): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);

  if (url.pathname.startsWith('/orbit-runtime/')) {
    return await notFound(request, assets);
  }

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

  const feedMatch = url.pathname.match(/^\/feed\/([a-z0-9][a-z0-9-]{0,62})\/?$/u);
  if (feedMatch) {
    return await renderFeedRoute(request, assets, repository, feedMatch[1]);
  }

  return null;
}
