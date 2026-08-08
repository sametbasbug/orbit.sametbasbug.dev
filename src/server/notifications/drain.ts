import type { OrbitBindings } from '../identity/bindings';
import {
  D1NotificationRepository,
  EMAIL_DRAIN_BATCH,
} from '../repositories/notification-repository';
import { createEmailSender, type EmailSender } from './email';

export interface EmailDrainResult {
  attempted: number;
  sent: number;
  failed: number;
  /* Gönderim kapalıyken kuyruk boşaltılmıyor ve bu bir arıza değil.
   * Sonucun bunu açıkça söylemesi lazım, yoksa "0 gönderildi" hem
   * "kuyruk boştu" hem "gönderim kapalıydı" anlamına gelir ve ikisi çok
   * farklı durumlar. */
  senderConfigured: boolean;
}

/* Kuyruğu boşaltır. Postalar SIRAYLA gidiyor, paralel değil: Resend'in
 * hız sınırına toplu halde çarpıp hepsini birden geçici hataya düşürmek,
 * yavaş göndermekten kötü. Zaten bir turda gönderilen sayı sınırlı ve
 * kalanlar beş dakika sonraki turda gidiyor. */
export async function drainEmailQueue(
  env: OrbitBindings,
  now = Date.now(),
  senderOverride?: EmailSender | null,
): Promise<EmailDrainResult> {
  const sender = senderOverride ?? createEmailSender(env);
  if (!sender) return { attempted: 0, sent: 0, failed: 0, senderConfigured: false };

  const repository = new D1NotificationRepository(env.DB);
  const pending = await repository.listPending(EMAIL_DRAIN_BATCH);
  let sent = 0;
  let failed = 0;

  for (const email of pending) {
    const result = await sender.send({
      to: email.recipient,
      subject: email.subject,
      bodyText: email.bodyText,
      /* Yalnız duyuru postası kapatılabilir. Kapatılamayan bir postaya
       * List-Unsubscribe koymak, tutulmayacak bir söz vermek olurdu. */
      unsubscribable: email.kind === 'announcement',
    });
    if (result.outcome === 'sent') {
      await repository.markSent(email.id, now);
      sent += 1;
      continue;
    }
    await repository.markAttemptFailed(email.id, result.error, result.outcome === 'permanent');
    failed += 1;
  }

  return { attempted: pending.length, sent, failed, senderConfigured: true };
}
