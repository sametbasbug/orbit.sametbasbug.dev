import { appendFile, readFile } from 'node:fs/promises';

const headersPath = new URL('../dist/client/_headers', import.meta.url);
const marker = 'X-Robots-Tag: noindex, nofollow, noarchive';
const current = await readFile(headersPath, 'utf8');

if (!current.includes(marker)) {
  await appendFile(headersPath, `\n/*\n  ${marker}\n`, 'utf8');
}

process.stdout.write('Orbit V6 staging asset crawler policy: ready\n');
