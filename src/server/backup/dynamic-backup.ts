import { createEntityId } from '../foundation/ids';
import { canonicalJson } from '../publication/content';
import { randomBase64Url, sha256Base64Url } from '../identity/tokens';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../repositories/d1/d1-foundation-repository';

export const BACKUP_SCHEMA = 'equinox.orbit.dynamic-backup.v1';
export const BACKUP_SCHEMA_VERSION = 1;

type BackupRow = Record<string, string | number | null>;

export interface DynamicBackup {
  schema: typeof BACKUP_SCHEMA;
  schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  createdAt: string;
  counts: Record<string, number>;
  security: {
    containsCredentialDigests: boolean;
    containsSessionDigests: boolean;
    containsPlaintextSecrets: false;
  };
  tables: Record<string, BackupRow[]>;
  checksum: { algorithm: 'sha256'; value: string };
}

interface TableSpec {
  exportName: string;
  table: string;
  columns: string[];
  orderBy: string;
  optional?: boolean;
}

const SPECS: TableSpec[] = [
  { exportName: 'accounts', table: 'accounts', columns: ['id','handle','handle_normalized','display_name','avatar_url','status','created_at','updated_at','last_login_at'], orderBy: 'id' },
  { exportName: 'authIdentities', table: 'auth_identities', columns: ['id','account_id','provider','provider_user_id','provider_login_snapshot','created_at','last_seen_at'], orderBy: 'id' },
  { exportName: 'accountRoles', table: 'account_roles', columns: ['id','account_id','role','granted_by_account_id','granted_at','revoked_at'], orderBy: 'id' },
  { exportName: 'accountQuotas', table: 'account_quotas', columns: ['account_id','quota_key','limit_value','updated_by_account_id','updated_at'], orderBy: 'account_id, quota_key' },
  { exportName: 'invitations', table: 'invitations', columns: ['id','secret_digest','hash_version','expected_github_user_id','expected_github_login_snapshot','agent_quota','created_by_account_id','created_at','expires_at','redeemed_at','redeemed_by_account_id','revoked_at','revoked_by_account_id'], orderBy: 'id' },
  { exportName: 'agents', table: 'agents', columns: ['id','handle','handle_normalized','display_name','bio','avatar_asset','publication_mode','status','created_at','updated_at','version','role','short_bio','motto','accent','responsibility','links_json'], orderBy: 'id' },
  { exportName: 'agentMemberships', table: 'agent_memberships', columns: ['id','agent_id','account_id','role','created_by_account_id','created_at','revoked_at'], orderBy: 'id' },
  { exportName: 'agentCredentials', table: 'agent_credentials', columns: ['id','agent_id','secret_digest','hash_version','scopes','created_by_account_id','created_at','last_used_at','expires_at','revoked_at','revoked_reason','replaced_by_credential_id'], orderBy: 'created_at, id' },
  { exportName: 'sessions', table: 'sessions', columns: ['id','account_id','secret_digest','hash_version','csrf_digest','created_at','last_seen_at','idle_expires_at','absolute_expires_at','revoked_at','revoked_reason'], orderBy: 'created_at, id', optional: true },
  { exportName: 'projects', table: 'projects', columns: ['id','slug','name','status','created_at','updated_at','label','footer_label','description','href','accent'], orderBy: 'id' },
  { exportName: 'topics', table: 'topics', columns: ['id','slug','label','status','description','accent'], orderBy: 'id' },
  { exportName: 'records', table: 'records', columns: ['id','kind','author_agent_id','slug','parent_id','root_id','project_id','lifecycle_state','current_revision_id','pending_revision_id','version','created_at','published_at','updated_at','deleted_at','moderation_state','moderated_at'], orderBy: "CASE kind WHEN 'post' THEN 0 ELSE 1 END, created_at, id" },
  { exportName: 'recordRevisions', table: 'record_revisions', columns: ['id','record_id','revision_number','body_markdown','summary','state','created_by_agent_id','created_by_account_id','created_at','published_at','metadata_json'], orderBy: 'record_id, revision_number' },
  { exportName: 'recordTopics', table: 'record_topics', columns: ['record_id','topic_id','created_at'], orderBy: 'record_id, topic_id' },
  { exportName: 'publicationReviews', table: 'publication_reviews', columns: ['id','record_id','revision_id','status','requested_at','reviewer_account_id','reviewed_at','review_note'], orderBy: 'requested_at, id' },
  { exportName: 'agentUsageDaily', table: 'agent_usage_daily', columns: ['agent_id','day_utc','posts_created','replies_created','write_attempts','updated_at'], orderBy: 'agent_id, day_utc' },
  { exportName: 'moderationActions', table: 'moderation_actions', columns: ['id','actor_account_id','action','target_type','target_id','reason','created_at','reversed_by_action_id'], orderBy: 'created_at, id' },
  { exportName: 'auditEvents', table: 'audit_events', columns: ['sequence','id','event_type','actor_type','actor_id','subject_type','subject_id','request_id','metadata_json','created_at'], orderBy: 'sequence' },
  { exportName: 'slugReservations', table: 'record_slug_reservations', columns: ['slug','record_id','created_at'], orderBy: 'slug' },
];

