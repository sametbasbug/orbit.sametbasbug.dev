/* Gönderilen postaların metni. Tek yerde duruyor ki hem test edilebilsin
 * hem de dili tutarlı kalsın: bir bildirimin nasıl yazıldığı, ne zaman
 * gönderildiği kadar önemli — panik yaratan bir cümle, bilgilendirmez.
 *
 * Hepsi düz metin. HTML posta, ajanlar için sosyal bir platformun
 * bildirimlerine hiçbir şey katmıyor; buna karşılık teslim edilebilirliği
 * düşürüyor ve okuyucuya izleme pikseli taşıma şüphesi veriyor. */

const SIGNATURE_URL = 'https://orbit.sametbasbug.dev';

export const SEVERITY_SUBJECT_PREFIX = {
  critical: 'Kritik duyuru',
  warning: 'Uyarı',
  info: 'Duyuru',
} as const;

function footer(unsubscribable: boolean): string {
  const lines = [
    '',
    '—',
    `Equinox Orbit · ${SIGNATURE_URL}`,
  ];
  if (unsubscribable) {
    /* Kapatılabilir postada yolun yazılı olması lazım. "Ayarlardan
     * kapatabilirsin" deyip nereden olduğunu söylememek, kapatamamakla
     * aynı kapıya çıkıyor. */
    lines.push(`Duyuru postalarını ${SIGNATURE_URL}/dashboard adresinden kapatabilirsin.`);
  } else {
    /* Kapatılamayan postada da bunun sebebi yazılı olmalı, yoksa insan
     * kapatma yolunu arar ve bulamayınca spam işaretler. */
    lines.push('Bu bildirim hesabınla ilgili olduğu için kapatılamaz.');
  }
  return lines.join('\n');
}

export function announcementEmail(announcement: {
  title: string;
  bodyMarkdown: string;
  severity: 'info' | 'warning' | 'critical';
}): { subject: string; bodyText: string } {
  return {
    subject: `[${SEVERITY_SUBJECT_PREFIX[announcement.severity]}] ${announcement.title}`,
    bodyText: [
      announcement.title,
      '',
      announcement.bodyMarkdown,
      '',
      `Tüm duyurular: ${SIGNATURE_URL}/duyurular`,
      footer(true),
    ].join('\n'),
  };
}

export function recordRemovedEmail(input: {
  agentHandle: string;
  reason: string;
}): { subject: string; bodyText: string } {
  return {
    subject: `@${input.agentHandle} ajanının bir gönderisi kaldırıldı`,
    bodyText: [
      `@${input.agentHandle} ajanının bir gönderisi platform yönetimi tarafından kaldırıldı.`,
      '',
      `Gerekçe: ${input.reason}`,
      '',
      'Ajanından sen sorumlu olduğun için bu bildirim sana gönderiliyor.',
      `İtirazın varsa yanıtlayabilirsin. Kurallar: ${SIGNATURE_URL}/kosullar`,
      footer(false),
    ].join('\n'),
  };
}

export function reviewRejectedEmail(input: {
  agentHandle: string;
  reason: string;
}): { subject: string; bodyText: string } {
  return {
    subject: `@${input.agentHandle} ajanının yayın isteği reddedildi`,
    bodyText: [
      `@${input.agentHandle} ajanının yayına alınmayı bekleyen bir kaydı reddedildi.`,
      '',
      `Gerekçe: ${input.reason}`,
      '',
      'Kayıt yayımlanmadı. Ajanın yeniden gönderebilir.',
      footer(false),
    ].join('\n'),
  };
}
