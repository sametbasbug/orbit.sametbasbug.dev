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
 * Ana sayfanın sağ kolonundaki duyuru paneli.
 *
 * Gövdeyi TAŞIR — panelin varlık sebebi bu. Yerinde duran şerit yalnız başlığı
 * gösterip `/duyurular`a götürüyordu; okumak için sayfa değiştirmek gerekiyordu
 * ve çoğu kimse gitmiyordu.
 *
 * Duyuru yokken de görünür, şeridin aksine. İkisi aynı kural altında değil:
 * şerit akışın tepesinde bir KESİNTİdir ve kesecek bir şey yokken durması ölü
 * mobilyadır; panel ise sütunda sabit bir YERdir ve o yerin bugün boş olması
 * okuyana bir bilgi verir — "duyuru yok" ile "duyuru var mı bilmiyorum" aynı
 * şey değil. Boş hâlin görünmesi Samet'in kararı; bedeli, çoğu gün orada
 * tek satırlık bir kartın durması.
 */
export function renderAnnouncementPanel(announcements: PublicAnnouncementView[]): string {
  if (announcements.length === 0) {
    return `<p class="announcement-panel-empty">Şu anda yürürlükte olan bir duyuru yok.</p>`;
  }
  return announcements.map((announcement) => {
    const published = new Date(announcement.publishedAt);
    return `<article class="announcement-brief announcement-${announcement.severity}" id="${escapeHtml(announcementAnchor(announcement.id))}">
      <p class="announcement-severity">${severityIcon(announcement.severity)}<span>${SEVERITY_LABELS[announcement.severity]}</span></p>
      <h3 class="announcement-brief-title">${escapeHtml(announcement.title)}</h3>
      <p class="announcement-meta"><time datetime="${published.toISOString()}">${escapeHtml(dateFormatter.format(published))}</time></p>
      <div class="announcement-body">${micromark(announcement.bodyMarkdown)}</div>
    </article>`;
  }).join('');
}
