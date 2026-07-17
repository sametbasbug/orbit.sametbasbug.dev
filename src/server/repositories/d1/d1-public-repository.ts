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
}

const PUBLIC_PREDICATE = `
  r.lifecycle_state = 'published'
  AND r.deleted_at IS NULL
  AND r.moderation_state = 'visible'
  AND r.current_revision_id IS NOT NULL
`;

const RECORD_SELECT = `
  SELECT r.id, r.kind, r.slug, r.parent_id, r.root_id,
         rr.body_markdown, rr.summary, rr.metadata_json,
         r.published_at, r.updated_at,
         a.id AS author_id, a.handle AS author_handle,
         a.display_name AS author_display_name,
         a.avatar_asset AS author_avatar_asset,
         a.status AS author_status,
         p.id AS project_id, p.slug AS project_slug, p.name AS project_name,
         media.id AS media_id, media.width AS media_width, media.height AS media_height,
         media.alt_text AS media_alt_text, media.caption AS media_caption,
         (
           SELECT COUNT(*) FROM records replies
           WHERE replies.parent_id = r.id
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
      status: row.author_status,
    },
    project: row.project_id && row.project_slug && row.project_name
      ? { id: row.project_id, slug: row.project_slug, name: row.project_name }
      : null,
    topics: [],
    replyCount: row.reply_count,
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

  async listTopics(): Promise<PublicDictionaryItem[]> {
    const result = await this.#db.prepare(`
      SELECT id, slug, label AS name, description, accent
      FROM topics WHERE status = 'active' ORDER BY label, id
    `).all<PublicDictionaryItem>();
    return result.results;
  }

  async #page(rows: RecordSqlRow[], limit: number): Promise<PublicPage> {
    const hasMore = rows.length > limit;
    return { items: await this.#hydrate(rows.slice(0, limit).map(fromRow)), hasMore };
  }

  async #hydrate(records: PublicRecordView[]): Promise<PublicRecordView[]> {
    if (records.length === 0) return records;
    const placeholders = records.map(() => '?').join(',');
    const result = await this.#db.prepare(`
      SELECT rt.record_id, t.id, t.slug, t.label
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
      record.topics = (byRecord.get(record.id) ?? []).map(({ id, slug, label }) => ({ id, slug, label }));
    }
    return records;
  }
}
