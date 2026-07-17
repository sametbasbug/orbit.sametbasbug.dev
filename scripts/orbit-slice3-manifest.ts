import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { v7 as uuidv7 } from 'uuid';
import { agents } from '../src/data/agents';
import { topics } from '../src/data/topics';

const ROOT = process.cwd();
export const MANIFEST_PATH = path.join(ROOT, 'src', 'data', 'import', 'orbit-v1.json');
const RECORDS_ROOT = path.join(ROOT, 'src', 'content', 'records');

export const CUTOVER = {
  gitCommit: '35ad75abbe0708b873e768b2d361f8b6a1d08182',
  utcTimestamp: '2026-07-15T04:02:00Z',
} as const;

export interface ManifestEntity {
  id: string;
  sourceKey: string;
  sourceDigest: string;
}

export interface AgentManifestEntity extends ManifestEntity {
  membershipId: string;
  handle: string;
}

export interface ProjectManifestEntity extends ManifestEntity {
  slug: string;
}

export interface TopicManifestEntity extends ManifestEntity {
  slug: string;
}

export interface RecordManifestEntity extends ManifestEntity {
  revisionId: string;
  revisionSourceKey: string;
  relativePath: string;
  slug: string;
  agentHandle: string;
  projectSlug: string | null;
  topicSlugs: string[];
  kind: 'post' | 'reply';
  parentSlug: string | null;
  rootSlug: string;
}

export interface OrbitImportManifest {
  schema: 'equinox.orbit.import-manifest.v1';
  version: 1;
  cutover: typeof CUTOVER;
  entities: {
    agents: AgentManifestEntity[];
    projects: ProjectManifestEntity[];
    topics: TopicManifestEntity[];
    records: RecordManifestEntity[];
  };
}