function payload(backup: Omit<DynamicBackup, 'checksum'>): string {
  return canonicalJson(backup);
}

export async function createDynamicBackup(
  db: D1DatabaseLike,
  now = Date.now(),
  includeSessions = false,
): Promise<DynamicBackup> {
  const tables: Record<string, BackupRow[]> = {};
  for (const spec of SPECS) {
    if (spec.optional && !includeSessions) {
      tables[spec.exportName] = [];
      continue;
    }
    try {
      const result = await db.prepare(
        `SELECT ${spec.columns.join(', ')} FROM ${spec.table} ORDER BY ${spec.orderBy}`,
      ).all<BackupRow>();
      tables[spec.exportName] = result.results;
    } catch (error) {
      const code = error instanceof Error ? error.message : 'unknown';
      throw new Error(`backup_export_table_failed:${spec.exportName}:${code}`);
    }
  }
  const counts = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
  const unsigned: Omit<DynamicBackup, 'checksum'> = {
    schema: BACKUP_SCHEMA,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: new Date(now).toISOString(),
    counts,
    security: {
      containsCredentialDigests: tables.agentCredentials.length > 0,
      containsSessionDigests: tables.sessions.length > 0,
      containsPlaintextSecrets: false as const,
    },
    tables,
  };
  return {
    ...unsigned,
    checksum: { algorithm: 'sha256', value: await sha256Base64Url(payload(unsigned)) },
  };
}

export async function verifyDynamicBackup(value: unknown): Promise<DynamicBackup> {
  if (!value || typeof value !== 'object') throw new Error('backup_invalid');
  const backup = value as DynamicBackup;
  if (backup.schema !== BACKUP_SCHEMA || backup.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error('backup_schema_unsupported');
  }
  if (backup.security?.containsPlaintextSecrets !== false || !backup.tables || !backup.counts) {
    throw new Error('backup_security_contract_invalid');
  }
  for (const spec of SPECS) {
    const rows = backup.tables[spec.exportName];
    if (!Array.isArray(rows) || backup.counts[spec.exportName] !== rows.length) {
      throw new Error('backup_count_mismatch');
    }
    for (const row of rows) {
      if (!row || typeof row !== 'object' || spec.columns.some((column) => !(column in row))) {
        throw new Error('backup_row_invalid');
      }
      const unexpected = Object.keys(row).filter((column) => !spec.columns.includes(column));
      if (unexpected.length > 0) throw new Error('backup_row_invalid');
    }
  }
  const { checksum, ...unsigned } = backup;
  if (checksum?.algorithm !== 'sha256') throw new Error('backup_checksum_invalid');
  const actual = await sha256Base64Url(payload(unsigned));
  if (actual !== checksum.value) throw new Error('backup_checksum_invalid');
  validateRelationships(backup);
  return backup;
}

function validateRelationships(backup: DynamicBackup): void {
  const recordIds = new Set(backup.tables.records.map((row) => String(row.id)));
  const revisionsByRecord = new Set(
    backup.tables.recordRevisions.map((row) => `${String(row.record_id)}:${String(row.id)}`),
  );
  for (const row of backup.tables.records) {
    const id = String(row.id);
    if (!recordIds.has(String(row.root_id))) throw new Error('backup_root_missing');
    if (row.kind === 'reply' && (!row.parent_id || !recordIds.has(String(row.parent_id)))) {
      throw new Error('backup_parent_missing');
    }
    if (row.current_revision_id && !revisionsByRecord.has(`${id}:${String(row.current_revision_id)}`)) {
      throw new Error('backup_current_revision_missing');
    }
    if (row.pending_revision_id && !revisionsByRecord.has(`${id}:${String(row.pending_revision_id)}`)) {
      throw new Error('backup_pending_revision_missing');
    }
  }
}

function insert(db: D1DatabaseLike, spec: TableSpec, row: BackupRow, orIgnore = false): D1PreparedStatementLike {
  const placeholders = spec.columns.map(() => '?').join(', ');
  return db.prepare(
    `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${spec.table} (${spec.columns.join(', ')}) VALUES (${placeholders})`,
  ).bind(...spec.columns.map((column) => row[column]));
}

function spec(name: string): TableSpec {
  const value = SPECS.find((item) => item.exportName === name);
  if (!value) throw new Error(`backup_table_unknown:${name}`);
  return value;
}

function orderedRecords(rows: BackupRow[]): BackupRow[] {
  const remaining = new Map(rows.map((row) => [String(row.id), row]));
  const output: BackupRow[] = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const [id, row] of remaining) {
      const parent = row.parent_id ? String(row.parent_id) : null;
      const root = String(row.root_id);
      if ((parent === null || !remaining.has(parent)) && (root === id || !remaining.has(root))) {
        output.push(row);
        remaining.delete(id);
        progressed = true;
      }
    }
    if (!progressed) throw new Error('backup_record_cycle');
  }
  return output;
}

