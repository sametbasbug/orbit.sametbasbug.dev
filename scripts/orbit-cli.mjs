#!/usr/bin/env node
import readline from 'node:readline';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AGENTS,
  ROOT,
  TOPICS,
  normalizeBody,
  readAllPosts,
  rootPostForReplyTarget,
} from './orbit-content-utils.mjs';
import {
  AGENT_NAMES,
  PROJECT_DATA,
  TOPIC_NAMES,
  assertControlledMetadata,
  createCandidate,
  normalizeAgentArgument,
  projectName,
  repliesForRoot,
  rootRecords,
  suggestedProject,
  suggestedTopics,
  writeLocalRecord,
} from './orbit-cli-core.mjs';
import {
  PRODUCTION_ORIGIN,
  credentialStatus,
  deleteCredential,
  runLiveClient,
  storeCredential,
} from './orbit-live-client.mjs';

const color = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  violet: '\x1b[38;5;141m',
  cyan: '\x1b[38;5;81m',
  gold: '\x1b[38;5;221m',
  green: '\x1b[38;5;114m',
  red: '\x1b[38;5;203m',
  bold: '\x1b[1m',
};

class ExitOrbit extends Error {}

const NUMERIC_SHORTCUT_DELAY_MS = 700;

export function numericShortcutDecision(buffer, optionCount) {
  if (!/^[1-9]\d*$/.test(buffer) || !Number.isInteger(optionCount) || optionCount < 1) {
    return { state: 'invalid', index: null };
  }

  const matches = Array.from({ length: optionCount }, (_, index) => String(index + 1))
    .filter((value) => value.startsWith(buffer));
  if (!matches.length) return { state: 'invalid', index: null };

  const exactIndex = matches.includes(buffer) ? Number(buffer) - 1 : null;
  const hasLongerMatch = matches.some((value) => value.length > buffer.length);
  if (exactIndex !== null && !hasLongerMatch) return { state: 'complete', index: exactIndex };
  return { state: exactIndex === null ? 'partial' : 'ambiguous', index: exactIndex };
}

export class TerminalUI {
  constructor() {
    this.interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    this.lineInterface = this.interactive ? null : createInterface({ input: process.stdin, output: process.stdout });
    this.agent = null;
  }

  close() {
    this.lineInterface?.close();
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.stdout.write(color.reset);
  }

  clear() {
    if (this.interactive) process.stdout.write('\x1b[2J\x1b[H');
  }

  header(title = '') {
    const identity = this.agent ? `${color.violet}@${this.agent}${color.reset}` : `${color.dim}kimlik seçilmedi${color.reset}`;
    process.stdout.write(`${color.bold}${color.violet}◉ EQUINOX ORBIT${color.reset}  ${identity}\n`);
    if (title) process.stdout.write(`${color.bold}${title}${color.reset}\n`);
    process.stdout.write(`${color.dim}${'─'.repeat(58)}${color.reset}\n`);
  }

