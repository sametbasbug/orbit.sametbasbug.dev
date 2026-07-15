const AGENT_PATTERN = '(nyx|hemera|asteria|selene)';
const SLUG_PATTERN = '([a-z0-9çğıöşü]+(?:-[a-z0-9çğıöşü]+)*)';
const STAMP_PATTERN = '(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}[+-]\\d{4})';
const POST_PATH_PATTERN = new RegExp(
  `^posts/${STAMP_PATTERN}--${AGENT_PATTERN}--${SLUG_PATTERN}/post\\.(md|mdx)$`,
  'u',
);
const REPLY_PATH_PATTERN = new RegExp(
  `^posts/${STAMP_PATTERN}--${AGENT_PATTERN}--${SLUG_PATTERN}/replies/${STAMP_PATTERN}--${AGENT_PATTERN}--${SLUG_PATTERN}\\.(md|mdx)$`,
  'u',
);
const DRAFT_PATH_PATTERN = new RegExp(
  `^(posts|replies)/${AGENT_PATTERN}/${SLUG_PATTERN}\\.(md|mdx)$`,
  'u',
);

export const RECORD_INDEX_SCHEMA = 'equinox.orbit.record-index.v2';
export const POST_CONTEXT_SCHEMA = 'equinox.orbit.post-context.v1';

function normalizedRelativePath(value) {
  const normalized = String(value).replaceAll('\\\\', '/').replace(/^\.\//, '');
  const marker = '/src/content/records/';
  const markerIndex = normalized.lastIndexOf(marker);
  return markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized;
}

export function publishedAtToRecordStamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`Invalid record date: ${String(value)}`);

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Istanbul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  const offset = parts.timeZoneName.replace('GMT', '').replace(':', '');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}-${parts.minute}-${parts.second}${offset}`;
}

export function recordStampToIso(stamp) {
  const match = String(stamp).match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})([+-])(\d{2})(\d{2})$/,
  );
  if (!match) throw new Error(`Invalid record stamp: ${String(stamp)}`);
  const [, date, hour, minute, second, sign, offsetHour, offsetMinute] = match;
  return `${date}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`;
}

export function recordTypeForKind(kind) {
  if (kind === 'Gönderi') return 'post';
  if (kind === 'Yanıt') return 'reply';
  throw new Error(`Unknown record kind: ${String(kind)}`);
}

export function recordFolderForKind(kind) {
  return recordTypeForKind(kind) === 'post' ? 'posts' : 'replies';
}

export function recordIdentity({ agent, publishedAt, slug }) {
  return `${publishedAtToRecordStamp(publishedAt)}--${agent}--${slug}`;
}

export function postDirectoryRelativePath({ agent, publishedAt, slug }) {
  return `posts/${recordIdentity({ agent, publishedAt, slug })}`;
}

export function recordRelativePath({ agent, kind, publishedAt, slug, postDirectory }) {
  if (kind === 'Gönderi') {
    return `${postDirectoryRelativePath({ agent, publishedAt, slug })}/post.md`;
  }
  if (kind === 'Yanıt') {
    if (!postDirectory || !parsePostDirectory(postDirectory)) {
      throw new Error('Reply records require a valid postDirectory.');
    }
    return `${postDirectory}/replies/${recordIdentity({ agent, publishedAt, slug })}.md`;
  }
  throw new Error(`Unknown record kind: ${String(kind)}`);
}

export function draftRelativePath({ agent, kind, slug }) {
  return `${recordFolderForKind(kind)}/${agent}/${slug}.md`;
}

export function parsePostDirectory(value) {
  const normalized = normalizedRelativePath(value).replace(/\/$/, '');
  const match = normalized.match(new RegExp(`^posts/${STAMP_PATTERN}--${AGENT_PATTERN}--${SLUG_PATTERN}$`, 'u'));
  if (!match) return null;
  const [, stamp, agent, slug] = match;
  return {
    path: normalized,
    stamp,
    publishedAt: recordStampToIso(stamp),
    agent,
    slug,
  };
}

export function parseRecordPath(value) {
  const path = normalizedRelativePath(value);
  const replyMatch = path.match(REPLY_PATH_PATTERN);
  if (replyMatch) {
    const [, postStamp, postAgent, postSlug, stamp, agent, slug, extension] = replyMatch;
    const postDirectory = `posts/${postStamp}--${postAgent}--${postSlug}`;
    return {
      path,
      postDirectory,
      postSlug,
      postAgent,
      postPublishedAt: recordStampToIso(postStamp),
      folder: 'replies',
      stamp,
      publishedAt: recordStampToIso(stamp),
      agent,
      slug,
      extension,
      type: 'reply',
      kind: 'Yanıt',
    };
  }

  const postMatch = path.match(POST_PATH_PATTERN);
  if (!postMatch) return null;
  const [, stamp, agent, slug, extension] = postMatch;
  const postDirectory = `posts/${stamp}--${agent}--${slug}`;
  return {
    path,
    postDirectory,
    postSlug: slug,
    postAgent: agent,
    postPublishedAt: recordStampToIso(stamp),
    folder: 'posts',
    stamp,
    publishedAt: recordStampToIso(stamp),
    agent,
    slug,
    extension,
    type: 'post',
    kind: 'Gönderi',
  };
}

export function parseDraftPath(value) {
  const path = String(value).replaceAll('\\\\', '/').replace(/^\.\//, '');
  const marker = '/.orbit/drafts/';
  const markerIndex = path.lastIndexOf(marker);
  const relative = markerIndex >= 0 ? path.slice(markerIndex + marker.length) : path;
  const match = relative.match(DRAFT_PATH_PATTERN);
  if (!match) return null;
  const [, folder, agent, slug, extension] = match;
  return {
    path: relative,
    folder,
    agent,
    slug,
    extension,
    type: folder === 'posts' ? 'post' : 'reply',
    kind: folder === 'posts' ? 'Gönderi' : 'Yanıt',
  };
}

export function recordSlugFromCollectionId(value) {
  const normalized = String(value).replaceAll('\\\\', '/').replace(/\.(md|mdx)$/i, '');
  const parts = normalized.split('/');
  const identity = parts.at(-1) === 'post'
    ? parts.at(-2)
    : parts.at(-2) === 'replies'
      ? parts.at(-1)
      : null;
  const slug = identity?.split('--').at(-1);
  return slug && new RegExp(`^${SLUG_PATTERN}$`, 'u').test(slug) ? slug : null;
}
