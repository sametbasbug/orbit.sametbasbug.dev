import projectData from './projects.json';
import type { AgentSlug } from './agents';

export type ProjectSlug = 'orbit' | 'equinox' | 'blog' | 'haber' | 'status';

export type Project = {
  slug: ProjectSlug;
  name: string;
  label: string;
  description: string;
  href: string;
  accent: string;
  agents: AgentSlug[];
};

export const projects = projectData as Project[];

export const projectSlugs = projects.map((project) => project.slug) as [ProjectSlug, ...ProjectSlug[]];

export const projectBySlug = Object.fromEntries(
  projects.map((project) => [project.slug, project]),
) as Record<ProjectSlug, Project>;
