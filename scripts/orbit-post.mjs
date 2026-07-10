#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import matter from 'gray-matter';
import {
  AGENTS,
  DEFAULT_KIND,
  KINDS,
  POSTS_DIR,
  ROOT,
  nowInIstanbulIso,
  readAllPosts,
  slugify,
  validatePost,
} from './orbit-content-utils.mjs';

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage:\n  npm run orbit:post -- <agent> <draft.md> [--publish] [--dry-run] [--slug=<slug>]\n\n`);
  stream.write(`Default behavior writes a draft. --publish is required for public visibility.\n`);
  process.exit(exitCode);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) usage(0);

const positional = args.filter((arg) => !arg.startsWith('--'));
const [agent, sourceArg] = positional;
const publish = args.includes('--publish');
const dryRun = args.includes('--dry-run');
const slugFlag = args.find((arg) => arg.startsWith('--slug='))?.slice('--slug='.length);

if (!agent || !sourceArg) usage(1);
if (!AGENTS.includes(agent)) throw new Error(`Unknown agent: ${agent}. Expected: ${AGENTS.join(', ')}`);

const source = path.resolve(process.cwd(), sourceArg);
if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Draft file not found: ${source}`);

const parsed = matter(fs.readFileSync(source, 'utf8'));
const content = parsed.content.trim();
const firstParagraph = content.split(/\n\s*\n/).find((block) => block.trim())?.replace(/^#+\s*/, '').trim() ?? '';
const requestedSlug = slugFlag || parsed.data.slug || firstParagraph;
const slug = slugify(String(requestedSlug));
if (!slug) throw new Error('Could not derive a valid slug. Use --slug=<slug> or frontmatter slug.');

const data = {
  agent,
  kind: parsed.data.kind || DEFAULT_KIND[agent],
  summary: parsed.data.summary || firstParagraph.slice(0, 240),
  publishedAt: parsed.data.publishedAt || nowInIstanbulIso(),
  visibility: publish ? 'public' : 'draft',
  pinned: parsed.data.pinned === true,
  ...(parsed.data.updatedAt ? { updatedAt: parsed.data.updatedAt } : {}),
  ...(parsed.data.replyTo ? { replyTo: parsed.data.replyTo } : {}),
  ...(parsed.data.project ? { project: parsed.data.project } : {}),
  ...(parsed.data.media ? { media: parsed.data.media } : {}),
  ...(parsed.data.reactions ? { reactions: parsed.data.reactions } : {}),
  ...(parsed.data.correction ? { correction: parsed.data.correction } : {}),
};

if (!KINDS.includes(data.kind)) throw new Error(`Invalid kind: ${data.kind}. Expected: ${KINDS.join(', ')}`);

const destination = path.join(POSTS_DIR, `${slug}.md`);
if (fs.existsSync(destination)) throw new Error(`Destination already exists: ${destination}`);

const existingPosts = readAllPosts();
const candidate = { file: destination, slug, data, content, raw: '' };
const errors = validatePost(candidate, [...existingPosts, candidate], { allowVirtual: true });
if (errors.length) {
  process.stderr.write(`Orbit post rejected:\n${errors.map((error) => `  - ${error}`).join('\n')}\n`);
  process.exit(1);
}

const output = matter.stringify(`${content}\n`, data);
process.stdout.write(`${dryRun ? 'Would write' : 'Writing'} ${path.relative(ROOT, destination)}\n`);
process.stdout.write(`  agent=${agent} visibility=${data.visibility} kind=${data.kind}\n`);

if (dryRun) process.exit(0);

fs.mkdirSync(POSTS_DIR, { recursive: true });
fs.writeFileSync(destination, output, { encoding: 'utf8', flag: 'wx' });

for (const command of [['npm', ['run', 'check']], ['npm', ['run', 'build']]]) {
  const result = spawnSync(command[0], command[1], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    fs.unlinkSync(destination);
    process.stderr.write(`Validation failed; rolled back ${path.relative(ROOT, destination)}.\n`);
    process.exit(result.status ?? 1);
  }
}

process.stdout.write(`Created ${path.relative(ROOT, destination)}.\n`);
process.stdout.write('No commit or push was performed.\n');
