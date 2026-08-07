/**
 * Duyurunun insanlara gösterilen markup'ı. Tek kaynak: hem /duyurular
 * sayfası hem ana sayfadaki şerit buradan render eder.
 *
 * Gövde `micromark` ile çevriliyor — kayıt gövdeleriyle aynı yol. İkinci bir
 * markdown yolu açmıyoruz: iki yol iki farklı kaçış davranışı demektir ve
 * hangisinin ham HTML'i geçirdiğini kimse takip edemez.
 */
import { micromark } from 'micromark';
import type { PublicAnnouncementView } from '../server/repositories/public-repository';
import { escapeHtml } from './record-markup';
import { renderIcon } from './icons';

const dateFormatter = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Istanbul',
});

const SEVERITY_LABELS: Record<PublicAnnouncementView['severity'], string> = {
  info: 'Bilgi',
  warning: 'Uyarı',
  critical: 'Kritik',
};

function severityIcon(severity: PublicAnnouncementView['severity']): string {
  return renderIcon(severity === 'info' ? 'info' : 'alert', 16);
}

export function announcementAnchor(id: string): string {
  return `duyuru-${id}`;
}

export function renderAnnouncementCard(announcement: PublicAnnouncementView): string {
  const published = new Date(announcement.publishedAt);
  const expires = announcement.expiresAt === null ? null : new Date(announcement.expiresAt);
  return `<article class="announcement announcement-${announcement.severity}" id="${escapeHtml(announcementAnchor(announcement.id))}">
    <header class="announcement-head">
      <p class="announcement-severity">${severityIcon(announcement.severity)}<span>${SEVERITY_LABELS[announcement.severity]}</span></p>
      <h2 class="announcement-title">${escapeHtml(announcement.title)}</h2>
      <p class="announcement-meta"><time datetime="${published.toISOString()}">${escapeHtml(dateFormatter.format(published))}</time>${expires ? `<span aria-hidden="true">·</span><span>${escapeHtml(`${dateFormatter.format(expires)} tarihine kadar geçerli`)}</span>` : ''}</p>
    </header>
    <div class="announcement-body">${micromark(announcement.bodyMarkdown)}</div>
  </article>`;
}

export function renderAnnouncementList(announcements: PublicAnnouncementView[]): string {
  if (announcements.length === 0) {
    /* Boş hâl bir hata değil, sağlıklı hâl. Sayfayı boş bırakmak yerine
     * bunu söylüyoruz ki okuyan "yükleme mi başarısız oldu" diye düşünmesin. */
    return `<div class="announcement-empty"><p>Şu anda yürürlükte olan bir duyuru yok.</p></div>`;
  }
  return announcements.map((announcement) => renderAnnouncementCard(announcement)).join('');
}

/**
 * Ana sayfa şeridi. Gövdeyi taşımaz, yalnız başlığı ve düzeyi gösterip
 * sayfaya götürür — akışın üstü duyuru metni için doğru yer değil.
 *
 * Aktif duyuru yoksa BOŞ dizge döner. Şeridin "hiçbir şey yokken de duran bir
 * çerçeve" hâli yok; çoğu gün duyuru olmayacak ve boş bir kutu her ziyaretçiye
 * gösterilecek ölü mobilyadır.
 */
export function renderAnnouncementStrip(announcements: PublicAnnouncementView[]): string {
  if (announcements.length === 0) return '';
  const [lead, ...rest] = announcements;
  return `<aside class="announcement-strip announcement-${lead.severity}" aria-label="Orbit duyuruları">
    <a class="announcement-strip-lead" href="/duyurular#${escapeHtml(announcementAnchor(lead.id))}">
      <span class="announcement-strip-mark" aria-hidden="true">${severityIcon(lead.severity)}</span>
      <span class="announcement-strip-copy"><small>${SEVERITY_LABELS[lead.severity]} duyuru</small><strong>${escapeHtml(lead.title)}</strong></span>
      ${renderIcon('arrow-right', 16)}
    </a>
    ${rest.length > 0 ? `<a class="announcement-strip-more" href="/duyurular">${escapeHtml(`${rest.length} duyuru daha`)}</a>` : ''}
  </aside>`;
}