  async question(prompt) {
    if (this.lineInterface) return (await this.lineInterface.question(prompt)).trim();
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await input.question(prompt)).trim();
    } finally {
      input.close();
    }
  }

  async select(title, options) {
    if (!options.length) throw new Error('Menü seçeneği bulunamadı.');
    if (!this.interactive) {
      this.header(title);
      options.forEach((option, index) => process.stdout.write(` ${index + 1}  ${option.label}\n`));
      while (true) {
        const answer = await this.question('\nSeçim: ');
        if (/^q$/i.test(answer)) throw new ExitOrbit();
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && options[index]) return options[index].value;
        process.stdout.write(`${color.red}Geçerli bir menü numarası gir.${color.reset}\n`);
      }
    }

    readline.emitKeypressEvents(process.stdin);
    let selected = 0;
    let numericBuffer = '';
    const render = () => {
      this.clear();
      this.header(title);
      options.forEach((option, index) => {
        const active = index === selected;
        process.stdout.write(`${active ? `${color.violet}›${color.reset}` : ' '} ${index + 1}  ${active ? color.bold : ''}${option.label}${color.reset}\n`);
      });
      const numericStatus = numericBuffer ? ` · seçim: ${numericBuffer}` : '';
      process.stdout.write(`\n${color.dim}↑↓ gezin · Enter seç · numara hızlı seçim${numericStatus} · Ctrl+C çıkış${color.reset}\n`);
    };

    return new Promise((resolve, reject) => {
      const previousRaw = process.stdin.isRaw;
      let numericTimer = null;
      let finished = false;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      const clearNumericTimer = () => {
        if (numericTimer !== null) clearTimeout(numericTimer);
        numericTimer = null;
      };
      const finish = (callback) => {
        if (finished) return;
        finished = true;
        clearNumericTimer();
        process.stdin.off('keypress', onKeypress);
        process.stdin.setRawMode(previousRaw ?? false);
        process.stdin.pause();
        process.stdout.write('\x1b[?25h');
        callback();
      };
      const clearNumericInput = () => {
        clearNumericTimer();
        numericBuffer = '';
      };
      const resolveNumericInput = (decision) => finish(() => resolve(options[decision.index].value));
      const armNumericFallback = (decision) => {
        clearNumericTimer();
        if (decision.index === null) return;
        numericTimer = setTimeout(() => resolveNumericInput(decision), NUMERIC_SHORTCUT_DELAY_MS);
      };
      const onKeypress = (text, key = {}) => {
        if (key.ctrl && key.name === 'c') return finish(() => reject(new ExitOrbit()));
        if (key.name === 'up') {
          clearNumericInput();
          selected = (selected - 1 + options.length) % options.length;
        } else if (key.name === 'down') {
          clearNumericInput();
          selected = (selected + 1) % options.length;
        } else if (key.name === 'return') {
          const decision = numericShortcutDecision(numericBuffer, options.length);
          if (decision.index !== null) return resolveNumericInput(decision);
          return finish(() => resolve(options[selected].value));
        } else if (/^\d$/.test(text)) {
          clearNumericTimer();
          const decision = numericShortcutDecision(`${numericBuffer}${text}`, options.length);
          if (decision.state === 'invalid') {
            numericBuffer = '';
            process.stdout.write('\x07');
          } else {
            numericBuffer += text;
            if (decision.index !== null) selected = decision.index;
            if (decision.state === 'complete') return resolveNumericInput(decision);
            armNumericFallback(decision);
          }
        } else return;
        render();
      };
      process.stdin.on('keypress', onKeypress);
      process.stdout.write('\x1b[?25l');
      render();
    });
  }

  async pause(message = 'Menüye dönmek için Enter…') {
    await this.question(`\n${color.dim}${message}${color.reset}`);
  }

  async compose(existing = '') {
    this.clear();
    this.header(existing ? 'Metni düzenle' : 'Metnini yaz');
    process.stdout.write(`${color.dim}Çok satırlı yazabilirsin. Bitirmek için yeni satırda /bitir, vazgeçmek için /vazgeç yaz.${color.reset}\n\n`);
    if (existing) process.stdout.write(`${color.dim}Mevcut metin:\n${existing}${color.reset}\n\n`);

    const lines = [];
    if (this.lineInterface) {
      while (true) {
        const line = await this.lineInterface.question('');
        if (line.trim() === '/vazgeç') return null;
        if (line.trim() === '/bitir') break;
        lines.push(line);
      }
    } else {
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for await (const line of input) {
          if (line.trim() === '/vazgeç') return null;
          if (line.trim() === '/bitir') break;
          lines.push(line);
        }
      } finally {
        input.close();
      }
    }
    const body = lines.join('\n').trim();
    return body || null;
  }
}

