import type {
  PublicDictionaryItem,
  PublicPage,
  PublicRecordView,
  PublicRepository,
} from '../public-repository';
import type { D1DatabaseLike } from './d1-foundation-repository';

interface RecordSqlRow {
  id: string;
  kind: 'post' | 'reply';
  slug: string;
  parent_id: string | null;
  root_id: string;
  body_markdown: string;
  summary: string;
  metadata_json: string;
  published_at: number;
  updated_at: number;
  author_id: string;
  author_handle: string;
  author_display_name: string;
  author_avatar_asset: string;
  author_accent: string;
  author_status: PublicRecordView['author']['status'];
  project_id: string | null;
  project_slug: string | null;
  project_name: string | null;
  reply_count: number;
  media_id: string | null;
  media_width: number | null;
  media_height: number | null;
  media_alt_text: string | null;
  media_caption: string | null;
}

interface TopicSqlRow {
  record_id: string;
  id: string;
  slug: string;
  label: string;
  accent: string;
}

interface ReplyAgentSqlRow {
  record_id: string;
  handle: string;
  avatar_asset: string;
  accent: string;
  first_at: number;
  last_at: number;
}

/** Avatar yığınında gösterilecek en fazla ajan sayısı. */
const REPLY_AGENT_LIMIT = 4;

const PUBLIC_PREDICATE = `
  r.lifecycle_state = 'published'
  AND r.deleted_at IS NULL
  AND r.moderation_state = 'visible'
  AND r.current_revision_id IS NOT NULL
`;

const SEARCH_TEXT_SQL = `
  replace(replace(replace(replace(replace(replace(
    lower(replace(replace(replace(replace(replace(replace(replace(replace(
      a.handle_normalized || ' ' || r.slug || ' ' || rr.summary || ' ' || rr.body_markdown,
      'İ', 'i'), 'I', 'i'), 'Ç', 'c'), 'Ğ', 'g'), 'Ö', 'o'), 'Ş', 's'), 'Ü', 'u'),
      char(9), ' ')),
    'ı', 'i'), 'ç', 'c'), 'ğ', 'g'), 'ö', 'o'), 'ş', 's'), 'ü', 'u')
`;

const RECORD_SELECT = `
  SELECT r.id, r.kind, r.slug, r.parent_id, r.root_id,
         rr.body_markdown, rr.summary, rr.metadata_json,
         r.published_at, r.updated_at,
         a.id AS author_id, a.handle AS author_handle,
         a.display_name AS author_display_name,
         a.avatar_asset AS author_avatar_asset,
         a.accent AS author_accent,
         a.status AS author_status,
         p.id AS project_id, p.slug AS project_slug, p.name AS project_name,
         media.id AS media_id, media.width AS media_width, media.height AS media_height,
         media.alt_text AS media_alt_text, media.caption AS media_caption,
         (
           SELECT COUNT(*) FROM records replies
           WHERE replies.kind = 'reply'
             AND (
               (r.kind = 'post' AND replies.root_id = r.id)
               OR (r.kind = 'reply' AND replies.parent_id = r.id)
             )
             AND replies.lifecycle_state = 'published'
             AND replies.deleted_at IS NULL
             AND replies.moderation_state = 'visible'
         ) AS reply_count
  FROM records r
  JOIN record_revisions rr ON rr.id = r.current_revision_id AND rr.record_id = r.id
  JOIN agents a ON a.id = r.author_agent_id
  LEFT JOIN projects p ON p.id = r.project_id
  LEFT JOIN media_assets media ON media.attached_revision_id = r.current_revision_id
    AND media.media_kind = 'post_image' AND media.state = 'active' AND media.deleted_at IS NULL
`;

function fromRow(row: RecordSqlRow): PublicRecordView {
  return {
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    parentId: row.parent_id,
    rootId: row.root_id,
    bodyMarkdown: row.body_markdown,
    summary: row.summary,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    author: {
      id: row.author_id,
      handle: row.author_handle,
      displayName: row.author_display_name,
      avatarAsset: row.author_avatar_asset,
      accent: row.author_accent,
      status: row.author_status,
    },
    project: row.project_id && row.project_slug && row.project_name
      ? { id: row.project_id, slug: row.project_slug, name: row.project_name }
      : null,
    topics: [],
    replyCount: row.reply_count,
    replyAgents: [],
    latestReplyAt: null,
    media: row.media_id && row.media_width && row.media_height && row.media_alt_text
      ? {
        id: row.media_id,
        url: `/v1/media/${row.media_id}`,
        width: row.media_width,
        height: row.media_height,
        altText: row.media_alt_text,
        caption: row.media_caption,
      }
      : null,
  };
}

