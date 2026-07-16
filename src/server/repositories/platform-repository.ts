export interface SessionListItem {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  current: boolean;
}

export interface AnnouncementView {
  id: string;
  title: string;
  bodyMarkdown: string;
  severity: 'info' | 'warning' | 'critical';
  audienceType: 'all_agents' | 'equinox_agents' | 'agent';
  targetAgentId: string | null;
  status: 'draft' | 'active' | 'expired' | 'withdrawn';
  startsAt: number;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  withdrawnAt: number | null;
  readAt: number | null;
}

export interface BackupRunView {
  id: string;
  backupKind: 'daily' | 'weekly' | 'monthly' | 'manual';
  status: 'running' | 'succeeded' | 'failed';
  objectKey: string | null;
  manifestChecksum: string | null;
  schemaVersion: number | null;
  counts: Record<string, number> | null;
  errorCode: string | null;
  startedAt: number;
  completedAt: number | null;
}

export interface PlatformRepository {
  listSessions(accountId: string, currentSessionId: string, now: number): Promise<SessionListItem[]>;
  revokeOwnedSession(input: { accountId: string; sessionId: string; auditEventId: string; requestId: string; now: number }): Promise<void>;
  listAnnouncementsForAgent(agentId: string, isEquinox: boolean, now: number): Promise<AnnouncementView[]>;
  markAnnouncementRead(input: { announcementId: string; agentId: string; auditEventId: string; requestId: string; now: number }): Promise<void>;
  listAnnouncementsForOwner(now: number): Promise<AnnouncementView[]>;
  createAnnouncement(input: Omit<AnnouncementView, 'status' | 'readAt' | 'updatedAt' | 'publishedAt' | 'withdrawnAt'> & { actorAccountId: string; auditEventId: string; requestId: string }): Promise<void>;
  transitionAnnouncement(input: { announcementId: string; action: 'publish' | 'withdraw'; actorAccountId: string; transitionId: string; auditEventId: string; requestId: string; now: number }): Promise<void>;
  expireAnnouncements(now: number): Promise<number>;
  reverseModeration(input: { originalActionId: string; actorAccountId: string; reversalActionId: string; reason: string; auditEventId: string; requestId: string; now: number }): Promise<void>;
  startBackupRun(input: { id: string; kind: BackupRunView['backupKind']; actorAccountId: string | null; now: number }): Promise<void>;
  finishBackupRun(input: { id: string; objectKey: string; manifestChecksum: string; schemaVersion: number; counts: Record<string, number>; now: number }): Promise<void>;
  failBackupRun(input: { id: string; errorCode: string; now: number }): Promise<void>;
  listBackupRuns(limit: number): Promise<BackupRunView[]>;
}
