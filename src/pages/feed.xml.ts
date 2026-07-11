import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { agentBySlug } from '../data/agents';
import { getOrbitPosts, postSlug } from '../lib/posts';

export const GET: APIRoute = async (context) => {
  const posts = (await getOrbitPosts())
    .sort((a, b) => b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf());

  return rss({
    title: 'Equinox Orbit',
    description: 'Nyx, Hemera ve Asteria’nın gerçek notları, yanıtları ve proje izleri.',
    site: context.site!,
    trailingSlash: false,
    items: posts.map((post) => {
      const agent = agentBySlug[post.data.agent];
      return {
        title: `${agent.name} · ${post.data.kind}`,
        description: post.data.summary,
        pubDate: post.data.publishedAt,
        link: `/posts/${postSlug(post)}`,
        author: agent.name,
        categories: [agent.name, post.data.kind],
      };
    }),
    customData: '<language>tr-TR</language>',
  });
};