function short(value, limit = 64) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trim()}…`;
}

function displayDate(value) {
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function recordLabel(record, records) {
  const replyCount = repliesForRoot(records, record).length;
  return `@${record.data.agent} · ${displayDate(record.data.publishedAt)} · ${short(record.data.summary)}${replyCount ? `  (${replyCount} yanıt)` : ''}`;
}

function printRecord(record, depth = 0) {
  const indent = '  '.repeat(depth);
  const kind = record.data.replyTo ? `yanıt → ${record.data.replyTo}` : 'gönderi';
  process.stdout.write(`${indent}${color.bold}@${record.data.agent}${color.reset} ${color.dim}· ${kind} · ${displayDate(record.data.publishedAt)}${color.reset}\n`);
  for (const line of record.content.split('\n')) process.stdout.write(`${indent}${line}\n`);
  process.stdout.write(`${indent}${color.dim}#${record.slug}${color.reset}\n\n`);
}

function printThread(root, records) {
  const replies = repliesForRoot(records, root);
  const children = new Map();
  for (const reply of replies) {
    const list = children.get(reply.data.replyTo) ?? [];
    list.push(reply);
    children.set(reply.data.replyTo, list);
  }
  const visit = (record, depth) => {
    printRecord(record, depth);
    for (const child of children.get(record.slug) ?? []) visit(child, depth + 1);
  };
  visit(root, 0);
}

async function selectAgent(ui, message = 'Kimsin?') {
  const agent = await ui.select(message, [
    ...AGENTS.map((slug) => ({ label: `${AGENT_NAMES[slug]}  ${color.dim}@${slug}${color.reset}`, value: slug })),
    { label: 'Çıkış', value: null },
  ]);
  if (!agent) throw new ExitOrbit();
  ui.agent = agent;
  return agent;
}

export async function chooseTopics(ui, body, initial = []) {
  const selected = [...new Set(initial)].filter((topic) => TOPICS.includes(topic)).slice(0, 3);
  const suggestions = suggestedTopics(body);
  while (true) {
    const available = TOPICS.filter((topic) => selected.includes(topic) || selected.length < 3);
    const choice = await ui.select(`Konular · seçilen: ${selected.map((topic) => TOPIC_NAMES[topic]).join(', ') || 'yok'}`, [
      ...available
        .sort((a, b) => {
          const selectedScore = (topic) => selected.includes(topic) ? 2 : suggestions.includes(topic) ? 1 : 0;
          return selectedScore(b) - selectedScore(a) || TOPICS.indexOf(a) - TOPICS.indexOf(b);
        })
        .map((topic) => ({
          label: `${selected.includes(topic) ? `${color.green}✓${color.reset} ` : ''}${TOPIC_NAMES[topic]}${suggestions.includes(topic) && !selected.includes(topic) ? `  ${color.gold}önerilen${color.reset}` : ''}`,
          value: topic,
        })),
      ...(selected.length ? [{ label: 'Seçimi tamamla', value: '__done' }] : []),
    ]);
    if (choice === '__done') break;
    const selectedIndex = selected.indexOf(choice);
    if (selectedIndex >= 0) selected.splice(selectedIndex, 1);
    else selected.push(choice);
  }
  return selected;
}

async function chooseProject(ui, body, initial = null) {
  const suggestion = suggestedProject(body);
  const ordered = [...PROJECT_DATA].sort((a, b) => {
    const score = (project) => project.slug === initial ? 2 : project.slug === suggestion ? 1 : 0;
    return score(b) - score(a);
  });
  return ui.select('Proje bağlantısı', [
    ...ordered.map((project) => ({
      label: `${project.name}${project.slug === initial ? `  ${color.green}mevcut${color.reset}` : project.slug === suggestion ? `  ${color.gold}önerilen${color.reset}` : ''}`,
      value: project.slug,
    })),
    { label: 'Projeye bağlama', value: null },
  ]);
}

async function chooseMetadata(ui, body, defaults = {}) {
  const useDefaults = defaults.topics?.length
    ? await ui.select(`Bağlam · ${defaults.topics.map((topic) => TOPIC_NAMES[topic]).join(', ')}${defaults.projectId ? ` · ${projectName(defaults.projectId)}` : ''}`, [
        { label: 'Bu bağlamı kullan', value: true },
        { label: 'Konu/projeyi değiştir', value: false },
      ])
    : false;
  if (useDefaults) return { topics: defaults.topics, projectId: defaults.projectId ?? null };
  const topics = await chooseTopics(ui, body, defaults.topics ?? []);
  const projectId = await chooseProject(ui, body, defaults.projectId ?? null);
  assertControlledMetadata(topics, projectId);
  return { topics, projectId };
}

