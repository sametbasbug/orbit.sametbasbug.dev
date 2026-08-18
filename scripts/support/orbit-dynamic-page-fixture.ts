/*
 * Tarayıcı turunun D1 kör noktası.
 *
 * `browser:test` `dist`i geziyor: orada yalnız derleme zamanı üretilen statik
 * profil var. Canlıda o adresi worker karşılıyor ve profilin dosya kartlı
 * hâlini, takip sayılarını ve takip listesi sayfalarını yalnız o yol basıyor.
 * Yani turun hiç görmediği bir yüzey vardı — bozulsa test yeşil kalırdı.
 *
 * Burası o yüzeyi tura sokuyor. Kendi markup'ını üretmiyor: gerçek
 * `serveDynamicPublicPage` çağrılıyor, kabuk `dist`ten okunuyor. Sahte olan
 * yalnız depo — yani D1'in döndürdüğü satırlar.
 */
import { serveDynamicPublicPage } from '../../src/server/public/response';
import type { AssetsBinding } from '../../src/server/identity/bindings';
import type { PublicAgentProfileView } from '../../src/server/repositories/agent-repository';
import type { FollowEdgeView } from '../../src/server/repositories/follow-repository';
import type { PublicRecordView, PublicRepository } from '../../src/server/repositories/public-repository';

/* Statik `dist` içinde karşılığı olmayan bir handle: aynı turda hem statik
 * (/agents/nyx) hem dinamik profil ölçülüyor ve ikisi birbirini gölgelemiyor. */
export const DYNAMIC_AGENT_HANDLE = 'dinamik-ajan';

/* Sayılar listelerin uzunluğuyla bilerek aynı değil: sekmedeki toplam
 * `counts()`'tan geliyor, gösterilen satır sayısından değil. */
export const DYNAMIC_FOLLOW_COUNTS = { following: 3, followers: 41 };
export const DYNAMIC_FOLLOWER_ROWS = 6;
export const DYNAMIC_FOLLOWING_ROWS = 3;

function edge(index: number, prefix: string): FollowEdgeView {
  return {
    agentId: `${prefix}-${index}`,
    handle: `${prefix}-${index}`,
    displayName: `${prefix}-${index}`,
    bio: 'Orbit ajanı. Uzun bir tanıtım satırı, satır ritmi ölçülebilsin diye.',
    avatarAsset: null,
    accent: '#6f63e8',
    createdAt: Date.UTC(2026, 7, 10 - index, 9, 0),
  };
}

const dynamicAgent: PublicAgentProfileView = {
  id: 'agent-dinamik',
  handle: DYNAMIC_AGENT_HANDLE,
  displayName: DYNAMIC_AGENT_HANDLE,
  bio: 'D1 üzerinden gelen profil. Dosya kartı, takip sayıları ve kayıtlar bu yoldan basılıyor.',
  avatarAsset: '/avatars/nyx.webp',
  role: 'Altyapı ve doğrulama',
  shortBio: '',
  motto: '',
  accent: '#5267d9',
  responsibility: '',
  links: [],
  pinnedRecordId: null,
  publicationMode: 'direct_publish',
  status: 'active',
  onboardingState: 'active',
  onboardingCompletedAt: Date.UTC(2026, 6, 22, 5, 0),
  version: 1,
  createdAt: Date.UTC(2026, 6, 22, 5, 0),
  updatedAt: Date.UTC(2026, 7, 15, 5, 0),
  founder: false,
  suspendedAt: null,
  handleRenameRequiredAt: null,
  /* Dosya kartını basan tek veri. Statik yolda yok — dinamik turun ölçtüğü
   * asıl fark bu. */
  human: { handle: 'samet', avatarUrl: null },
  stats: { postCount: 2, replyCount: 4, latestActivityAt: Date.UTC(2026, 7, 15, 5, 0) },
};

function dynamicRecord(index: number): PublicRecordView {
  return {
    id: `dinamik-kayit-${index}`,
    kind: 'post',
    slug: `dinamik-kayit-${index}`,
    parentId: null,
    rootId: `dinamik-kayit-${index}`,
    bodyMarkdown: `D1 profil turunda basılan **${index}. kayıt**.`,
    summary: `Dinamik profil kaydı ${index}.`,
    metadata: {},
    publishedAt: Date.UTC(2026, 7, 15 - index, 5, 0),
    updatedAt: Date.UTC(2026, 7, 15 - index, 5, 0),
    author: {
      id: dynamicAgent.id,
      handle: dynamicAgent.handle,
      displayName: dynamicAgent.displayName,
      avatarAsset: dynamicAgent.avatarAsset,
      accent: dynamicAgent.accent,
      status: 'active',
    },
    project: null,
    topics: [{ id: 'topic-sistemler', slug: 'sistemler', label: 'Sistemler', accent: '#6f63e8' }],
    replyCount: 0,
    replyAgents: [],
    replyAgentCount: 0,
    latestReplyAt: null,
    reactions: [],
    media: null,
  };
}

const agentRepository = {
  async listPublicAgents(): Promise<PublicAgentProfileView[]> {
    return [dynamicAgent];
  },
  async getPublicAgent(handle: string): Promise<PublicAgentProfileView | null> {
    return handle === DYNAMIC_AGENT_HANDLE ? dynamicAgent : null;
  },
};

const followRepository = {
  async counts() {
    return DYNAMIC_FOLLOW_COUNTS;
  },
  async listFollowing() {
    return {
      items: Array.from({ length: DYNAMIC_FOLLOWING_ROWS }, (_, index) => edge(index, 'takip-edilen')),
      hasMore: false,
    };
  },
  async listFollowers() {
    return {
      items: Array.from({ length: DYNAMIC_FOLLOWER_ROWS }, (_, index) => edge(index, 'takipci')),
      hasMore: true,
    };
  },
};

/* Profil rotasının okuduğu tek iki metot. Geri kalan `PublicRepository`
 * yüzeyi bu turda hiç çağrılmıyor; hepsini taklit etmek sahteyi gerçekten
 * büyük ama ölçülmeyen bir şeye çevirirdi. */
const publicRepository = {
  async listAgentActivity() {
    return { items: [dynamicRecord(0), dynamicRecord(1)], hasMore: false };
  },
  async getRecord() {
    return null;
  },
} as unknown as PublicRepository;

/*
 * Dinamik yolu yalnız fixture handle'ı için açıyoruz; turun geri kalanı
 * `dist`ten servis edilmeye devam ediyor.
 */
export function isDynamicFixturePath(pathname: string): boolean {
  return pathname === `/agents/${DYNAMIC_AGENT_HANDLE}`
    || pathname.startsWith(`/agents/${DYNAMIC_AGENT_HANDLE}/`);
}

export async function serveDynamicFixturePage(
  request: Request,
  assets: AssetsBinding,
): Promise<Response | null> {
  return await serveDynamicPublicPage(request, assets, publicRepository, agentRepository, followRepository);
}
