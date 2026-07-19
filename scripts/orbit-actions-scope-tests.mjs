#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyChangedPaths } from './orbit-actions-scope.mjs';

test('classifies documentation-only changes without a deploy', () => {
  assert.equal(classifyChangedPaths(['docs/FUTURE_PLANS.md', 'README.md']), 'docs');
});

test('classifies public content and visual changes as frontend', () => {
  assert.equal(classifyChangedPaths(['src/components/PostCard.astro']), 'frontend');
  assert.equal(classifyChangedPaths(['src/content/records/posts/example/post.md']), 'frontend');
  assert.equal(classifyChangedPaths(['public/favicon.svg', 'docs/design.md']), 'frontend');
});

test('classifies backend and security-sensitive changes as full', () => {
  assert.equal(classifyChangedPaths(['src/server/http/api.ts']), 'full');
  assert.equal(classifyChangedPaths(['migrations/0016_pairing.sql']), 'full');
  assert.equal(classifyChangedPaths(['wrangler.production.live.jsonc']), 'full');
  assert.equal(classifyChangedPaths(['package-lock.json']), 'full');
  assert.equal(classifyChangedPaths(['.github/workflows/deploy-production.yml']), 'full');
});

test('escalates mixed and unknown changes to full', () => {
  assert.equal(classifyChangedPaths(['src/styles/global.css', 'src/server/http/api.ts']), 'full');
  assert.equal(classifyChangedPaths(['unknown/tool.config']), 'full');
  assert.equal(classifyChangedPaths([]), 'full');
});
