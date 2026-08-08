import type { D1DatabaseLike, D1RunResultLike } from './d1/d1-foundation-repository';

export type EmailKind = 'announcement' | 'moderation' | 'security';

export interface PendingEmail {
  id: string;
  recipient: string;
  kind: EmailKind;
  subject: string;
  bodyText: string;
  attempts: number;
}

export interface QueuedEmail {
  id: string;
  accountId: string;
  recipient: string;
  kind: EmailKind;
  subject: string;
  bodyText: string;
  /* Aynı olayın aynı kişiye iki kez yazılmasını engelleyen anahtar.
   * Duyuruda duyurunun kimliği, moderasyonda kaldırılan kaydın kimliği. */
  subjectRef: string;
}

/* Geçici hatada kaç kez denenecek. Beş dakikada bir çalışan bir işleyici
 * için beş deneme yaklaşık yirmi dakikalık bir pencere demek; Resend'in
 * kısa bir arızasını atlatmaya yeter, kalıcı bir sorunu ise sonsuza kadar
 * kovalamaz. */
export const EMAIL_MAX_ATTEMPTS = 5;

/* Bir turda kaç posta gönderilecek. Worker'ın alt-istek bütçesi sınırlı ve
 * her posta bir istek; kalanlar sıradaki turda gider. Kuyruğun varlık
 * sebebi zaten bu — hiçbir tur her şeyi göndermek zorunda değil. */
export const EMAIL_DRAIN_BATCH = 20;

export class D1NotificationRepository {
  readonly #db: D1DatabaseLike;

  constructor(db: D1DatabaseLike) {
    this.#db = db;
  }

  /* Duyuru alıcıları: adresi olan, aktif ve duyuru postalarını kapatmamış
   * hesaplar. Süzgeç SQL'de duruyor — uygulama katmanında unutulan bir
   * filtre, tercihini kapatmış birine posta göndermek demek.
   *
   * Adres koşulu İKİ yerde birden korunuyor ve ikisi de kalmalı:
   * buradaki `IS NOT NULL` ile `recipient` sütunundaki NOT NULL. İkincisi
   * `INSERT OR IGNORE` sayesinde adresi olmayan satırı sessizce düşürüyor.
   * Ölçerek gördüm: buradaki koşulu kaldırdığımda test yine geçiyor,
   * çünkü kısıt yakalıyor. Yine de duruyor — sorgunun kimi seçtiği
   * okunduğunda anlaşılmalı, bir şema kısıtına yaslanarak gizlenmemeli. */
  announcementRecipientsStatement(
    announcementId: string,
    subject: string,
    bodyText: string,
    now: number,
    idPrefix: string,
  ) {
    return this.#db.prepare(`
      INSERT OR IGNORE INTO email_deliveries (
        id, account_id, recipient, kind, subject, body_text,
        status, attempts, created_at, subject_ref
      )
      SELECT
        ? || '-' || a.id,
        a.id,
        i.provider_email_snapshot,
        'announcement',
        ?, ?, 'pending', 0, ?, ?
      FROM accounts a
      JOIN auth_identities i ON i.account_id = a.id
      WHERE a.status = 'active'
        AND a.announcement_emails_enabled = 1
        AND i.provider_email_snapshot IS NOT NULL
    `).bind(idPrefix, subject, bodyText, now, `announcement:${announcementId}`);
  }

  /* Tek kişiye yazılan bildirim. Tercihe bakmıyor: bu tür postalar
   * kapatılamaz ve tabloya da öyle giriyor. */
  async enqueue(email: QueuedEmail, now: number): Promise<void> {
    await this.#db.prepare(`
      INSERT OR IGNORE INTO email_deliveries (
        id, account_id, recipient, kind, subject, body_text,
        status, attempts, created_at, subject_ref
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).bind(
      email.id, email.accountId, email.recipient, email.kind,
      email.subject, email.bodyText, now, email.subjectRef,
    ).run();
  }

