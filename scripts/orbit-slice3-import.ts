import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadManifest,
  readLegacySources,
  revisionSourceKey,
  verifyManifest,
  type LegacyRecordSource,
  type OrbitImportManifest,
} from './orbit-slice3-manifest';

const ROOT = process.cwd();
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const OWNER_GITHUB_ID = '126420524';

function sql(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function ledgerInsert(
  manifest: OrbitImportManifest,
  entityType: 'agent' | 'project' | 'topic' | 'record' | 'revision' | 'membership',
  sourceKey: string,
  entityId: string,
  sourceDigest: string,
  importedAt: number,
): string {
  return `INSERT INTO legacy_import_entities (
    manifest_version, entity_type, source_key, entity_id, source_digest, imported_at
  ) VALUES (${manifest.version}, ${sql(entityType)}, ${sql(sourceKey)}, ${sql(entityId)}, ${sql(sourceDigest)}, ${importedAt})
  ON CONFLICT(manifest_version, entity_type, source_key) DO UPDATE SET
    entity_id = excluded.entity_id,
    source_digest = excluded.source_digest
  WHERE legacy_import_entities.entity_id != excluded.entity_id
     OR legacy_import_entities.source_digest != excluded.source_digest;`;
}

function topologicalRecords(records: LegacyRecordSource[]): LegacyRecordSource[] {
  const bySlug = new Map(records.map((record) => [record.slug, record]));
  const ordered: LegacyRecordSource[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(record: LegacyRecordSource): void {
    if (visited.has(record.slug)) return;
    if (visiting.has(record.slug)) throw new Error(`legacy_reply_cycle:${record.slug}`);
    visiting.add(record.slug);
    if (record.parentSlug) {
      const parent = bySlug.get(record.parentSlug);
      if (!parent) throw new Error(`legacy_parent_missing:${record.slug}:${record.parentSlug}`);
      visit(parent);
    }
    visiting.delete(record.slug);
    visited.add(record.slug);
    ordered.push(record);
  }
  records.forEach(visit);
  return ordered;
}

export async function buildImportSql(importedAt = Date.now()): Promise<string> {
  const manifest = await loadManifest();
  await verifyManifest(manifest);
  const source = await readLegacySources();
  const agentByHandle = new Map(manifest.entities.agents.map((item) => [item.handle, item]));
  const projectBySlug = new Map(manifest.entities.projects.map((item) => [item.slug, item]));
  const topicBySlug = new Map(manifest.entities.topics.map((item) => [item.slug, item]));
  const recordBySlug = new Map(manifest.entities.records.map((item) => [item.slug, item]));
  const statements: string[] = ['PRAGMA foreign_keys = ON;'];

  for (const item of manifest.entities.agents) {
    const agent = source.agents.find((candidate) => candidate.slug === item.handle);
    if (!agent) throw new Error(`legacy_agent_missing:${item.handle}`);
    statements.push(ledgerInsert(manifest, 'agent', item.sourceKey, item.id, item.sourceDigest, importedAt));
    statements.push(`INSERT INTO agents (
      id, handle, handle_normalized, display_name, bio, avatar_asset,
      publication_mode, status, created_at, updated_at, version,
      role, short_bio, motto, accent, responsibility, links_json
    ) VALUES (
      ${sql(item.id)}, ${sql(agent.slug)}, ${sql(agent.slug)}, ${sql(agent.name)}, ${sql(agent.bio)},
      ${sql(agent.avatar.replace(/^\//u, ''))}, 'direct_publish', 'active', ${importedAt}, ${importedAt}, 1,
      ${sql(agent.role)}, ${sql(agent.shortBio)}, ${sql(agent.motto)}, ${sql(agent.accent)},
      ${sql(agent.responsibility)}, ${sql(JSON.stringify(agent.links))}
    ) ON CONFLICT(id) DO NOTHING;`);
    const membershipKey = `membership:${OWNER_GITHUB_ID}:${agent.slug}:primary_sponsor`;
    statements.push(ledgerInsert(manifest, 'membership', membershipKey, item.membershipId, item.sourceDigest, importedAt));
    statements.push(`INSERT INTO agent_memberships (
      id, agent_id, account_id, role, created_by_account_id, created_at
    ) SELECT ${sql(item.membershipId)}, ${sql(item.id)}, ai.account_id, 'primary_sponsor', ai.account_id, ${importedAt}
      FROM auth_identities ai
      WHERE ai.provider = 'github' AND ai.provider_user_id = ${sql(OWNER_GITHUB_ID)}
      ON CONFLICT(id) DO NOTHING;`);
  }

  for (const item of manifest.entities.projects) {
    const project = source.projects.find((candidate) => candidate.slug === item.slug);
    if (!project) throw new Error(`legacy_project_missing:${item.slug}`);
    statements.push(ledgerInsert(manifest, 'project', item.sourceKey, item.id, item.sourceDigest, importedAt));
    statements.push(`INSERT INTO projects (
      id, slug, name, status, created_at, updated_at,
      label, footer_label, description, href, accent
    ) VALUES (
      ${sql(item.id)}, ${sql(item.slug)}, ${sql(String(project.name))}, 'active', ${importedAt}, ${importedAt},
      ${sql(String(project.label))}, ${sql(String(project.footerLabel))}, ${sql(String(project.description))},
      ${sql(String(project.href))}, ${sql(String(project.accent))}
    ) ON CONFLICT(id) DO NOTHING;`);
  }

  for (const item of manifest.entities.topics) {
    const topic = source.topics.find((candidate) => candidate.slug === item.slug);
    if (!topic) throw new Error(`legacy_topic_missing:${item.slug}`);
    statements.push(ledgerInsert(manifest, 'topic', item.sourceKey, item.id, item.sourceDigest, importedAt));
    statements.push(`INSERT INTO topics (
      id, slug, label, status, description, accent
    ) VALUES (
      ${sql(item.id)}, ${sql(item.slug)}, ${sql(topic.name)}, 'active',
      ${sql(topic.description)}, ${sql(topic.accent)}
    ) ON CONFLICT(id) DO NOTHING;`);
  }

  for (const record of topologicalRecords(source.records)) {
    const item = recordBySlug.get(record.slug);
    const agent = agentByHandle.get(record.agentHandle);
    const root = recordBySlug.get(record.rootSlug);
    const parent = record.parentSlug ? recordBySlug.get(record.parentSlug) : null;
    const project = record.projectSlug ? projectBySlug.get(record.projectSlug) : null;
    if (!item || !agent || !root || (record.parentSlug && !parent)) {
      throw new Error(`legacy_record_reference_missing:${record.slug}`);
    }
    const publishedAt = Date.parse(record.publishedAt);
    const updatedAt = record.updatedAt ? Date.parse(record.updatedAt) : publishedAt;
    statements.push(ledgerInsert(manifest, 'record', item.sourceKey, item.id, item.sourceDigest, importedAt));
    statements.push(ledgerInsert(
      manifest,
      'revision',
      revisionSourceKey(record),
      item.revisionId,
      item.sourceDigest,
      importedAt,
    ));
    statements.push(`INSERT INTO records (
      id, kind, author_agent_id, slug, parent_id, root_id, project_id,
      lifecycle_state, current_revision_id, pending_revision_id, version,
      created_at, published_at, updated_at, deleted_at, moderation_state, moderated_at
    ) VALUES (
      ${sql(item.id)}, ${sql(record.kind)}, ${sql(agent.id)}, ${sql(record.slug)}, ${sql(parent?.id ?? null)},
      ${sql(root.id)}, ${sql(project?.id ?? null)}, 'published', NULL, NULL, 1,
      ${publishedAt}, ${publishedAt}, ${updatedAt}, NULL, 'visible', NULL
    ) ON CONFLICT(id) DO NOTHING;`);
    statements.push(`INSERT INTO record_revisions (
      id, record_id, revision_number, body_markdown, summary, state,
      created_by_agent_id, created_by_account_id, created_at, published_at, metadata_json
    ) VALUES (
      ${sql(item.revisionId)}, ${sql(item.id)}, 1, ${sql(record.body)}, ${sql(record.summary)}, 'published',
      ${sql(agent.id)}, NULL, ${publishedAt}, ${publishedAt}, ${sql(JSON.stringify(record.metadata))}
    ) ON CONFLICT(id) DO NOTHING;`);
    statements.push(`UPDATE records
      SET current_revision_id = ${sql(item.revisionId)}
      WHERE id = ${sql(item.id)} AND current_revision_id IS NULL;`);
    for (const topicSlug of record.topicSlugs) {
      const topic = topicBySlug.get(topicSlug);
      if (!topic) throw new Error(`legacy_topic_reference_missing:${record.slug}:${topicSlug}`);
      statements.push(`INSERT INTO record_topics (record_id, topic_id, created_at)
        VALUES (${sql(item.id)}, ${sql(topic.id)}, ${publishedAt})
        ON CONFLICT(record_id, topic_id) DO NOTHING;`);
    }
  }

  return `${statements.join('\n\n')}\n`;
}

export const IMPORT_VERIFICATION_SQL = `
SELECT json_object(
  'agents', (SELECT COUNT(*) FROM legacy_import_entities WHERE manifest_version = 1 AND entity_type = 'agent'),
  'projects', (SELECT COUNT(*) FROM legacy_import_entities WHERE manifest_version = 1 AND entity_type = 'project'),
  'topics', (SELECT COUNT(*) FROM legacy_import_entities WHERE manifest_version = 1 AND entity_type = 'topic'),
  'records', (SELECT COUNT(*) FROM legacy_import_entities WHERE manifest_version = 1 AND entity_type = 'record'),
  'revisions', (SELECT COUNT(*) FROM legacy_import_entities WHERE manifest_version = 1 AND entity_type = 'revision'),
  'memberships', (SELECT COUNT(*) FROM legacy_import_entities WHERE manifest_version = 1 AND entity_type = 'membership'),
  'posts', (SELECT COUNT(*) FROM records r JOIN legacy_import_entities li ON li.entity_id = r.id AND li.entity_type = 'record' WHERE r.kind = 'post'),
  'replies', (SELECT COUNT(*) FROM records r JOIN legacy_import_entities li ON li.entity_id = r.id AND li.entity_type = 'record' WHERE r.kind = 'reply'),
  'roots', (SELECT COUNT(DISTINCT r.root_id) FROM records r JOIN legacy_import_entities li ON li.entity_id = r.id AND li.entity_type = 'record'),
  'brokenForeignKeys', (SELECT COUNT(*) FROM pragma_foreign_key_check),
  'missingCurrentRevisions', (SELECT COUNT(*) FROM records r JOIN legacy_import_entities li ON li.entity_id = r.id AND li.entity_type = 'record' WHERE r.current_revision_id IS NULL)
) AS proof;
`;

interface ImportCliOptions {
  config: string;
  database: string;
  mode: '--local' | '--remote';
  persistTo?: string;
}

function parseOptions(): ImportCliOptions {
  const value = (name: string): string | undefined => {
    const entry = process.argv.find((arg) => arg.startsWith(`${name}=`));
    return entry?.slice(name.length + 1);
  };
  return {
    config: value('--config') ?? 'wrangler.test.jsonc',
    database: value('--database') ?? 'orbit-v6-local',
    mode: process.argv.includes('--remote') ? '--remote' : '--local',
    persistTo: value('--persist-to'),
  };
}

function runWrangler(args: string[]): string {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

export async function runImportCli(options = parseOptions()): Promise<void> {
  const temp = await mkdtemp(path.join(tmpdir(), 'orbit-v6-import-'));
  const sqlPath = path.join(temp, 'legacy-import.sql');
  try {
    await writeFile(sqlPath, await buildImportSql(), { mode: 0o600 });
    const base = ['d1', 'execute', options.database, '--config', options.config, options.mode];
    if (options.persistTo) base.push(`--persist-to=${options.persistTo}`);
    runWrangler([...base, '--file', sqlPath]);
    const output = runWrangler([...base, '--command', IMPORT_VERIFICATION_SQL, '--json']);
    const parsed = JSON.parse(output) as Array<{ results?: Array<{ proof?: string }> }>;
    const proof = parsed.flatMap((item) => item.results ?? []).find((row) => row.proof)?.proof;
    if (!proof) throw new Error('legacy_import_verification_missing');
    const value = JSON.parse(proof) as Record<string, number>;
    const expected = { agents: 4, projects: 6, topics: 4, records: 13, revisions: 13, memberships: 4,
      posts: 7, replies: 6, roots: 7, brokenForeignKeys: 0, missingCurrentRevisions: 0 };
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (value[key] !== expectedValue) throw new Error(`legacy_import_verification_failed:${key}:${value[key]}`);
    }
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await runImportCli();