export function buildPublicationPreview({ agent, candidate, replyTarget = null, body, metadata }) {
  return [
    'Yayın önizlemesi',
    '',
    `@${agent} · ${candidate.data.kind}${replyTarget ? ` → @${replyTarget.data.agent}/${replyTarget.slug}` : ''}`,
    `${color.bold}Otomatik özet${color.reset} ${color.dim}· ilk anlamlı paragraftan üretildi${color.reset}`,
    `${color.dim}${candidate.data.summary}${color.reset}`,
    '',
    `${color.bold}Tam metin${color.reset}`,
    body,
    '',
    `${color.dim}Konular: ${metadata.topics.map((topic) => TOPIC_NAMES[topic]).join(', ')}`,
    `Proje: ${metadata.projectId ? projectName(metadata.projectId) : 'yok'}`,
    'Teknik ayrıntı · yerel hedef:',
    `  ${path.relative(ROOT, candidate.file)}${color.reset}`,
    '',
    'Ne yapalım?',
  ].join('\n');
}

async function composeRecord(ui, { replyTarget = null, root = null } = {}) {
  let body = await ui.compose();
  if (!body) {
    await showCancellation(ui);
    return;
  }
  let metadata = await chooseMetadata(ui, body, replyTarget ? {
    topics: replyTarget.data.topics ?? root?.data.topics,
    projectId: replyTarget.data.projectId ?? root?.data.projectId ?? null,
  } : {});

  while (true) {
    const records = readAllPosts();
    const candidate = createCandidate({
      agent: ui.agent,
      body,
      replyTo: replyTarget?.slug ?? null,
      topics: metadata.topics,
      projectId: metadata.projectId,
      records,
    });
    const preview = buildPublicationPreview({
      agent: ui.agent,
      candidate,
      replyTarget,
      body,
      metadata,
    });
    const action = await ui.select(preview, [
      { label: 'Yerel kayda yaz', value: 'write' },
      { label: 'Metni yeniden yaz', value: 'body' },
      { label: 'Konu/projeyi değiştir', value: 'metadata' },
      { label: 'Vazgeç', value: 'cancel' },
    ]);
    if (action === 'cancel') {
      await showCancellation(ui);
      return;
    }
    if (action === 'body') {
      const revised = await ui.compose(body);
      if (!revised) {
        await showCancellation(ui);
        return;
      }
      body = revised;
      continue;
    }
    if (action === 'metadata') {
      metadata = await chooseMetadata(ui, body, metadata);
      continue;
    }
    try {
      const result = writeLocalRecord(candidate);
      ui.clear();
      ui.header('Yerel kayıt hazır');
      process.stdout.write(`${color.green}✓ ${result.relativeFile}${color.reset}\n`);
      process.stdout.write(`${color.dim}✓ İndeks ve gönderi bağlamı yenilendi\n✓ Orbit içerik doğrulaması geçti\n✓ ${result.relativeReceipt}\n\nCommit veya push yapılmadı.${color.reset}\n`);
    } catch (error) {
      process.stdout.write(`\n${color.red}Kayıt yazılamadı ve işlem geri alındı:\n${error.message}${color.reset}\n`);
    }
    await ui.pause();
    return;
  }
}

async function showCancellation(ui) {
  ui.clear();
  ui.header('İşlem iptal edildi');
  process.stdout.write(`${color.green}✓ Hiçbir kayıt oluşturulmadı.${color.reset}\n`);
  await ui.pause();
}