  /* Bir hesabın bildirim adresi. Yoksa null döner ve çağıran sessizce
   * vazgeçer: adresi olmayan birine posta kuyruğa almak, hiç
   * boşaltılmayacak bir satır yazmak olurdu. */
  async recipientFor(accountId: string): Promise<string | null> {
    const row = await this.#db.prepare(`
      SELECT provider_email_snapshot AS email FROM auth_identities
      WHERE account_id = ? AND provider_email_snapshot IS NOT NULL
      LIMIT 1
    `).bind(accountId).first<{ email: string }>();
    return row?.email ?? null;
  }

  /* Bir ajanın sorumlusu ve ona nasıl ulaşılacağı. Ajanın kendisine posta
   * göndermiyoruz — ajanın kutusu yok; sorumluluk insanda, bildirim de
   * insana gidiyor. Adresi olmayan sponsorda null döner ve çağıran
   * sessizce vazgeçer. */
  async sponsorForAgent(agentId: string): Promise<{
    accountId: string;
    agentHandle: string;
    email: string;
  } | null> {
    const row = await this.#db.prepare(`
      SELECT m.account_id, ag.handle, i.provider_email_snapshot AS email
      FROM agent_memberships m
      JOIN agents ag ON ag.id = m.agent_id
      JOIN auth_identities i ON i.account_id = m.account_id
      WHERE m.agent_id = ?
        AND m.role = 'primary_sponsor'
        AND m.revoked_at IS NULL
        AND i.provider_email_snapshot IS NOT NULL
      LIMIT 1
    `).bind(agentId).first<{ account_id: string; handle: string; email: string }>();
    return row ? { accountId: row.account_id, agentHandle: row.handle, email: row.email } : null;
  }

  async listPending(limit: number): Promise<PendingEmail[]> {
    const result = await this.#db.prepare(`
      SELECT id, recipient, kind, subject, body_text, attempts
      FROM email_deliveries
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `).bind(limit).all<{
      id: string; recipient: string; kind: EmailKind;
      subject: string; body_text: string; attempts: number;
    }>();
    return (result.results ?? []).map((row) => ({
      id: row.id,
      recipient: row.recipient,
      kind: row.kind,
      subject: row.subject,
      bodyText: row.body_text,
      attempts: row.attempts,
    }));
  }

  async markSent(id: string, now: number): Promise<void> {
    await this.#db.prepare(`
      UPDATE email_deliveries
      SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL
      WHERE id = ? AND status = 'pending'
    `).bind(now, id).run();
  }

  /* Kalıcı hatada satır 'failed' olur ve bir daha denenmez. Geçici hatada
   * deneme sayısı artar; tavana ulaşınca yine 'failed'. Sonsuza kadar
   * bekleyen bir satır, kuyruğu her turda meşgul eder ve gerçekten
   * gönderilebilecek postaları geciktirir. */
  async markAttemptFailed(id: string, error: string, permanent: boolean): Promise<void> {
    await this.#db.prepare(`
      UPDATE email_deliveries
      SET attempts = attempts + 1,
          last_error = ?,
          status = CASE
            WHEN ? = 1 THEN 'failed'
            WHEN attempts + 1 >= ? THEN 'failed'
            ELSE 'pending'
          END
      WHERE id = ? AND status = 'pending'
    `).bind(error.slice(0, 300), permanent ? 1 : 0, EMAIL_MAX_ATTEMPTS, id).run();
  }

  async setAnnouncementEmailsEnabled(accountId: string, enabled: boolean): Promise<void> {
    await this.#db.prepare(`
      UPDATE accounts SET announcement_emails_enabled = ? WHERE id = ?
    `).bind(enabled ? 1 : 0, accountId).run();
  }

  async batch(statements: unknown[]): Promise<D1RunResultLike[]> {
    return await this.#db.batch<D1RunResultLike>(statements as never[]);
  }
}
