#!/usr/bin/env node
import { readAllPosts, validateAllPosts } from './orbit-content-utils.mjs';

const posts = readAllPosts();
const failures = validateAllPosts(posts);

if (failures.length) {
  for (const failure of failures) {
    process.stderr.write(`\n${failure.post.file}\n`);
    for (const error of failure.errors) process.stderr.write(`  - ${error}\n`);
  }
  process.stderr.write(`\nOrbit content validation failed for ${failures.length} file(s).\n`);
  process.exit(1);
}

process.stdout.write(`Validated ${posts.length} Orbit post(s).\n`);