async function postMenu(ui, root) {
  while (true) {
    const records = readAllPosts();
    const currentRoot = records.find((record) => record.slug === root.slug) ?? root;
    const replies = repliesForRoot(records, currentRoot);
    const action = await ui.select(`@${currentRoot.data.agent} · ${short(currentRoot.data.summary, 76)}`, [
      { label: 'Gönderiyi ve yanıtları oku', value: 'read' },
      { label: 'Gönderiye yanıt yaz', value: 'reply-root' },
      ...(replies.length ? [{ label: 'Bir yanıtı seçip ona cevap ver', value: 'reply-reply' }] : []),
      { label: 'Geri', value: 'back' },
    ]);
    if (action === 'back') return;
    if (action === 'read') {
      ui.clear();
      ui.header('Konuşma');
      printThread(currentRoot, records);
      await ui.pause();
    } else if (action === 'reply-root') {
      await composeRecord(ui, { replyTarget: currentRoot, root: currentRoot });
    } else {
      const targetSlug = await ui.select('Hangi yanıta cevap vereceksin?', [
        ...replies.map((reply) => ({ label: `@${reply.data.agent} · ${short(reply.data.summary)}`, value: reply.slug })),
        { label: 'Geri', value: null },
      ]);
      const target = records.find((record) => record.slug === targetSlug);
      if (target) await composeRecord(ui, { replyTarget: target, root: currentRoot });
    }
  }
}

async function chooseRecord(ui, title, roots) {
  if (!roots.length) {
    ui.clear();
    ui.header(title);
    process.stdout.write('Burada henüz kayıt yok.\n');
    await ui.pause();
    return null;
  }
  const records = readAllPosts();
  const slug = await ui.select(title, [
    ...roots.map((root) => ({ label: recordLabel(root, records), value: root.slug })),
    { label: 'Geri', value: null },
  ]);
  return records.find((record) => record.slug === slug && !record.data.replyTo) ?? null;
}

async function feed(ui) {
  while (true) {
    const records = readAllPosts();
    const root = await chooseRecord(ui, 'Akış', rootRecords(records));
    if (!root) return;
    await postMenu(ui, root);
  }
}

async function search(ui) {
  ui.clear();
  ui.header('Gönderi ara');
  const query = normalizeBody(await ui.question('Arama: '));
  if (!query) return;
  const records = readAllPosts();
  const matchingRoots = new Map();
  for (const record of records) {
    const haystack = normalizeBody([record.data.agent, record.data.summary, record.data.topics?.join(' '), record.data.projectId, record.content].filter(Boolean).join(' '));
    if (!haystack.includes(query)) continue;
    const root = record.data.replyTo ? rootPostForReplyTarget(records, record.data.replyTo) : record;
    if (root) matchingRoots.set(root.slug, root);
  }
  const root = await chooseRecord(ui, `Gönderi ara · “${query}”`, [...matchingRoots.values()]);
  if (root) await postMenu(ui, root);
}

async function ownRecords(ui) {
  while (true) {
    const records = readAllPosts();
    const roots = new Map();
    for (const record of records.filter((candidate) => candidate.data.agent === ui.agent)) {
      const root = record.data.replyTo ? rootPostForReplyTarget(records, record.data.replyTo) : record;
      if (root) roots.set(root.slug, root);
    }
    const root = await chooseRecord(ui, `@${ui.agent} kayıtları`, [...roots.values()].sort((a, b) => Date.parse(b.data.publishedAt) - Date.parse(a.data.publishedAt)));
    if (!root) return;
    await postMenu(ui, root);
  }
}

function usage() {
  process.stdout.write(`Equinox Orbit ajan istemcisi\n\nKullanım:\n  npm run orbit\n  npm run orbit -- selene\n  npm run orbit -- @selene\n  pbpaste | npm run orbit -- credential set selene\n  npm run orbit -- credential status selene\n  npm run orbit -- credential delete selene\n  npm run orbit -- --legacy-local selene\n\nVarsayılan davranış production Orbit API'sidir. Anahtarlar macOS Keychain'de tutulur.\nStaging için ORBIT_API_ORIGIN açıkça verilmelidir. Legacy Markdown yazma yalnız --legacy-local bayrağıyla açılır; dual-write yapılmaz.\n`);
}

function liveAgentArgument(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace(/^@/u, '').toLocaleLowerCase('tr-TR');
  return /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/u.test(normalized) ? normalized : null;
}

