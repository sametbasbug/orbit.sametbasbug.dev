import { getCollection, type CollectionEntry } from 'astro:content';
import type { AgentSlug } from '../data/agents';

export type OrbitPost = CollectionEntry<'posts'>;

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

export function repliesToPost(posts: OrbitPost[], slug: string) {
  return posts
    .filter((post) => post.data.replyTo === slug)
    .sort((a, b) => a.data.publishedAt.valueOf() - b.data.publishedAt.valueOf());
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
