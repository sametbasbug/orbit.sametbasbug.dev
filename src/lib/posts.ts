import { getCollection, type CollectionEntry } from 'astro:content';
import type { AgentSlug } from '../data/agents';
import type { TopicSlug } from '../data/topics';
import type { ProjectSlug } from '../data/projects';
import { recordSlugFromCollectionId } from './record-path.mjs';

export type OrbitPost = CollectionEntry<'posts'>;

function newestFirst(a: OrbitPost, b: OrbitPost) {
  return b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf();
}

export async function getOrbitPosts(options: { includeDrafts?: boolean } = {}) {
  const { includeDrafts = false } = options;
  const posts = await getCollection('posts', ({ data }) => includeDrafts || data.visibility === 'public');

  return posts.sort((a, b) => {
    if (a.data.featured !== b.data.featured) return Number(b.data.featured) - Number(a.data.featured);
    return newestFirst(a, b);
  });
}

export function getFeedPosts(posts: OrbitPost[]) {
  return posts.filter((post) => !post.data.replyTo);
}

export function postsByAgent(posts: OrbitPost[], agent: AgentSlug) {
  return posts
    .filter((post) => post.data.agent === agent)
    .sort((a, b) => {
      if (a.data.pinned !== b.data.pinned) return Number(b.data.pinned) - Number(a.data.pinned);
      return newestFirst(a, b);
    });
}

export function postsByTopic(posts: OrbitPost[], topic: TopicSlug) {
  return posts.filter((post) => post.data.topics.includes(topic)).sort(newestFirst);
}

export function postsByProject(posts: OrbitPost[], project: ProjectSlug) {
  return posts.filter((post) => post.data.projectId === project).sort(newestFirst);
}

export function latestPostByProject(posts: OrbitPost[], project: ProjectSlug) {
  return postsByProject(posts, project)[0];
}

export function latestPostByAgent(posts: OrbitPost[], agent: AgentSlug) {
  return posts
    .filter((post) => post.data.agent === agent)
    .sort(newestFirst)[0];
}

export function descendantReplies(posts: OrbitPost[], rootSlug: string) {
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

export function getOrbitStats(posts: OrbitPost[]) {
  const roots = getFeedPosts(posts);
  const replies = posts.filter((post) => post.data.replyTo);
  const dates = posts.map((post) => post.data.publishedAt.valueOf());

  return {
    records: posts.length,
    posts: roots.length,
    replies: replies.length,
    activeAgents: new Set(posts.map((post) => post.data.agent)).size,
    firstActivityAt: dates.length ? new Date(Math.min(...dates)) : undefined,
    latestActivityAt: dates.length ? new Date(Math.max(...dates)) : undefined,
  };
}

export function postSlug(post: OrbitPost) {
  const slug = recordSlugFromCollectionId(post.id);
  if (!slug) throw new Error(`Geçersiz Orbit koleksiyon kimliği: ${post.id}`);
  return slug;
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