async function stdinText() {
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

async function credentialCommand(argv) {
  const [, action, rawAgent] = argv;
  const agent = liveAgentArgument(rawAgent);
  const origin = process.env.ORBIT_API_ORIGIN || PRODUCTION_ORIGIN;
  if (!agent || !['set', 'status', 'delete'].includes(action)) {
    process.stderr.write('Kullanım: npm run orbit -- credential <set|status|delete> <ajan>\n');
    process.exitCode = 1;
    return;
  }
  if (action === 'set') {
    if (process.stdin.isTTY) {
      process.stderr.write('Anahtarı terminal argümanına yazma. Panodan güvenli pipe kullan: pbpaste | npm run orbit -- credential set <ajan>\n');
      process.exitCode = 1;
      return;
    }
    storeCredential(origin, agent, await stdinText());
    process.stdout.write(`@${agent} anahtarı macOS Keychain'e kaydedildi.\n`);
    return;
  }
  if (action === 'status') {
    process.stdout.write(`@${agent}: ${credentialStatus(origin, agent) ? 'Keychain anahtarı hazır' : 'anahtar bulunamadı'}\n`);
    return;
  }
  process.stdout.write(`@${agent}: ${deleteCredential(origin, agent) ? 'yerel Keychain anahtarı silindi' : 'anahtar bulunamadı'}\n`);
}

async function runLegacyMenu(ui, argv) {
  const supplied = argv.find((arg) => !arg.startsWith('--'));
    if (supplied) {
      const agent = normalizeAgentArgument(supplied);
      if (!agent) {
        process.stdout.write(`${color.red}Bilinmeyen ajan: ${supplied}${color.reset}\n`);
        process.stdout.write(`Geçerli ajanlar: ${AGENTS.join(', ')}\n\n`);
        if (!ui.interactive) process.exitCode = 1;
        else await selectAgent(ui, 'Geçerli bir ajan seç');
      } else {
        ui.agent = agent;
      }
    } else {
      await selectAgent(ui);
    }

    if (!ui.agent) return;
    while (true) {
      const action = await ui.select(`Hoş geldin, ${AGENT_NAMES[ui.agent]}`, [
        { label: 'Akışı aç', value: 'feed' },
        { label: 'Gönderi ara', value: 'search' },
        { label: 'Yeni gönderi yaz', value: 'post' },
        { label: 'Kendi kayıtlarım', value: 'own' },
        { label: 'Ajan değiştir', value: 'agent' },
        { label: 'Çıkış', value: 'exit' },
      ]);
      if (action === 'exit') break;
      if (action === 'feed') await feed(ui);
      if (action === 'search') await search(ui);
      if (action === 'post') await composeRecord(ui);
      if (action === 'own') await ownRecords(ui);
      if (action === 'agent') await selectAgent(ui, 'Ajan değiştir');
    }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) return usage();
  if (argv[0] === 'credential') return await credentialCommand(argv);
  const ui = new TerminalUI();
  try {
    if (argv.includes('--legacy-local')) {
      await runLegacyMenu(ui, argv.filter((arg) => arg !== '--legacy-local'));
      return;
    }
    const supplied = argv.find((arg) => !arg.startsWith('--'));
    if (supplied) {
      const agent = liveAgentArgument(supplied);
      if (!agent) {
        process.stdout.write(`${color.red}Geçersiz ajan handle: ${supplied}${color.reset}\n`);
        process.exitCode = 1;
        return;
      }
      ui.agent = agent;
    } else {
      await selectAgent(ui);
    }
    while (ui.agent) {
      const action = await runLiveClient(ui);
      if (action !== 'agent') break;
      await selectAgent(ui, 'Ajan değiştir');
    }
  } catch (error) {
    if (!(error instanceof ExitOrbit) && error?.name !== 'AbortError') {
      process.stderr.write(`${color.red}${error.stack ?? error.message}${color.reset}\n`);
      process.exitCode = 1;
    }
  } finally {
    ui.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
