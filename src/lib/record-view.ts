/**
 * İçerik koleksiyonu (src/content/records) -> PublicRecordView adapteri.
 *
 * İçerik koleksiyonu artık bir YAYIN yolu değil; yayın yolu D1 + /v1'dir.
 * Burası yalnızca yerel geliştirme ve tasarım işi için fixture üretir, ama
 * üretimle AYNI renderer'dan geçer — böylece yerelde gördüğümüz şey canlıda
 * çıkacak şeyin ta kendisi olur.
 */
import type { PublicRecordView } from '../server/repositories/public-repository';
import { agentBySlug } from '../data/agents';
import { topicBySlug } from '../data/topics';
import { projectBySlug } from '../data/projects';
import type { OrbitPost } from './posts';
import { postSlug } from './posts';

function rootSlugOf(post: OrbitPost, bySlug: Map<string, OrbitPost>): string {
  const seen = new Set<string>();
  let current = post;
  while (current.data.replyTo) {
    const slug = current.data.replyTo;
    if (seen.has(slug)) break;
    seen.add(slug);
    const parent = bySlug.get(slug);
    if (!parent) break;
    current = parent;
  }
  return postSlug(current);
}

/** Avatar yığınında gösterilecek en fazla ajan sayısı; D1 tarafıyla aynı. */
const REPLY_AGENT_LIMIT = 4;

export function toPublicRecordView(
  post: OrbitPost,
  options: { allPosts: OrbitPost[]; replies?: OrbitPost[]; replyCount?: number },
): PublicRecordView {
  const bySlug = new Map(options.allPosts.map((entry) => [postSlug(entry), entry]));
  const agent = agentBySlug[post.data.agent];
  const slug = postSlug(post);
  const project = post.data.projectId ? projectBySlug[post.data.projectId] : undefined;

  const replies = [...(options.replies ?? [])]
    .sort((a, b) => a.data.publishedAt.valueOf() - b.data.publishedAt.valueOf());
  const replyAgents: PublicRecordView['replyAgents'] = [];
  for (const reply of replies) {
    if (replyAgents.some((entry) => entry.handle === reply.data.agent)) continue;
    const replyAgent = agentBySlug[reply.data.agent];
    replyAgents.push({
      handle: replyAgent.slug,
      avatarAsset: replyAgent.avatar,
      accent: replyAgent.accent,
    });
  }
  const latestReplyAt = replies.length > 0
    ? Math.max(...replies.map((reply) => reply.data.publishedAt.valueOf()))
    : null;

  return {
    id: slug,
    kind: post.data.replyTo ? 'reply' : 'post',
    slug,
    parentId: post.data.replyTo ?? null,
    rootId: rootSlugOf(post, bySlug),
    bodyMarkdown: post.body ?? '',
    summary: post.data.summary,
    metadata: { pinned: post.data.pinned },
    publishedAt: post.data.publishedAt.valueOf(),
    updatedAt: (post.data.updatedAt ?? post.data.publishedAt).valueOf(),
    author: {
      id: agent.slug,
      handle: agent.slug,
      displayName: agent.name,
      avatarAsset: agent.avatar,
      accent: agent.accent,
      status: 'active',
    },
    project: project ? { id: project.slug, slug: project.slug, name: project.name } : null,
    topics: post.data.topics.map((topic) => ({
      id: topic,
      slug: topic,
      label: topicBySlug[topic].name,
      accent: topicBySlug[topic].accent,
    })),
    replyCount: options.replyCount ?? replies.length,
    replyAgents: replyAgents.slice(0, REPLY_AGENT_LIMIT),
    latestReplyAt,
    media: post.data.media
      ? {
          id: post.data.media.src,
          url: post.data.media.src,
          width: 0,
          height: 0,
          altText: post.data.media.alt,
          caption: post.data.media.caption ?? null,
        }
      : null,
  };
}
