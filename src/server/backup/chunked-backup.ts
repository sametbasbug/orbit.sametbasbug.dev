import { canonicalJson } from '../publication/content';
import { randomBase64Url, sha256Base64Url } from '../identity/tokens';
import type { D1DatabaseLike } from '../repositories/d1/d1-foundation-repository';
import {
  createDynamicBackup,
  restoreDynamicBackup,
  verifyDynamicBackup,
  type DynamicBackup,
} from './dynamic-backup';

export const CHUNKED_BACKUP_SCHEMA = 'equinox.orbit.chunked-backup.v1';
export const CHUNKED_BACKUP_VERSION = 1;
export const MAX_CHUNK_ROWS = 500;
export const MAX_CHUNK_BYTES = 1024 * 1024;

type BackupRow = Record<string, string | number | null>;

export interface ChunkDescriptor {
  id: string;
  table: string;
  sequence: number;
  rowCount: number;
  byteLength: number;
  checksum: { algorithm: 'sha256'; value: string };
}

export interface BackupChunk extends ChunkDescriptor {
  rows: BackupRow[];
}

export interface ChunkedBackupManifest {
  schema: typeof CHUNKED_BACKUP_SCHEMA;
  schemaVersion: typeof CHUNKED_BACKUP_VERSION;
  sourceSchema: DynamicBackup['schema'];
  sourceSchemaVersion: DynamicBackup['schemaVersion'];
  createdAt: string;
  counts: Record<string, number>;
  security: DynamicBackup['security'];
  chunks: ChunkDescriptor[];
  checksum: { algorithm: 'sha256'; value: string };
}

export interface ChunkedBackupBundle {
  manifest: ChunkedBackupManifest;
  chunks: BackupChunk[];
}