export async function restoreDynamicBackup(
  db: D1DatabaseLike,
  input: unknown,
  options: { revokeSecurity?: boolean; now?: number } = {},
): Promise<{ counts: Record<string, number>; foreignKeyViolations: number }> {
  const backup = await verifyDynamicBackup(input);
  const occupied = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM agents) AS agents,
      (SELECT COUNT(*) FROM records) AS records,
      (SELECT COUNT(*) FROM projects) AS projects,
      (SELECT COUNT(*) FROM topics) AS topics
  `).first<{ agents: number; records: number; projects: number; topics: number }>();
  if (!occupied || occupied.agents || occupied.records || occupied.projects || occupied.topics) {
    throw new Error('backup_restore_target_not_empty');
  }

  const statements: D1PreparedStatementLike[] = [];
  const seedSafe = new Set(['accounts', 'authIdentities', 'accountRoles', 'accountQuotas', 'auditEvents']);
  const first = ['accounts','authIdentities','accountRoles','accountQuotas','invitations','agents','agentMemberships','agentCredentials','sessions','projects','topics'];
  for (const name of first) {
    const item = spec(name);
    for (const row of backup.tables[name]) {
      const adjusted = { ...row };
      if (name === 'agentCredentials') adjusted.replaced_by_credential_id = null;
      statements.push(insert(db, item, adjusted, seedSafe.has(name)));
    }
  }

  const recordsSpec = spec('records');
  for (const row of orderedRecords(backup.tables.records)) {
    statements.push(insert(db, recordsSpec, {
      ...row, current_revision_id: null, pending_revision_id: null,
    }));
  }
  for (const row of backup.tables.recordRevisions) statements.push(insert(db, spec('recordRevisions'), row));
  for (const row of backup.tables.records) {
    statements.push(db.prepare(`
      UPDATE records SET current_revision_id = ?, pending_revision_id = ? WHERE id = ?
    `).bind(row.current_revision_id, row.pending_revision_id, row.id));
  }
  for (const row of backup.tables.agentCredentials) {
    if (row.replaced_by_credential_id) {
      statements.push(db.prepare(`
        UPDATE agent_credentials SET replaced_by_credential_id = ? WHERE id = ?
      `).bind(row.replaced_by_credential_id, row.id));
    }
  }
  for (const name of ['recordTopics','publicationReviews','agentUsageDaily','moderationActions','slugReservations']) {
    const item = spec(name);
    for (const row of backup.tables[name]) statements.push(insert(db, item, row));
  }
  for (const row of backup.tables.auditEvents) statements.push(insert(db, spec('auditEvents'), row, true));

  const now = options.now ?? Date.now();
  if (options.revokeSecurity) {
    statements.push(
      db.prepare(`UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, 'restore_bulk_revoke')`).bind(now),
      db.prepare(`UPDATE agent_credentials SET revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, 'restore_bulk_revoke')`).bind(now),
    );
  }

  const expectedCounts = {
    accounts: backup.counts.accounts,
    agents: backup.counts.agents,
    agentMemberships: backup.counts.agentMemberships,
    projects: backup.counts.projects,
    topics: backup.counts.topics,
    records: backup.counts.records,
    recordRevisions: backup.counts.recordRevisions,
    publicationReviews: backup.counts.publicationReviews,
    moderationActions: backup.counts.moderationActions,
    auditEvents: backup.counts.auditEvents,
  };
  statements.push(db.prepare(`
    INSERT INTO backup_restore_validations (
      id, schema_version, expected_counts_json, created_at
    ) VALUES (?, ?, ?, ?)
  `).bind(createEntityId(), BACKUP_SCHEMA_VERSION, canonicalJson(expectedCounts), now));
  await db.batch(statements);

  const fk = await db.prepare(`PRAGMA foreign_key_check`).all();
  if (fk.results.length > 0) throw new Error('backup_restore_foreign_key_failure');
  return { counts: expectedCounts, foreignKeyViolations: 0 };
}

export interface EncryptedBackupEnvelope {
  schema: 'equinox.orbit.encrypted-backup.v1';
  algorithm: 'AES-GCM-256';
  keyId: string;
  iv: string;
  ciphertext: string;
  plaintextChecksum: string;
}

export async function encryptDynamicBackup(
  backup: DynamicBackup,
  key: CryptoKey,
  keyId: string,
): Promise<EncryptedBackupEnvelope> {
  const ivText = randomBase64Url(12);
  const decode = (value: string) => Uint8Array.from(
    atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)),
    (character) => character.charCodeAt(0),
  );
  const encoded = new TextEncoder().encode(canonicalJson(backup));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: decode(ivText) }, key, encoded));
  const binary = Array.from(ciphertext, (byte) => String.fromCharCode(byte)).join('');
  const encodedCiphertext = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  return {
    schema: 'equinox.orbit.encrypted-backup.v1', algorithm: 'AES-GCM-256', keyId,
    iv: ivText, ciphertext: encodedCiphertext, plaintextChecksum: backup.checksum.value,
  };
}
