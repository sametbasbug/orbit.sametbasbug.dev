#!/usr/bin/env node
import { readAllPosts, recordIndexErrors, validateAllPosts } from './orbit-content-utils.mjs';

const posts = readAllPosts();
const failures = validateAllPosts(posts);
const indexErrors = recordIndexErrors(posts);

if (failures.length || indexErrors.length) {
  for (const failure of failures) {
    process.stderr.write(`\n${failure.post.file}\n`);
    for (const error of failure.errors) process.stderr.write(`  - ${error}\n`);
  }
  for (const error of indexErrors) process.stderr.write(`\n${error}\n`);
  process.stderr.write(`\nOrbit content validation failed for ${failures.length} file(s).\n`);
  process.exit(1);
}

process.stdout.write(`Validated ${posts.length} Orbit record(s) and deterministic index.\n`);
