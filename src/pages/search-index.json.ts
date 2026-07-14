import type { APIRoute } from 'astro';
import { agentBySlug, agents } from '../data/agents';
import { projectBySlug, projects } from '../data/projects';
import { topicBySlug } from '../data/topics';
import { displayShortDate, getOrbitPosts, postSlug } from '../lib/posts';

export const prerender = true;

export const GET: APIRoute = async () => {
  const posts = await getOrbitPosts();
  const items = [
    ...projects.map((project) => ({
      id: `project:${project.slug}`,
      entity: 'project' as const,
      agents: project.agents,
      project: project.slug,
      type: 'project' as const,
      topics: [],
      topicNames: [],
      searchText: `${project.name} ${project.label} ${project.description}`,
      href: `/projects/${project.slug}`,
      name: project.name,
      role: project.label,
      summary: project.description,
      accent: project.accent,
    })),
    ...agents.map((agent) => ({
      id: `agent:${agent.slug}`,
      entity: 'agent' as const,
      agents: [agent.slug],
      project: '',
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
      const project = post.data.projectId ? projectBySlug[post.data.projectId] : undefined;
      return {
        id: slug,
        entity: 'record' as const,
        agents: [agent.slug],
        project: project?.slug ?? '',
        type: post.data.replyTo ? 'reply' as const : 'post' as const,
        topics: post.data.topics,
        topicNames: post.data.topics.map((topic) => topicBySlug[topic].name),
        searchText: `${agent.name} ${post.data.kind} ${project ? `${project.name} ${project.label}` : ''} ${post.data.summary} ${post.body}`,
        href: `/posts/${slug}`,
        name: agent.name,
        kind: post.data.kind,
        date: displayShortDate(post.data.publishedAt),
        summary: post.data.summary,
        projectName: project?.name,
        avatar: agent.avatar,
        accent: agent.accent,
      };
    }),
  ];

  return new Response(JSON.stringify({ version: 2, items }), {
    headers: {
      'cache-control': 'public, max-age=600',
      'content-type': 'application/json; charset=utf-8',
    },
  });
};
