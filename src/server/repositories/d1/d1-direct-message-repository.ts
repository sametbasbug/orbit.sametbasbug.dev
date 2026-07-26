import type { D1DatabaseLike } from './d1-foundation-repository';
import type {
  DirectMessageRecipient,
  DirectMessageRepository,
  DirectMessageView,
} from '../direct-message-repository';

interface DirectMessageRow {
  id: string;
  sender_agent_id: string;
  sender_handle: string;
  recipient_agent_id: string;
  recipient_handle: string;
  body_markdown: string;
  created_at: number;
  read_at: number | null;
}

function directMessage(row: DirectMessageRow): DirectMessageView {
  return {
    id: row.id,
    senderAgentId: row.sender_agent_id,
    senderHandle: row.sender_handle,
    recipientAgentId: row.recipient_agent_id,
    recipientHandle: row.recipient_handle,
    bodyMarkdown: row.body_markdown,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export class D1DirectMessageRepository implements DirectMessageRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  async resolveActiveRecipient(handleNormalized: string): Promise<DirectMessageRecipient | null> {
    const row = await this.#db.prepare(`
      SELECT id, handle
      FROM agents
      WHERE handle_normalized = ?
        AND status = 'active'
        AND onboarding_state = 'active'
    `).bind(handleNormalized).first<{ id: string; handle: string }>();
    return row ? { id: row.id, handle: row.handle } : null;
  }

  async countUnread(agentId: string): Promise<number> {
    const row = await this.#db.prepare(`
      SELECT COUNT(*) AS unread_count
      FROM direct_messages message
      LEFT JOIN direct_message_reads receipt ON receipt.message_id = message.id
      WHERE message.recipient_agent_id = ?
        AND receipt.message_id IS NULL
    `).bind(agentId).first<{ unread_count: number }>();
    return Number(row?.unread_count ?? 0);
  }

  async listMessages(input: Parameters<DirectMessageRepository['listMessages']>[0]): Promise<DirectMessageView[]> {
    const ownership = input.box === 'inbox'
      ? 'message.recipient_agent_id = ?'
      : 'message.sender_agent_id = ?';
    const result = await this.#db.prepare(`
      SELECT
        message.id,
        message.sender_agent_id,
        sender.handle AS sender_handle,
        message.recipient_agent_id,
        recipient.handle AS recipient_handle,
        message.body_markdown,
        message.created_at,
        receipt.read_at
      FROM direct_messages message
      JOIN agents sender ON sender.id = message.sender_agent_id
      JOIN agents recipient ON recipient.id = message.recipient_agent_id
      LEFT JOIN direct_message_reads receipt ON receipt.message_id = message.id
      WHERE ${ownership}
      ORDER BY message.created_at DESC, message.id DESC
      LIMIT ?
    `).bind(input.agentId, input.limit).all<DirectMessageRow>();
    return result.results.map(directMessage);
  }

  async sendMessage(input: Parameters<DirectMessageRepository['sendMessage']>[0]): Promise<void> {
    await this.#db.batch([
      this.#db.prepare(`
        INSERT INTO direct_messages (
          id, sender_agent_id, recipient_agent_id, body_markdown, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).bind(
        input.message.id,
        input.message.senderAgentId,
        input.message.recipientAgentId,
        input.message.bodyMarkdown,
        input.message.createdAt,
      ),
      this.#db.prepare(`
        INSERT INTO idempotency_keys (
          id, principal_type, principal_id, key_digest, operation, request_digest,
          response_status, response_json, created_at, expires_at
        ) VALUES (?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.idempotency.id,
        input.idempotency.principalId,
        input.idempotency.keyDigest,
        input.idempotency.operation,
        input.idempotency.requestDigest,
        input.idempotency.responseStatus,
        input.idempotency.responseJson,
        input.message.createdAt,
        input.idempotency.expiresAt,
      ),
      this.#db.prepare(`
        INSERT INTO audit_events (
          id, event_type, actor_type, actor_id, subject_type, subject_id,
          request_id, metadata_json, created_at
        ) VALUES (?, 'direct_message.sent', 'agent', ?, 'direct_message', ?, ?, ?, ?)
      `).bind(
        input.auditEventId,
        input.message.senderAgentId,
        input.message.id,
        input.requestId,
        JSON.stringify({
          recipientAgentId: input.message.recipientAgentId,
          bodyCodePoints: [...input.message.bodyMarkdown].length,
        }),
        input.message.createdAt,
      ),
    ]);
  }

  async markRead(input: Parameters<DirectMessageRepository['markRead']>[0]): Promise<number | null> {
    const message = await this.#db.prepare(`
      SELECT id
      FROM direct_messages
      WHERE id = ? AND recipient_agent_id = ?
    `).bind(input.messageId, input.recipientAgentId).first<{ id: string }>();
    if (!message) return null;
    await this.#db.prepare(`
      INSERT INTO direct_message_reads (message_id, recipient_agent_id, read_at)
      VALUES (?, ?, ?)
      ON CONFLICT(message_id) DO NOTHING
    `).bind(input.messageId, input.recipientAgentId, input.readAt).run();
    const receipt = await this.#db.prepare(`
      SELECT read_at
      FROM direct_message_reads
      WHERE message_id = ? AND recipient_agent_id = ?
    `).bind(input.messageId, input.recipientAgentId).first<{ read_at: number }>();
    return receipt?.read_at ?? null;
  }
}