function chunkPayload(table: string, sequence: number, rows: BackupRow[]): string {
  return canonicalJson({ table, sequence, rows });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function descriptor(table: string, sequence: number, rows: BackupRow[]): Promise<BackupChunk> {
  const payload = chunkPayload(table, sequence, rows);
  return {
    id: `${table}-${String(sequence).padStart(6, '0')}`,
    table,
    sequence,
    rowCount: rows.length,
    byteLength: byteLength(payload),
    checksum: { algorithm: 'sha256', value: await sha256Base64Url(payload) },
    rows,
  };
}

function unsignedManifest(manifest: ChunkedBackupManifest): Omit<ChunkedBackupManifest, 'checksum'> {
  const { checksum: _checksum, ...unsigned } = manifest;
  return unsigned;
}

export async function createChunkedBackup(
  db: D1DatabaseLike,
  now = Date.now(),
  includeSessions = false,
): Promise<ChunkedBackupBundle> {
  const source = await createDynamicBackup(db, now, includeSessions);
  const chunks: BackupChunk[] = [];
  for (const [table, rows] of Object.entries(source.tables)) {
    let pending: BackupRow[] = [];
    let sequence = 0;
    for (const row of rows) {
      const candidate = [...pending, row];
      const size = byteLength(chunkPayload(table, sequence, candidate));
      if (pending.length > 0 && (candidate.length > MAX_CHUNK_ROWS || size > MAX_CHUNK_BYTES)) {
        chunks.push(await descriptor(table, sequence, pending));
        sequence += 1;
        pending = [row];
      } else {
        pending = candidate;
      }
    }
    if (pending.length > 0) chunks.push(await descriptor(table, sequence, pending));
  }
  const descriptors = chunks.map(({ rows: _rows, ...item }) => item);
  const base: Omit<ChunkedBackupManifest, 'checksum'> = {
    schema: CHUNKED_BACKUP_SCHEMA,
    schemaVersion: CHUNKED_BACKUP_VERSION,
    sourceSchema: source.schema,
    sourceSchemaVersion: source.schemaVersion,
    createdAt: source.createdAt,
    counts: source.counts,
    security: source.security,
    chunks: descriptors,
  };
  return {
    manifest: {
      ...base,
      checksum: { algorithm: 'sha256', value: await sha256Base64Url(canonicalJson(base)) },
    },
    chunks,
  };
}

export async function verifyChunkedBackup(input: unknown): Promise<ChunkedBackupBundle> {
  if (!input || typeof input !== 'object') throw new Error('chunked_backup_invalid');
  const bundle = input as ChunkedBackupBundle;
  const manifest = bundle.manifest;
  if (
    !manifest
    || manifest.schema !== CHUNKED_BACKUP_SCHEMA
    || manifest.schemaVersion !== CHUNKED_BACKUP_VERSION
    || manifest.checksum?.algorithm !== 'sha256'
    || !Array.isArray(manifest.chunks)
    || !Array.isArray(bundle.chunks)
  ) throw new Error('chunked_backup_schema_invalid');
  if (await sha256Base64Url(canonicalJson(unsignedManifest(manifest))) !== manifest.checksum.value) {
    throw new Error('chunked_backup_manifest_checksum_invalid');
  }
  if (manifest.chunks.length !== bundle.chunks.length) throw new Error('chunked_backup_chunk_count_invalid');
  const tables: DynamicBackup['tables'] = {};
  const seen = new Set<string>();
  for (let index = 0; index < bundle.chunks.length; index += 1) {
    const chunk = bundle.chunks[index];
    const expected = manifest.chunks[index];
    if (!chunk || !expected) throw new Error('chunked_backup_chunk_invalid');
    const { rows, ...actualDescriptor } = chunk;
    if (canonicalJson(actualDescriptor) !== canonicalJson(expected) || seen.has(chunk.id)) {
      throw new Error('chunked_backup_chunk_descriptor_invalid');
    }
    seen.add(chunk.id);
    if (!Array.isArray(rows) || rows.length !== chunk.rowCount || rows.length > MAX_CHUNK_ROWS) {
      throw new Error('chunked_backup_chunk_rows_invalid');
    }
    const payload = chunkPayload(chunk.table, chunk.sequence, rows);
    if (byteLength(payload) !== chunk.byteLength || chunk.byteLength > MAX_CHUNK_BYTES) {
      throw new Error('chunked_backup_chunk_size_invalid');
    }
    if (await sha256Base64Url(payload) !== chunk.checksum.value) {
      throw new Error('chunked_backup_chunk_checksum_invalid');
    }
    (tables[chunk.table] ??= []).push(...rows);
  }
  for (const table of Object.keys(manifest.counts)) tables[table] ??= [];
  for (const [table, count] of Object.entries(manifest.counts)) {
    if (tables[table]?.length !== count) throw new Error('chunked_backup_table_count_invalid');
  }
  const dynamic: DynamicBackup = {
    schema: manifest.sourceSchema,
    schemaVersion: manifest.sourceSchemaVersion,
    createdAt: manifest.createdAt,
    counts: manifest.counts,
    security: manifest.security,
    tables,
    checksum: { algorithm: 'sha256', value: '' },
  };
  const { checksum: _checksum, ...unsigned } = dynamic;
  dynamic.checksum.value = await sha256Base64Url(canonicalJson(unsigned));
  await verifyDynamicBackup(dynamic);
  return bundle;
}

export async function restoreChunkedBackup(
  db: D1DatabaseLike,
  input: unknown,
  options: { revokeSecurity?: boolean; now?: number } = {},
) {
  const bundle = await verifyChunkedBackup(input);
  const tables: DynamicBackup['tables'] = {};
  for (const table of Object.keys(bundle.manifest.counts)) tables[table] = [];
  for (const chunk of bundle.chunks) tables[chunk.table].push(...chunk.rows);
  const dynamic: DynamicBackup = {
    schema: bundle.manifest.sourceSchema,
    schemaVersion: bundle.manifest.sourceSchemaVersion,
    createdAt: bundle.manifest.createdAt,
    counts: bundle.manifest.counts,
    security: bundle.manifest.security,
    tables,
    checksum: { algorithm: 'sha256', value: '' },
  };
  const { checksum: _checksum, ...unsigned } = dynamic;
  dynamic.checksum.value = await sha256Base64Url(canonicalJson(unsigned));
  return await restoreDynamicBackup(db, dynamic, options);
}

export interface EncryptedChunkedBackup {
  schema: 'equinox.orbit.encrypted-chunked-backup.v1';
  algorithm: 'AES-GCM-256';
  keyId: string;
  iv: string;
  ciphertext: string;
  plaintextChecksum: string;
}

function decodeBase64Url(value: string): Uint8Array {
  return Uint8Array.from(
    atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)),
    (character) => character.charCodeAt(0),
  );
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export async function importBackupEncryptionKey(encoded: string): Promise<CryptoKey> {
  const raw = decodeBase64Url(encoded.trim());
  if (raw.byteLength !== 32) throw new Error('backup_encryption_key_invalid');
  return await crypto.subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptChunkedBackup(
  bundle: ChunkedBackupBundle,
  key: CryptoKey,
  keyId = 'v1',
): Promise<EncryptedChunkedBackup> {
  await verifyChunkedBackup(bundle);
  const plaintext = canonicalJson(bundle);
  const bytes = new TextEncoder().encode(plaintext);
  const iv = decodeBase64Url(randomBase64Url(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(bytes),
  ));
  return {
    schema: 'equinox.orbit.encrypted-chunked-backup.v1',
    algorithm: 'AES-GCM-256',
    keyId,
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(encrypted),
    plaintextChecksum: await sha256Base64Url(plaintext),
  };
}

export async function decryptChunkedBackup(
  envelope: EncryptedChunkedBackup,
  key: CryptoKey,
): Promise<ChunkedBackupBundle> {
  if (envelope.schema !== 'equinox.orbit.encrypted-chunked-backup.v1' || envelope.algorithm !== 'AES-GCM-256') {
    throw new Error('encrypted_backup_schema_invalid');
  }
  let plaintext: string;
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(decodeBase64Url(envelope.iv)) },
      key,
      toArrayBuffer(decodeBase64Url(envelope.ciphertext)),
    );
    plaintext = new TextDecoder().decode(decrypted);
  } catch {
    throw new Error('encrypted_backup_authentication_failed');
  }
  if (await sha256Base64Url(plaintext) !== envelope.plaintextChecksum) {
    throw new Error('encrypted_backup_plaintext_checksum_invalid');
  }
  return await verifyChunkedBackup(JSON.parse(plaintext));
}