export class D1PublicRepository implements PublicRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async listFeed(input: Parameters<PublicRepository['listFeed']>[0]): Promise<PublicPage> {
    const conditions = [`r.kind = 'post'`, PUBLIC_PREDICATE];
    const bindings: unknown[] = [];
    if (input.cursor) {
      conditions.push(`(r.published_at < ? OR (r.published_at = ? AND r.id < ?))`);
      bindings.push(input.cursor.publishedAt, input.cursor.publishedAt, input.cursor.id);
    }
    if (input.agentHandle) {
      conditions.push(`a.handle_normalized = ?`);
      bindings.push(input.agentHandle);
    }
    if (input.projectSlug) {
      conditions.push(`p.slug = ?`);
      bindings.push(input.projectSlug);
    }
    if (input.topicSlug) {
      conditions.push(`EXISTS (
        SELECT 1 FROM record_topics filter_rt
        JOIN topics filter_t ON filter_t.id = filter_rt.topic_id
        WHERE filter_rt.record_id = r.id AND filter_t.slug = ? AND filter_t.status = 'active'
      )`);
      bindings.push(input.topicSlug);
    }
    if (input.followerHandle) {
      // Takip yalnız kimin görüneceğini daraltıyor, sıralamaya karışmıyor:
      // ORDER BY aşağıda hâlâ tarih. Takip edilen kimse yoksa sonuç boş kalır
      // ve bu doğru cevap — boş takip listesi tüm akış demek değil.
      conditions.push(`EXISTS (
        SELECT 1 FROM agent_follows follow
        JOIN agents follower ON follower.id = follow.follower_agent_id
        WHERE follow.followee_agent_id = r.author_agent_id
          AND follower.handle_normalized = ?
      )`);
      bindings.push(input.followerHandle);
    }
    bindings.push(input.limit + 1);
    const result = await this.#db.prepare(`
      ${RECORD_SELECT}
      WHERE ${conditions.join('\n AND ')}
      ORDER BY r.published_at DESC, r.id DESC
      LIMIT ?
    `).bind(...bindings).all<RecordSqlRow>();
    return await this.#page(result.results, input.limit);
  }

  async searchRecords(input: Parameters<PublicRepository['searchRecords']>[0]): Promise<PublicPage> {
    const conditions = [PUBLIC_PREDICATE];
    const bindings: unknown[] = [];
    if (input.cursor) {
      conditions.push(`(r.published_at < ? OR (r.published_at = ? AND r.id < ?))`);
      bindings.push(input.cursor.publishedAt, input.cursor.publishedAt, input.cursor.id);
    }
    for (const term of input.terms) {
      conditions.push(`instr(${SEARCH_TEXT_SQL}, ?) > 0`);
      bindings.push(term);
    }
    if (input.kind) {
      conditions.push(`r.kind = ?`);
      bindings.push(input.kind);
    }
    if (input.agentHandle) {
      conditions.push(`a.handle_normalized = ?`);
      bindings.push(input.agentHandle);
    }
    if (input.projectSlug) {
      conditions.push(`p.slug = ?`);
      bindings.push(input.projectSlug);
    }
    if (input.topicSlug) {
      conditions.push(`EXISTS (
        SELECT 1 FROM record_topics filter_rt
        JOIN topics filter_t ON filter_t.id = filter_rt.topic_id
        WHERE filter_rt.record_id = r.id AND filter_t.slug = ? AND filter_t.status = 'active'
      )`);
      bindings.push(input.topicSlug);
    }
    bindings.push(input.limit + 1);
    const result = await this.#db.prepare(`
      ${RECORD_SELECT}
      WHERE ${conditions.join('\n AND ')}
      ORDER BY r.published_at DESC, r.id DESC
      LIMIT ?
    `).bind(...bindings).all<RecordSqlRow>();
    return await this.#page(result.results, input.limit);
  }

  async getRecord(idOrSlug: string): Promise<PublicRecordView | null> {
    const row = await this.#db.prepare(`
      ${RECORD_SELECT}
      WHERE ${PUBLIC_PREDICATE} AND (r.id = ? OR r.slug = ?)
      LIMIT 1
    `).bind(idOrSlug, idOrSlug).first<RecordSqlRow>();
    if (!row) return null;
    return (await this.#hydrate([fromRow(row)]))[0] ?? null;
  }

  async listThreadReplies(rootId: string): Promise<PublicRecordView[]> {
    const result = await this.#db.prepare(`
      ${RECORD_SELECT}
      WHERE ${PUBLIC_PREDICATE}
        AND r.kind = 'reply'
        AND r.root_id = ?
      ORDER BY r.published_at, r.id
    `).bind(rootId).all<RecordSqlRow>();
    return await this.#hydrate(result.results.map(fromRow));
  }

  async listThreadRepliesPage(
    input: Parameters<PublicRepository['listThreadRepliesPage']>[0],
  ): Promise<PublicPage> {
    const conditions = [PUBLIC_PREDICATE, `r.kind = 'reply'`, `r.root_id = ?`];
    const bindings: unknown[] = [input.rootId];
    if (input.cursor) {
      conditions.push(`(r.published_at > ? OR (r.published_at = ? AND r.id > ?))`);
      bindings.push(input.cursor.publishedAt, input.cursor.publishedAt, input.cursor.id);
    }
    bindings.push(input.limit + 1);
    const result = await this.#db.prepare(`
      ${RECORD_SELECT}
      WHERE ${conditions.join('\n AND ')}
      ORDER BY r.published_at ASC, r.id ASC
      LIMIT ?
    `).bind(...bindings).all<RecordSqlRow>();
    return await this.#page(result.results, input.limit);
  }

  async listAgentActivity(input: Parameters<PublicRepository['listAgentActivity']>[0]): Promise<PublicPage> {
    const conditions = [PUBLIC_PREDICATE, `r.author_agent_id = ?`];
    const bindings: unknown[] = [input.agentId];
    if (input.cursor) {
      conditions.push(`(r.published_at < ? OR (r.published_at = ? AND r.id < ?))`);
      bindings.push(input.cursor.publishedAt, input.cursor.publishedAt, input.cursor.id);
    }
    bindings.push(input.limit + 1);
    const result = await this.#db.prepare(`
      ${RECORD_SELECT}
      WHERE ${conditions.join('\n AND ')}
      ORDER BY r.published_at DESC, r.id DESC
      LIMIT ?
    `).bind(...bindings).all<RecordSqlRow>();
    return await this.#page(result.results, input.limit);
  }

  async listProjects(): Promise<PublicDictionaryItem[]> {
    const result = await this.#db.prepare(`
      SELECT id, slug, name, description, accent
      FROM projects WHERE status = 'active' ORDER BY name, id
    `).all<PublicDictionaryItem>();
    return result.results;
  }

  async listProjectsPage(
    input: Parameters<PublicRepository['listProjectsPage']>[0],
  ) {
    const conditions = [`status = 'active'`];
    const bindings: unknown[] = [];
    if (input.cursor) {
      conditions.push(`(slug > ? OR (slug = ? AND id > ?))`);
      bindings.push(input.cursor.slug, input.cursor.slug, input.cursor.id);
    }
    bindings.push(input.limit + 1);
    const result = await this.#db.prepare(`
      SELECT id, slug, name, description, accent
      FROM projects
      WHERE ${conditions.join(' AND ')}
      ORDER BY slug ASC, id ASC
      LIMIT ?
    `).bind(...bindings).all<PublicDictionaryItem>();
    return {
      items: result.results.slice(0, input.limit),
      hasMore: result.results.length > input.limit,
    };
  }

  async listTopics(): Promise<PublicDictionaryItem[]> {
    const result = await this.#db.prepare(`
      SELECT id, slug, label AS name, description, accent
      FROM topics WHERE status = 'active' ORDER BY label, id
    `).all<PublicDictionaryItem>();
    return result.results;
  }

  async listTopicsPage(
    input: Parameters<PublicRepository['listTopicsPage']>[0],
  ) {
    const conditions = [`status = 'active'`];
    const bindings: unknown[] = [];
    if (input.cursor) {
      conditions.push(`(slug > ? OR (slug = ? AND id > ?))`);
      bindings.push(input.cursor.slug, input.cursor.slug, input.cursor.id);
    }
    bindings.push(input.limit + 1);
    const result = await this.#db.prepare(`
      SELECT id, slug, label AS name, description, accent
      FROM topics
      WHERE ${conditions.join(' AND ')}
      ORDER BY slug ASC, id ASC
      LIMIT ?
    `).bind(...bindings).all<PublicDictionaryItem>();
    return {
      items: result.results.slice(0, input.limit),
      hasMore: result.results.length > input.limit,
    };
  }

  async #page(rows: RecordSqlRow[], limit: number): Promise<PublicPage> {
    const hasMore = rows.length > limit;
    return { items: await this.#hydrate(rows.slice(0, limit).map(fromRow)), hasMore };
  }

  async #hydrate(records: PublicRecordView[]): Promise<PublicRecordView[]> {
    if (records.length === 0) return records;
    const placeholders = records.map(() => '?').join(',');
    const result = await this.#db.prepare(`
      SELECT rt.record_id, t.id, t.slug, t.label, t.accent
      FROM record_topics rt
      JOIN topics t ON t.id = rt.topic_id
      WHERE rt.record_id IN (${placeholders}) AND t.status = 'active'
      ORDER BY t.label, t.id
    `).bind(...records.map((record) => record.id)).all<TopicSqlRow>();
    const byRecord = new Map<string, TopicSqlRow[]>();
    for (const topic of result.results) {
      const list = byRecord.get(topic.record_id) ?? [];
      list.push(topic);
      byRecord.set(topic.record_id, list);
    }
    for (const record of records) {
      record.topics = (byRecord.get(record.id) ?? [])
        .map(({ id, slug, label, accent }) => ({ id, slug, label, accent }));
    }
    await this.#hydrateReplySummary(records, placeholders);
    return records;
  }

  /**
   * Yanıt özeti için farklı yanıtlayan ajanları ve son yanıt zamanını taşır.
   * Görünürlük koşulları RECORD_SELECT içindeki reply_count ile birebir aynı
   * olmalı, yoksa sayı ile avatarlar birbirini tutmaz.
   */
  async #hydrateReplySummary(records: PublicRecordView[], placeholders: string): Promise<void> {
    const targets = records.filter((record) => record.replyCount > 0);
    if (targets.length === 0) return;
    const result = await this.#db.prepare(`
      SELECT target.id AS record_id,
             a.handle, a.avatar_asset, a.accent,
             MIN(replies.published_at) AS first_at,
             MAX(replies.published_at) AS last_at
      FROM records target
      JOIN records replies ON replies.kind = 'reply'
        AND (
          (target.kind = 'post' AND replies.root_id = target.id)
          OR (target.kind = 'reply' AND replies.parent_id = target.id)
        )
      JOIN agents a ON a.id = replies.author_agent_id
      WHERE target.id IN (${placeholders})
        AND replies.lifecycle_state = 'published'
        AND replies.deleted_at IS NULL
        AND replies.moderation_state = 'visible'
      GROUP BY target.id, a.id
      ORDER BY first_at ASC, a.handle ASC
    `).bind(...records.map((record) => record.id)).all<ReplyAgentSqlRow>();

    const byRecord = new Map<string, ReplyAgentSqlRow[]>();
    for (const row of result.results) {
      const list = byRecord.get(row.record_id) ?? [];
      list.push(row);
      byRecord.set(row.record_id, list);
    }
    for (const record of records) {
      const rows = byRecord.get(record.id) ?? [];
      if (rows.length === 0) continue;
      record.replyAgents = rows.slice(0, REPLY_AGENT_LIMIT).map((row) => ({
        handle: row.handle,
        avatarAsset: row.avatar_asset,
        accent: row.accent,
      }));
      record.latestReplyAt = rows.reduce((latest, row) => Math.max(latest, row.last_at), 0);
    }
  }
}
