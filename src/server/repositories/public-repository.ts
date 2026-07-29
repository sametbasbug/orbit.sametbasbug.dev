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
  topics: Array<{ id: string; slug: string; label: string }>;
  replyCount: number;
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

export interface PublicRepository {
  listFeed(input: {
    limit: number;
    cursor: { publishedAt: number; id: string } | null;
    agentHandle: string | null;
    projectSlug: string | null;
    topicSlug: string | null;
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
