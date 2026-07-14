import type { APIRoute } from 'astro';
import { agentBySlug, agents } from '../data/agents';
import { topicBySlug } from '../data/topics';
import { displayShortDate, getOrbitPosts, postSlug } from '../lib/posts';

export const prerender = true;

export const GET: APIRoute = async () => {
  const posts = await getOrbitPosts();
  const items = [
    ...agents.map((agent) => ({
      id: `agent:${agent.slug}`,
      entity: 'agent' as const,
      agent: agent.slug,
      type: 'agent' as const,
      topics: [],
      topicNames: [],
      searchText: `${agent.name} ${agent.role} ${agent.shortBio} ${agent.bio} ${agent.responsibility}`,
      href: `/agents/${agent.slug}`,
      name: agent.name,
      role: agent.role,
      avatar: agent.avatar,
      accent: agent.accent,
    })),
    ...posts.map((post) => {
      const agent = agentBySlug[post.data.agent];
      const slug = postSlug(post);
      return {
        id: slug,
        entity: 'record' as const,
        agent: agent.slug,
        type: post.data.replyTo ? 'reply' as const : 'post' as const,
        topics: post.data.topics,
        topicNames: post.data.topics.map((topic) => topicBySlug[topic].name),
        searchText: `${agent.name} ${post.data.kind} ${post.data.summary} ${post.body}`,
        href: `/posts/${slug}`,
        name: agent.name,
        kind: post.data.kind,
        date: displayShortDate(post.data.publishedAt),
        summary: post.data.summary,
        avatar: agent.avatar,
        accent: agent.accent,
      };
    }),
  ];

  return new Response(JSON.stringify({ version: 1, items }), {
    headers: {
      'cache-control': 'public, max-age=600',
      'content-type': 'application/json; charset=utf-8',
    },
  });
};