export interface LegacyRecordSource {
  relativePath: string;
  slug: string;
  kind: 'post' | 'reply';
  agentHandle: string;
  publishedAt: string;
  updatedAt: string | null;
  parentSlug: string | null;
  rootSlug: string;
  projectSlug: string | null;
  topicSlugs: string[];
  summary: string;
  body: string;
  metadata: Record<string, unknown>;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export async function readLegacySources(): Promise<{
  agents: typeof agents;
  projects: Array<Record<string, unknown> & { slug: string }>;
  topics: typeof topics;
  records: LegacyRecordSource[];
}> {
  const projects = JSON.parse(await readFile(path.join(ROOT, 'src', 'data', 'projects.json'), 'utf8')) as
    Array<Record<string, unknown> & { slug: string }>;
  const index = JSON.parse(await readFile(path.join(RECORDS_ROOT, 'index.json'), 'utf8')) as {
    records: Array<{
      relativePath?: string;
      path: string;
      slug: string;
      kind: 'post' | 'reply';
      agent: string;
      publishedAt: string;
      updatedAt: string | null;
      replyTo: string | null;
      postSlug: string;
      projectId: string | null;
      topics: string[];
      summary: string;
    }>;
  };

  const records: LegacyRecordSource[] = [];
  for (const item of index.records) {
    const relativePath = item.relativePath ?? item.path;
    const parsed = matter(await readFile(path.join(RECORDS_ROOT, relativePath), 'utf8'));
    const { agent: _agent, kind: _kind, publishedAt: _publishedAt, updatedAt: _updatedAt,
      replyTo: _replyTo, projectId: _projectId, topics: _topics, summary: _summary, ...metadata } = parsed.data;
    records.push({
      relativePath,
      slug: item.slug,
      kind: item.kind,
      agentHandle: item.agent,
      publishedAt: normalizeDate(item.publishedAt) ?? String(item.publishedAt),
      updatedAt: normalizeDate(item.updatedAt),
      parentSlug: item.replyTo,
      rootSlug: item.postSlug,
      projectSlug: item.projectId,
      topicSlugs: [...item.topics].sort(),
      summary: item.summary,
      body: parsed.content.trim(),
      metadata,
    });
  }
  records.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { agents, projects, topics, records };
}

export function recordSourceKey(record: LegacyRecordSource): string {
  return `record:${record.relativePath}|${record.slug}|${record.agentHandle}`;
}

export function revisionSourceKey(record: LegacyRecordSource): string {
  return `revision:${record.relativePath}|${record.slug}|${record.agentHandle}|1`;
}

export async function generateManifest(): Promise<OrbitImportManifest> {
  const source = await readLegacySources();
  return {
    schema: 'equinox.orbit.import-manifest.v1',
    version: 1,
    cutover: CUTOVER,
    entities: {
      agents: source.agents.map((agent) => ({
        id: uuidv7(),
        membershipId: uuidv7(),
        handle: agent.slug,
        sourceKey: `agent:${agent.slug}`,
        sourceDigest: digest(agent),
      })),
      projects: source.projects.map((project) => ({
        id: uuidv7(),
        slug: project.slug,
        sourceKey: `project:${project.slug}`,
        sourceDigest: digest(project),
      })),
      topics: source.topics.map((topic) => ({
        id: uuidv7(),
        slug: topic.slug,
        sourceKey: `topic:${topic.slug}`,
        sourceDigest: digest(topic),
      })),
      records: source.records.map((record) => ({
        id: uuidv7(),
        revisionId: uuidv7(),
        sourceKey: recordSourceKey(record),
        revisionSourceKey: revisionSourceKey(record),
        sourceDigest: digest(record),
        relativePath: record.relativePath,
        slug: record.slug,
        agentHandle: record.agentHandle,
        projectSlug: record.projectSlug,
        topicSlugs: record.topicSlugs,
        kind: record.kind,
        parentSlug: record.parentSlug,
        rootSlug: record.rootSlug,
      })),
    },
  };
}

export async function loadManifest(): Promise<OrbitImportManifest> {
  return JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as OrbitImportManifest;
}

export async function verifyManifest(manifest?: OrbitImportManifest): Promise<void> {
  manifest ??= await loadManifest();
  if (manifest.schema !== 'equinox.orbit.import-manifest.v1' || manifest.version !== 1) {
    throw new Error('unsupported_import_manifest');
  }
  if (manifest.cutover.gitCommit !== CUTOVER.gitCommit || manifest.cutover.utcTimestamp !== CUTOVER.utcTimestamp) {
    throw new Error('import_cutover_mismatch');
  }
  const source = await readLegacySources();
  const assertions: Array<[string, string, string]> = [];
  source.agents.forEach((agent) => assertions.push([
    `agent:${agent.slug}`,
    digest(agent),
    manifest.entities.agents.find((item) => item.handle === agent.slug)?.sourceDigest ?? 'missing',
  ]));
  source.projects.forEach((project) => assertions.push([
    `project:${project.slug}`,
    digest(project),
    manifest.entities.projects.find((item) => item.slug === project.slug)?.sourceDigest ?? 'missing',
  ]));
  source.topics.forEach((topic) => assertions.push([
    `topic:${topic.slug}`,
    digest(topic),
    manifest.entities.topics.find((item) => item.slug === topic.slug)?.sourceDigest ?? 'missing',
  ]));
  source.records.forEach((record) => assertions.push([
    recordSourceKey(record),
    digest(record),
    manifest.entities.records.find((item) => item.sourceKey === recordSourceKey(record))?.sourceDigest ?? 'missing',
  ]));
  for (const [key, current, expected] of assertions) {
    if (current !== expected) throw new Error(`legacy_import_conflict:${key}`);
  }
  if (manifest.entities.records.length !== source.records.length) {
    throw new Error('legacy_import_manifest_record_count_mismatch');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--generate')) {
    process.stdout.write(`${JSON.stringify(await generateManifest(), null, 2)}\n`);
  } else {
    await verifyManifest();
    process.stdout.write('Orbit V6 import manifest verified.\n');
  }
}
