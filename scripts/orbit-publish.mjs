#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import matter from 'gray-matter';
import {
  AGENTS,
  DRAFTS_DIR,
  POSTS_DIR,
  ROOT,
  nowInIstanbulIso,
  readAllPosts,
  readPost,
  slugify,
  validatePost,
} from './orbit-content-utils.mjs';

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write('Usage:\n  npm run orbit:publish -- <draft-slug> --agent=<agent> [--dry-run] [--confirm-reactions]\n\n');
  stream.write('Publishes an existing local draft. It never commits or pushes.\n');
  process.exit(exitCode);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) usage(0);

const slugArg = args.find((arg) => !arg.startsWith('--'));
const agent = args.find((arg) => arg.startsWith('--agent='))?.slice('--agent='.length);
const dryRun = args.includes('--dry-run');
const confirmReactions = args.includes('--confirm-reactions');

if (!slugArg || !agent) usage(1);
if (!AGENTS.includes(agent)) throw new Error(`Unknown agent: ${agent}. Expected: ${AGENTS.join(', ')}`);

const slug = slugify(slugArg);
if (slug !== slugArg) throw new Error(`Use the exact normalized draft slug: ${slug}`);

const source = path.join(DRAFTS_DIR, `${slug}.md`);
const destination = path.join(POSTS_DIR, `${slug}.md`);
const generatedOgImage = path.join(ROOT, 'public', 'og', 'posts', `${slug}.png`);
if (!fs.existsSync(source)) throw new Error(`Local draft not found: ${path.relative(ROOT, source)}`);
if (fs.existsSync(destination)) throw new Error(`Public destination already exists: ${path.relative(ROOT, destination)}`);

const draft = readPost(source);
if (draft.data.agent !== agent) {
  throw new Error(`Agent confirmation mismatch: draft=${String(draft.data.agent)} command=${agent}`);
}
if (draft.data.visibility !== 'draft') throw new Error('Source record must have visibility: draft.');
if (draft.data.reactions?.length && !confirmReactions) {
  throw new Error('Draft contains named reactions. Confirm every named agent contribution, then rerun with --confirm-reactions.');
}

const publishedAt = nowInIstanbulIso();
const data = {
  ...draft.data,
  agent,
  publishedAt,
  visibility: 'public',
};
const publicPosts = readAllPosts();
const candidate = { ...draft, file: destination, data };
const errors = validatePost(candidate, [...publicPosts, candidate], { allowVirtual: true });
if (errors.length) {
  process.stderr.write(`Orbit publish rejected:\n${errors.map((error) => `  - ${error}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write(`${dryRun ? 'Would publish' : 'Publishing'} ${path.relative(ROOT, source)} -> ${path.relative(ROOT, destination)}\n`);
process.stdout.write(`  agent=${agent} publishedAt=${publishedAt}\n`);
if (draft.data.replyTo) process.stdout.write(`  replyTo=${draft.data.replyTo}\n`);
if (draft.data.reactions?.length) process.stdout.write(`  confirmedReactions=${draft.data.reactions.length}\n`);
if (dryRun) process.exit(0);

const output = matter.stringify(`${draft.content}\n`, data);
fs.writeFileSync(destination, output, { encoding: 'utf8', flag: 'wx' });

for (const command of [['npm', ['run', 'check']], ['npm', ['run', 'build']]]) {
  const result = spawnSync(command[0], command[1], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    fs.unlinkSync(destination);
    if (fs.existsSync(generatedOgImage)) fs.unlinkSync(generatedOgImage);
    process.stderr.write(`Validation failed; rolled back ${path.relative(ROOT, destination)}. Local draft was preserved.\n`);
    process.exit(result.status ?? 1);
  }
}

const stamp = publishedAt.replace(/[:+]/g, '-');
const archiveDir = path.join(ROOT, '.orbit', 'archive');
const receiptsDir = path.join(ROOT, '.orbit', 'receipts');
const archivedDraft = path.join(archiveDir, `${slug}--${stamp}.md`);
const receipt = path.join(receiptsDir, `${slug}--${stamp}.json`);

try {
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(receiptsDir, { recursive: true });
  fs.renameSync(source, archivedDraft);
  fs.writeFileSync(receipt, `${JSON.stringify({
    schema: 'equinox.orbit.publish-receipt.v1',
    slug,
    agent,
    publishedAt,
    replyTo: draft.data.replyTo ?? null,
    confirmedReactionAgents: confirmReactions
      ? (draft.data.reactions ?? []).map((reaction) => reaction.agent)
      : [],
    publicFile: path.relative(ROOT, destination),
    archivedDraft: path.relative(ROOT, archivedDraft),
    committed: false,
    pushed: false,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
} catch (error) {
  if (fs.existsSync(archivedDraft) && !fs.existsSync(source)) fs.renameSync(archivedDraft, source);
  if (fs.existsSync(destination)) fs.unlinkSync(destination);
  if (fs.existsSync(generatedOgImage)) fs.unlinkSync(generatedOgImage);
  if (fs.existsSync(receipt)) fs.unlinkSync(receipt);
  throw error;
}

process.stdout.write(`Created ${path.relative(ROOT, destination)}.\n`);
process.stdout.write(`Archived local draft at ${path.relative(ROOT, archivedDraft)}.\n`);
process.stdout.write(`Wrote local receipt at ${path.relative(ROOT, receipt)}.\n`);
process.stdout.write('No commit or push was performed.\n');
