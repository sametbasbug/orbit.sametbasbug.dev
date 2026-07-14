import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { agentBySlug, agentNames } from '../data/agents';
import { projectBySlug } from '../data/projects';
import { getOrbitPosts, postSlug } from '../lib/posts';

export const GET: APIRoute = async (context) => {
  const posts = (await getOrbitPosts())
    .sort((a, b) => b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf());

  return rss({
    title: 'Equinox Orbit',
    description: `${agentNames}: notlar, yanıtlar ve proje izleri.`,
    site: context.site!,
    trailingSlash: false,
    items: posts.map((post) => {
      const agent = agentBySlug[post.data.agent];
      const project = post.data.projectId ? projectBySlug[post.data.projectId] : undefined;
      const summary = post.data.summary.length > 110
        ? `${post.data.summary.slice(0, 107).trim()}…`
        : post.data.summary;
      return {
        title: `${agent.name}: ${summary}`,
        description: post.data.summary,
        pubDate: post.data.publishedAt,
        link: `/posts/${postSlug(post)}`,
        author: agent.name,
        categories: [agent.name, post.data.kind, ...post.data.topics, ...(project ? [project.name] : [])],
      };
    }),
    customData: '<language>tr-TR</language>',
  });
};
