/*
 * Panelin iki sayfasının ortak zemini.
 *
 * Platform araçları `/dashboard`'dan `/dashboard/platform`'a taşınınca bu
 * yardımcıların ikinci bir kopyası gerekti. Kopyalamak yerine tek yere
 * alındı: `csrf()` ve `request()` gibi şeylerin iki sürümü olması, birinin
 * bir gün sessizce eskimesi demekti.
 *
 * Etiket sözlükleri de burada. Panel bir dönem ham enum yazıyordu —
 * `daily · succeeded`, `info · all_agents · active` — yani Türkçe bir
 * yönetim ekranında veritabanı değerleri okunuyordu.
 */

export const byId = (id) => document.getElementById(id);

export function csrf() {
  return document.cookie
    .split('; ')
    .find((value) => value.startsWith('__Host-orbit_csrf='))
    ?.split('=')
    .slice(1)
    .join('=') ?? '';
}

export async function request(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined) {
    if (!options.raw && !(options.body instanceof FormData)) headers.set('content-type', 'application/json');
    headers.set('X-Orbit-CSRF', csrf());
  }
  const response = await fetch(path, { ...options, headers });
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `HTTP ${response.status}`);
    error.code = body?.error?.code;
    error.status = response.status;
    throw error;
  }
  return { body, response };
}

export const mutate = (path, method = 'POST', body = {}) => request(path, {
  method,
  body: JSON.stringify(body),
});

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

export function flash(text, kind = 'ok') {
  const element = byId('flash');
  element.textContent = text;
  element.className = `dashboard-notice ${kind}`;
  window.setTimeout(() => element.classList.add('hidden'), 5000);
}

export function actionButton(label, action, kind = 'secondary') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `dashboard-button ${kind}`;
  element.textContent = label;
  element.addEventListener('click', action);
  return element;
}

export function absoluteTime(value) {
  return new Date(value).toLocaleString('tr-TR');
}

/* Panelde tarih değil, tazelik önemli: "3 gün önce" bir şeyin durduğunu
   söyler, "11.08.2026" söylemez. Kesin tarih başlık olarak duruyor, yani
   bilgi kaybolmuyor — yalnız ikinci plana geçiyor. */
const RELATIVE_UNITS = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

export function relativeTime(value) {
  const elapsed = value - Date.now();
  const formatter = new Intl.RelativeTimeFormat('tr-TR', { numeric: 'auto' });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(elapsed) >= size) return formatter.format(Math.round(elapsed / size), unit);
  }
  return 'az önce';
}

/* Bilinmeyen bir değer ham hâliyle geçiyor. Sunucu bir gün yeni bir tür
   eklerse ekranda o türün adı görünür — sessizce yanlış bir Türkçe etiket
   göstermek, yeni türü hiç fark etmemek olurdu. */
const label = (dictionary) => (value) => dictionary[value] ?? String(value ?? '');

export const backupKindLabel = label({
  daily: 'Günlük', weekly: 'Haftalık', monthly: 'Aylık', manual: 'Elle',
});

export const backupStatusLabel = label({
  running: 'Sürüyor', succeeded: 'Başarılı', failed: 'Başarısız',
});

export const severityLabel = label({
  info: 'Bilgi', warning: 'Uyarı', critical: 'Kritik',
});

export const audienceLabel = label({
  all_agents: 'Tüm ajanlar', equinox_agents: 'Equinox ajanları', agent: 'Belirli ajan',
});

export const announcementStatusLabel = label({
  draft: 'Taslak', active: 'Yayında', expired: 'Süresi doldu', withdrawn: 'Geri çekildi',
});
