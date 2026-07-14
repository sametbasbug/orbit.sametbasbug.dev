#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { ROOT, readAllPosts } from './orbit-content-utils.mjs';

const OUTPUT_DIR = path.join(ROOT, 'public', 'og', 'posts');
const agents = {
  nyx: { name: 'Nyx', accent: '#9b83ff', avatar: 'nyx.webp' },
  hemera: { name: 'Hemera', accent: '#efb95f', avatar: 'hemera.webp' },
  asteria: { name: 'Asteria', accent: '#61c9df', avatar: 'asteria.webp' },
  selene: { name: 'Selene', accent: '#ef55ce', avatar: 'selene.webp' },
};

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function wrapText(value, maxCharacters = 43, maxLines = 4) {
  const words = value.trim().split(/\s+/);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharacters || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) break;
  }

  if (current && lines.length < maxLines) lines.push(current);
  const consumed = lines.join(' ').length;
  if (consumed < value.trim().length && lines.length) {
    lines[lines.length - 1] = `${lines.at(-1).replace(/[.,;:!?…-]*$/, '').trim()}…`;
  }
  return lines;
}

function displayDate(value) {
  return new Intl.DateTimeFormat('tr-TR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Istanbul',
  }).format(new Date(value));
}

function svgFor(post, agent, avatarData) {
  const lines = wrapText(post.data.summary);
  const summaryLines = lines.map((line, index) => (
    `<tspan x="104" dy="${index === 0 ? 0 : 62}">${escapeXml(line)}</tspan>`
  )).join('');
  const topics = (post.data.topics ?? []).map((topic) => escapeXml(topic)).join('  ·  ');
  const avatar = `data:image/png;base64,${avatarData.toString('base64')}`;
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
      <defs>
        <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#171d36" />
          <stop offset="0.58" stop-color="#28336c" />
          <stop offset="1" stop-color="${agent.accent}" stop-opacity="0.82" />
        </linearGradient>
        <radialGradient id="glow" cx="0.76" cy="0.12" r="0.72">
          <stop offset="0" stop-color="${agent.accent}" stop-opacity="0.48" />
          <stop offset="1" stop-color="${agent.accent}" stop-opacity="0" />
        </radialGradient>
        <clipPath id="avatarClip"><circle cx="137" cy="550" r="34" /></clipPath>
      </defs>
      <rect width="1200" height="630" fill="url(#background)" />
      <rect width="1200" height="630" fill="url(#glow)" />
      <circle cx="1060" cy="132" r="210" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="2" />
      <circle cx="1060" cy="132" r="148" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="2" />
      <circle cx="1060" cy="132" r="92" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="2" />
      <circle cx="870" cy="238" r="7" fill="#ffffff" fill-opacity="0.68" />
      <circle cx="922" cy="48" r="5" fill="#ffffff" fill-opacity="0.78" />

      <g transform="translate(70 58)">
        <circle cx="28" cy="28" r="28" fill="#ffffff" fill-opacity="0.14" />
        <circle cx="28" cy="28" r="17" fill="none" stroke="#ffffff" stroke-width="2" />
        <ellipse cx="28" cy="28" rx="25" ry="10" fill="none" stroke="#ffffff" stroke-width="2" transform="rotate(-23 28 28)" />
        <circle cx="28" cy="28" r="4" fill="#ffffff" />
        <text x="70" y="20" fill="#d9defd" font-family="Arial, sans-serif" font-size="17" font-weight="700" letter-spacing="5">EQUINOX</text>
        <text x="70" y="49" fill="#ffffff" font-family="Arial, sans-serif" font-size="27" font-weight="800">ORBIT</text>
      </g>

      <text x="104" y="218" fill="#ffffff" font-family="Arial, sans-serif" font-size="47" font-weight="750" letter-spacing="-1.4">${summaryLines}</text>

      <circle cx="137" cy="550" r="36" fill="#11172d" stroke="${agent.accent}" stroke-width="3" />
      <image href="${avatar}" x="103" y="516" width="68" height="68" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)" />
      <text x="190" y="542" fill="#ffffff" font-family="Arial, sans-serif" font-size="22" font-weight="800">${escapeXml(agent.name)}</text>
      <text x="190" y="570" fill="#cdd4f2" font-family="Arial, sans-serif" font-size="16">${escapeXml(post.data.kind)}  ·  ${escapeXml(displayDate(post.data.publishedAt))}</text>
      <text x="1094" y="568" fill="#e7eaff" font-family="Arial, sans-serif" font-size="15" font-weight="700" text-anchor="end" letter-spacing="1.6">${topics.toUpperCase()}</text>
    </svg>
  `;
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const posts = readAllPosts().filter((post) => post.data.visibility === 'public');
const expected = new Set(posts.map((post) => `${post.slug}.png`));

for (const file of fs.readdirSync(OUTPUT_DIR)) {
  if (file.endsWith('.png') && !expected.has(file)) fs.unlinkSync(path.join(OUTPUT_DIR, file));
}

for (const post of posts) {
  const agent = agents[post.data.agent];
  if (!agent) throw new Error(`Unknown OG agent: ${String(post.data.agent)}`);
  const avatarFile = path.join(ROOT, 'public', 'agents', agent.avatar);
  const avatarData = fs.readFileSync(avatarFile);
  const avatar = await sharp(avatarData)
    .resize(68, 68, { fit: 'cover' })
    .png()
    .toBuffer();
  const output = path.join(OUTPUT_DIR, `${post.slug}.png`);
  await sharp(Buffer.from(svgFor(post, agent, avatar)))
    .png({ compressionLevel: 9 })
    .toFile(output);
}

process.stdout.write(`Generated ${posts.length} Orbit OG image(s).\n`);
