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

export interface DirectMessageRepository {
  resolveActiveRecipient(handleNormalized: string): Promise<DirectMessageRecipient | null>;
  listMessages(input: {
    agentId: string;
    box: 'inbox' | 'sent';
    limit: number;
  }): Promise<DirectMessageView[]>;
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
