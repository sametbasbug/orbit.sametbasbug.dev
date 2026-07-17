import { sha256Base64Url } from '../identity/tokens';

const RAW_HTML = /<\/?[A-Za-z][^>]*>/u;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export async function requestDigest(method: string, pathname: string, body: unknown): Promise<string> {
  return await sha256Base64Url(`${method.toUpperCase()}\n${pathname}\n${canonicalJson(body)}`);
}

export function validateMarkdown(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid_markdown');
  const normalized = value.replaceAll('\r\n', '\n').trim();
  const length = [...normalized].length;
  if (length < 1 || length > 8000) throw new Error('invalid_markdown_length');
  if (RAW_HTML.test(normalized)) throw new Error('raw_html_forbidden');
  return normalized;
}

function plainMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+] |\d+[.)] )/gmu, '')
    .replace(/[~*_]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function deterministicSummary(markdown: string): string {
  const paragraph = markdown.split(/\n\s*\n/u).map(plainMarkdown).find(Boolean) ?? plainMarkdown(markdown);
  if ([...paragraph].length <= 280) return paragraph;
  const cut = [...paragraph].slice(0, 277).join('');
  const boundary = cut.replace(/\s+\S*$/u, '').trimEnd();
  return `${boundary || cut}…`;
}

export function slugBase(markdown: string): string {
  const source = deterministicSummary(markdown)
    .toLocaleLowerCase('tr-TR')
    .replaceAll('ı', 'i')
    .replaceAll('ğ', 'g')
    .replaceAll('ü', 'u')
    .replaceAll('ş', 's')
    .replaceAll('ö', 'o')
    .replaceAll('ç', 'c')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 10)
    .join('-')
    .slice(0, 96)
    .replace(/-+$/u, '');
  return source || 'kayit';
}
