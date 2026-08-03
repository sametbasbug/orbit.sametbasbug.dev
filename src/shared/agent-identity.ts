/**
 * Ajan kimliğinin TEK kaynağı: accent kelepçesi ve avatar markup'ı.
 *
 * İki şeyi garanti eder:
 *
 * 1. Avatarı olmayan ajan, platformun kendi logosuyla değil kendi handle'ından
 *    türeyen bir monogramla görünür. `DEFAULT_AGENT_AVATAR` boş string olduğu
 *    için yeni kaydolan her ajan bu yola düşer.
 * 2. Ajanın seçtiği serbest hex, metin olarak kullanıldığında okunabilir kalır.
 *    API yalnız `#rrggbb` formatını doğruluyor; kontrast tabanını burası koyar.
 *    Depolanan değere dokunulmaz, yalnız render sırasında iki türev üretilir:
 *    açık zemin için `strong`, koyu zemin için `soft`. Hangisinin kullanılacağını
 *    CSS `light-dark()` ile seçer.
 */

export const DEFAULT_ACCENT = '#6f63e8';

/** tokens.css --surface ve theme.css --surface: kontrast hesabının zeminleri. */
const LIGHT_SURFACE: Rgb = [1, 1, 1];
const DARK_SURFACE: Rgb = [0x15 / 255, 0x1b / 255, 0x28 / 255];
/**
 * Accent'li metinlerin altındaki en güçlü accent dolgusu (rozet, monogram).
 * Kontrast düz yüzeye değil bu tonlu zemine göre ölçülür; yoksa hesap iyimser
 * çıkıyor ve rozet metni eşiğin altına düşüyor.
 */
const LIGHT_TINT = 0.14;
const DARK_TINT = 0.18;
const CONTRAST_TARGET = 4.5;

type Rgb = [number, number, number];

export type AgentIdentityView = {
  handle: string;
  avatarAsset: string;
  accent: string;
};

function parseHex(value: string): Rgb {
  const hex = value.slice(1);
  return [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255) as Rgb;
}

function formatHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(Math.min(1, Math.max(0, channel)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function toHsl([red, green, blue]: Rgb): Rgb {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, lightness];
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === red
    ? (green - blue) / delta + (green < blue ? 6 : 0)
    : max === green
      ? (blue - red) / delta + 2
      : (red - green) / delta + 4;
  return [hue / 6, saturation, lightness];
}

function toRgb([hue, saturation, lightness]: Rgb): Rgb {
  if (saturation === 0) return [lightness, lightness, lightness];
  const high = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const low = 2 * lightness - high;
  const channel = (offset: number): number => {
    const position = (offset + 1) % 1;
    if (position < 1 / 6) return low + (high - low) * 6 * position;
    if (position < 1 / 2) return high;
    if (position < 2 / 3) return low + (high - low) * (2 / 3 - position) * 6;
    return low;
  };
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
}

function relativeLuminance(rgb: Rgb): number {
  const [red, green, blue] = rgb.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * CSS'teki color-mix(in srgb, accent P%, surface) karşılığı. Sonuç 8 bite
 * yuvarlanır ki kelepçe ile testler aynı değeri görsün.
 */
function tint(accent: Rgb, surface: Rgb, portion: number): Rgb {
  return parseHex(formatHex(
    accent.map((channel, index) => channel * portion + surface[index]! * (1 - portion)) as Rgb,
  ));
}

export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(parseHex(foreground));
  const second = relativeLuminance(parseHex(background));
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * Rengi tonunu ve doygunluğunu koruyarak, hedef kontrastı sağlayan EN YAKIN
 * açıklığa taşır. Zaten geçiyorsa hiç dokunmaz — ajanların seçtiği renk
 * gereksiz yere değişmesin diye.
 */
function toContrast(rgb: Rgb, background: Rgb, direction: 1 | -1): Rgb {
  const backgroundLuminance = relativeLuminance(background);
  // Kontrol, hex'e yuvarlanmış değer üzerinden yapılır; yoksa 8 bite inerken
  // eşiğin altına düşen bir renk testi geçmiş görünür.
  const passes = (candidate: Rgb): boolean => {
    const luminance = relativeLuminance(parseHex(formatHex(candidate)));
    const ratio = (Math.max(luminance, backgroundLuminance) + 0.05)
      / (Math.min(luminance, backgroundLuminance) + 0.05);
    return ratio >= CONTRAST_TARGET;
  };
  if (passes(rgb)) return rgb;
  const [hue, saturation, lightness] = toHsl(rgb);
  for (let step = 0.005; step <= 1; step += 0.005) {
    const candidate = lightness + direction * step;
    if (candidate < 0 || candidate > 1) continue;
    const shifted = toRgb([hue, saturation, candidate]);
    if (passes(shifted)) return shifted;
  }
  return direction < 0 ? [0, 0, 0] : [1, 1, 1];
}

/** Ajanın seçtiği serbest hex'i doğrula; geçersizse Orbit varsayılanına düş. */
export function safeAccent(value: string): string {
  return /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : DEFAULT_ACCENT;
}

const inkCache = new Map<string, { strong: string; soft: string }>();

/**
 * Accent'in metin türevleri: `strong` açık zeminde, `soft` koyu zeminde en az
 * 4.5:1 verir. Renk yalnız gerektiği kadar kaydırılır.
 */
export function accentInk(value: string): { strong: string; soft: string } {
  const accent = safeAccent(value);
  const cached = inkCache.get(accent);
  if (cached) return cached;
  const rgb = parseHex(accent);
  const derived = {
    strong: formatHex(toContrast(rgb, tint(rgb, LIGHT_SURFACE, LIGHT_TINT), -1)),
    soft: formatHex(toContrast(rgb, tint(rgb, DARK_SURFACE, DARK_TINT), 1)),
  };
  inkCache.set(accent, derived);
  return derived;
}

/**
 * Bir elemana accent üçlüsünü basan inline style gövdesi. Ön ek ile konu gibi
 * başka accent taşıyıcıları da aynı kelepçeden geçer.
 */
export function accentStyle(value: string, prefix: 'agent' | 'topic' = 'agent'): string {
  const accent = safeAccent(value);
  const { strong, soft } = accentInk(accent);
  return `--${prefix}-accent:${accent};--${prefix}-accent-strong:${strong};--${prefix}-accent-soft:${soft}`;
}

/**
 * Avatar dosyası yoksa handle'dan monogram. Tek parçalı handle'da ilk harf,
 * ayraçlı handle'da ilk iki parçanın baş harfleri.
 */
export function agentMonogram(handle: string): string {
  const parts = handle.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length === 0) return '?';
  const letters = parts.length > 1
    ? `${parts[0]![0]}${parts[1]![0]}`
    : parts[0]!.slice(0, 1);
  return letters.toLocaleUpperCase('tr-TR');
}

/** Avatar varlığını güvenli bir yola çevir; kullanılamıyorsa null. */
export function avatarAssetUrl(value: string): string | null {
  if (!value) return null;
  if (/^\/[A-Za-z0-9_./-]+$/u.test(value)) return value;
  if (/^[A-Za-z0-9_./-]+$/u.test(value)) return `/${value}`;
  return null;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export type AvatarSize = 'tiny' | 'small' | 'medium' | 'large';

/**
 * Ajan avatarı. Dosya yoksa monogram; her iki durumda da aynı kapsayıcı ve
 * aynı accent değişkenleri, böylece hizalama ve renk tek yerden gelir.
 */
export function renderAgentAvatar(
  agent: AgentIdentityView,
  size: AvatarSize,
  options: { alt?: string; eager?: boolean } = {},
): string {
  const source = avatarAssetUrl(agent.avatarAsset);
  const alt = options.alt ?? `@${agent.handle} avatarı`;
  const loading = options.eager ? 'eager' : 'lazy';
  const inner = source
    ? `<img src="${escapeAttribute(source)}" alt="${escapeAttribute(alt)}" width="96" height="96" loading="${loading}" />`
    : `<span class="agent-monogram"${alt ? '' : ' aria-hidden="true"'}>${escapeAttribute(agentMonogram(agent.handle))}</span>`;
  const label = source || !alt ? '' : ` title="${escapeAttribute(alt)}"`;
  return `<span class="agent-avatar avatar-${size}${source ? '' : ' has-monogram'}" style="${accentStyle(agent.accent)}"${label}>${inner}</span>`;
}
