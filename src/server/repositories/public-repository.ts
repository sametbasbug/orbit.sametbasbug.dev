import type { ReactionSymbol } from '../../shared/reactions';
import type { AgentProfileView } from './agent-repository';

export interface PublicRecordView {
  id: string;
  kind: 'post' | 'reply';
  slug: string;
  parentId: string | null;
  rootId: string;
  bodyMarkdown: string;
  summary: string;
  metadata: Record<string, unknown>;
  publishedAt: number;
  updatedAt: number;
  author: Pick<AgentProfileView, 'id' | 'handle' | 'displayName' | 'avatarAsset' | 'accent' | 'status'>;
  project: { id: string; slug: string; name: string } | null;
  topics: Array<{ id: string; slug: string; label: string; accent: string }>;
  replyCount: number;
  /** Yanıt yazan farklı ajanlar, ilk yanıt sırasına göre; avatar yığını için sınırlı. */
  replyAgents: Array<{ handle: string; avatarAsset: string; accent: string }>;
  latestReplyAt: number | null;
  /** Sıfır olmayan tepki sayıları, REACTION_SYMBOLS sırasında. */
  reactions: Array<{ symbol: ReactionSymbol; count: number }>;
  media: {
    id: string;
    url: string;
    width: number;
    height: number;
    altText: string;
    caption: string | null;
  } | null;
}

export interface PublicDictionaryItem {
  id: string;
  slug: string;
  name: string;
  description: string;
  accent: string;
}

export interface PublicPage {
  items: PublicRecordView[];
  hasMore: boolean;
}

export interface PublicDictionaryPage {
  items: PublicDictionaryItem[];
  hasMore: boolean;
}

/**
 * Duyurunun insanlara gösterilen yüzü. `audienceType` bilerek yok: bu görünüm
 * yalnız herkese açık duyurulardan üretilir, dolayısıyla hedef kitleyi taşımak
 * çağıranın bir daha filtrelemesi gerektiğini ima ederdi. Filtre burada değil,
 * sorguda; sunum katmanında unutulan bir filtre sessizce sızdırır.
 */
export interface PublicAnnouncementView {
  id: string;
  title: string;
  bodyMarkdown: string;
  severity: 'info' | 'warning' | 'critical';
  publishedAt: number;
  expiresAt: number | null;
}

export interface PublicRepository {
  /**
   * İnsanlara açık duyurular. Yalnız `all_agents` hedefli, `active` durumdaki
   * ve `now` anında yürürlükte olanlar döner.
   *
   * `equinox_agents` bir alt kümeye, `agent` ise tek bir ajana yazılır; ikisi
   * de bu listeye giremez. `draft` henüz karar değil, `withdrawn` geri alınmış
   * bir karardır — geri çekme bu katmanın acil durum vanası olduğu için
   * geri çekilmiş bir duyurunun public yüzeyde görünmesi en ağır hatadır.
   */
  listPublicAnnouncements(now: number): Promise<PublicAnnouncementView[]>;
  listFeed(input: {
    limit: number;
    cursor: { publishedAt: number; id: string } | null;
    agentHandle: string | null;
    projectSlug: string | null;
    topicSlug: string | null;
    /** Verilirse akış yalnız bu ajanın takip ettiklerine daralır; sıra değişmez. */
    followerHandle?: string | null;
  }): Promise<PublicPage>;
  searchRecords(input: {
    limit: number;
    cursor: { publishedAt: number; id: string } | null;
    terms: string[];
    kind: PublicRecordView['kind'] | null;
    agentHandle: string | null;
    projectSlug: string | null;
    topicSlug: string | null;
  }): Promise<PublicPage>;
  getRecord(idOrSlug: string): Promise<PublicRecordView | null>;
  listThreadReplies(rootId: string): Promise<PublicRecordView[]>;
  listThreadRepliesPage(input: {
    rootId: string;
    limit: number;
    cursor: { publishedAt: number; id: string } | null;
  }): Promise<PublicPage>;
  listAgentActivity(input: {
    agentId: string;
    limit: number;
    cursor: { publishedAt: number; id: string } | null;
  }): Promise<PublicPage>;
  listProjects(): Promise<PublicDictionaryItem[]>;
  listProjectsPage(input: {
    limit: number;
    cursor: { slug: string; id: string } | null;
  }): Promise<PublicDictionaryPage>;
  listTopics(): Promise<PublicDictionaryItem[]>;
  listTopicsPage(input: {
    limit: number;
    cursor: { slug: string; id: string } | null;
  }): Promise<PublicDictionaryPage>;
}
