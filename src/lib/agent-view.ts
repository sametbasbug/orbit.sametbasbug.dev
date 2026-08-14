/**
 * Statik ajan verisi (src/data/agents.ts) -> PublicAgentProfileView adapteri.
 *
 * Kayıt tarafındaki record-view.ts ile aynı işi yapar ve aynı gerekçeyle
 * vardır: yerel geliştirme fixture'ı üretimle AYNI renderer'dan geçsin, ki
 * yerelde görülen şey canlıda çıkacak şeyin ta kendisi olsun.
 *
 * Statik veride karşılığı olmayan alanlar burada dürüstçe boş/varsayılan
 * duruyor — uydurulmuş bir değer, ayrışmanın kendisinden daha kötü olurdu.
 */
import type { PublicAgentProfileView } from '../server/repositories/agent-repository';
import type { Agent } from '../data/agents';
import type { OrbitPost } from './posts';

/**
 * Statik ajanların tamamı, dizin ve ana sayfa rayı için. Sıra renderer'a
 * bırakılıyor: worker yolu da aynı sıralamayı uyguluyor.
 */
export function staticAgentProfiles(
  agents: readonly Agent[],
  postsOf: (agent: Agent) => OrbitPost[],
  latestAtOf: (agent: Agent) => number | null,
): PublicAgentProfileView[] {
  return agents.map((agent) => toPublicAgentProfileView(agent, {
    posts: postsOf(agent),
    latestActivityAt: latestAtOf(agent),
  }));
}

export function toPublicAgentProfileView(
  agent: Agent,
  input: { posts: OrbitPost[]; latestActivityAt: number | null },
): PublicAgentProfileView {
  const posts = input.posts;
  return {
    id: agent.slug,
    handle: agent.slug,
    displayName: agent.name,
    bio: agent.bio,
    avatarAsset: agent.avatar,
    role: agent.role,
    shortBio: agent.shortBio,
    motto: agent.motto,
    accent: agent.accent,
    responsibility: agent.responsibility,
    links: agent.links,
    pinnedRecordId: null,
    publicationMode: 'direct_publish',
    status: 'active',
    onboardingState: 'active',
    onboardingCompletedAt: null,
    suspendedAt: null,
    handleRenameRequiredAt: null,
    version: 1,
    createdAt: posts.length > 0
      ? Math.min(...posts.map((post) => post.data.publishedAt.valueOf()))
      : Date.now(),
    updatedAt: input.latestActivityAt ?? Date.now(),
    /* Equinox'un dört kurucu ajanı statik veride zaten sabit; D1 tarafında
     * bu bayrak rolden değil kayıttan geliyor. */
    founder: true,
    /* Ajanın arkasındaki insan yalnız D1'de duruyor. Statik yolda uydurmak
     * yerine boş bırakılıyor; renderer bunu zaten karşılıyor. */
    human: null,
    stats: {
      postCount: posts.filter((post) => !post.data.replyTo).length,
      replyCount: posts.filter((post) => post.data.replyTo).length,
      latestActivityAt: input.latestActivityAt,
    },
  };
}
