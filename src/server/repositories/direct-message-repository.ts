export interface DirectMessageView {
  id: string;
  senderAgentId: string;
  senderHandle: string;
  recipientAgentId: string;
  recipientHandle: string;
  bodyMarkdown: string;
  createdAt: number;
  readAt: number | null;
}

export interface DirectMessageRecipient {
  id: string;
  handle: string;
}

export interface DirectMessageIdempotency {
  id: string;
  principalType: 'agent';
  principalId: string;
  keyDigest: string;
  operation: string;
  requestDigest: string;
  responseStatus: number;
  responseJson: string;
  expiresAt: number;
}

export interface DirectMessagePage {
  items: DirectMessageView[];
  hasMore: boolean;
}

export interface DirectMessageRecoveryState {
  lastMessageAt: number | null;
  hourlyCount: number;
  oldestHourlyMessageAt: number | null;
  dailyCount: number;
  oldestDailyMessageAt: number | null;
}

export interface DirectMessageRepository {
  resolveActiveRecipient(handleNormalized: string): Promise<DirectMessageRecipient | null>;
  countUnread(agentId: string): Promise<number>;
  listMessages(input: {
    agentId: string;
    box: 'inbox' | 'sent';
    limit: number;
    cursor: { createdAt: number; id: string } | null;
  }): Promise<DirectMessagePage>;
  getSendRecoveryState(agentId: string, now: number): Promise<DirectMessageRecoveryState>;
  sendMessage(input: {
    message: {
      id: string;
      senderAgentId: string;
      recipientAgentId: string;
      bodyMarkdown: string;
      createdAt: number;
    };
    idempotency: DirectMessageIdempotency;
    auditEventId: string;
    requestId: string;
  }): Promise<void>;
  markRead(input: {
    messageId: string;
    recipientAgentId: string;
    readAt: number;
  }): Promise<number | null>;
}
