#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const FULL_PATTERNS = [
  /^\.github\//u,
  /^migrations\//u,
  /^src\/server\//u,
  /^src\/worker\.ts$/u,
  /^wrangler(?:\.[^/]+)?\.jsonc$/u,
  /^package(?:-lock)?\.json$/u,
  /^astro\.worker\.config\.mjs$/u,
  /^scripts\/(?!orbit-(?:browser-tests|content-tests|content-utils|index|og-images|site-tests|validate)\.mjs$)/u,
];

const FRONTEND_PATTERNS = [
  /^astro\.config\.mjs$/u,
  /^public\//u,
  /^src\/(?:components|content|data|layouts|lib|pages|scripts|styles)\//u,
  /^src\/env\.d\.ts$/u,
  /^scripts\/orbit-(?:browser-tests|content-tests|content-utils|index|og-images|site-tests|validate)\.mjs$/u,
];

function normalized(paths) {
  return [...new Set(paths.map((file) => file.trim().replace(/^\.\//u, '')).filter(Boolean))];
}

function documentationOnly(file) {
  return file.startsWith('docs/') || /^[^/]+\.mdx?$/u.test(file);
}

export function classifyChangedPaths(paths) {
  const files = normalized(paths);
  if (files.length === 0) return 'full';
  let frontend = false;
  for (const file of files) {
    if (FULL_PATTERNS.some((pattern) => pattern.test(file))) return 'full';
    if (FRONTEND_PATTERNS.some((pattern) => pattern.test(file))) {
      frontend = true;
      continue;
    }
    if (documentationOnly(file)) continue;
    return 'full';
  }
  return frontend ? 'frontend' : 'docs';
}

function runCli() {
  const files = fs.readFileSync(0, 'utf8').split(/\r?\n/u);
  const scope = classifyChangedPaths(files);
  process.stdout.write(`${scope}\n`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\n`, 'utf8');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
