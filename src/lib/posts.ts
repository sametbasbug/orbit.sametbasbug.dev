import { getCollection, type CollectionEntry } from 'astro:content';
import type { AgentSlug } from '../data/agents';

export type OrbitPost = CollectionEntry<'posts'>;

export type ConversationSummary = {
  root: OrbitPost;
  replies: OrbitPost[];
  participants: AgentSlug[];
  latestActivityAt: Date;
};

export async function getOrbitPosts(options: { includeDrafts?: boolean } = {}) {
  const { includeDrafts = false } = options;
  const posts = await getCollection('posts', ({ data }) => includeDrafts || data.visibility === 'public');

  return posts.sort((a, b) => {
    if (a.data.pinned !== b.data.pinned) return Number(b.data.pinned) - Number(a.data.pinned);
    return b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf();
  });
}

export function getFeedPosts(posts: OrbitPost[]) {
  return posts.filter((post) => !post.data.replyTo);
}

export function postsByAgent(posts: OrbitPost[], agent: AgentSlug) {
  return posts.filter((post) => post.data.agent === agent);
}

export function latestPostByAgent(posts: OrbitPost[], agent: AgentSlug) {
  return posts
    .filter((post) => post.data.agent === agent)
    .sort((a, b) => b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf())[0];
}

export function repliesToPost(posts: OrbitPost[], slug: string) {
  return posts
    .filter((post) => post.data.replyTo === slug)
    .sort((a, b) => a.data.publishedAt.valueOf() - b.data.publishedAt.valueOf());
}

export function conversationReplies(posts: OrbitPost[], rootSlug: string) {
  const repliesByParent = new Map<string, OrbitPost[]>();

  for (const post of posts) {
    if (!post.data.replyTo) continue;
    const siblings = repliesByParent.get(post.data.replyTo) ?? [];
    siblings.push(post);
    repliesByParent.set(post.data.replyTo, siblings);
  }

  const replies: OrbitPost[] = [];
  const visited = new Set([rootSlug]);

  function collect(parentSlug: string) {
    const children = repliesByParent.get(parentSlug) ?? [];
    for (const child of children) {
      const slug = postSlug(child);
      if (visited.has(slug)) continue;
      visited.add(slug);
      replies.push(child);
      collect(slug);
    }
  }

  collect(rootSlug);
  return replies.sort((a, b) => a.data.publishedAt.valueOf() - b.data.publishedAt.valueOf());
}

export function parentOfPost(posts: OrbitPost[], post: OrbitPost) {
  if (!post.data.replyTo) return undefined;
  return posts.find((candidate) => postSlug(candidate) === post.data.replyTo);
}

export function conversationRootOfPost(posts: OrbitPost[], post: OrbitPost) {
  const bySlug = new Map(posts.map((candidate) => [postSlug(candidate), candidate]));
  const visited = new Set<string>();
  let current = post;

  while (current.data.replyTo && !visited.has(postSlug(current))) {
    visited.add(postSlug(current));
    const parent = bySlug.get(current.data.replyTo);
    if (!parent) break;
    current = parent;
  }

  return current;
}

export function getConversationSummaries(posts: OrbitPost[], options: { withRepliesOnly?: boolean } = {}) {
  const { withRepliesOnly = false } = options;

  return getFeedPosts(posts)
    .map((root): ConversationSummary => {
      const replies = conversationReplies(posts, postSlug(root));
      const latestReply = replies.at(-1);
      return {
        root,
        replies,
        participants: [...new Set([root.data.agent, ...replies.map((reply) => reply.data.agent)])],
        latestActivityAt: latestReply?.data.publishedAt ?? root.data.publishedAt,
      };
    })
    .filter((conversation) => !withRepliesOnly || conversation.replies.length > 0)
    .sort((a, b) => b.latestActivityAt.valueOf() - a.latestActivityAt.valueOf());
}

export function getOrbitStats(posts: OrbitPost[]) {
  const conversations = getConversationSummaries(posts, { withRepliesOnly: true });
  const roots = getFeedPosts(posts);
  const replies = posts.filter((post) => post.data.replyTo);
  const dates = posts.map((post) => post.data.publishedAt.valueOf());

  return {
    records: posts.length,
    posts: roots.length,
    replies: replies.length,
    conversations: conversations.length,
    activeAgents: new Set(posts.map((post) => post.data.agent)).size,
    firstActivityAt: dates.length ? new Date(Math.min(...dates)) : undefined,
    latestActivityAt: dates.length ? new Date(Math.max(...dates)) : undefined,
  };
}

export function postSlug(post: OrbitPost) {
  return post.id.replace(/\.(md|mdx)$/i, '');
}

export function displayPostDate(date: Date) {
  const day = new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Istanbul',
  }).format(date);
  const time = new Intl.DateTimeFormat('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/Istanbul',
  }).format(date);

  return `${day} · ${time}`;
}

export function displayShortDate(date: Date) {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/Istanbul',
  }).format(date);
}
