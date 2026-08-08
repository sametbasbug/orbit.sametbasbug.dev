import type { OrbitBindings } from '../identity/bindings';
import {
  D1NotificationRepository,
  EMAIL_BUDGET_WINDOW_MS,
  EMAIL_DAILY_BUDGET,
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
  /* Bütçeden kalan. Sıfır olması, kuyrukta posta olabileceği halde bu turda
   * hiçbirinin denenmediği anlamına geliyor — ve bunu görebilmem lazım,
   * çünkü "attempted: 0" tek başına yine boş bir kuyruğa benziyor. */
  budgetRemaining: number;
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
  if (!sender) {
    return { attempted: 0, sent: 0, failed: 0, senderConfigured: false, budgetRemaining: 0 };
  }

  const repository = new D1NotificationRepository(env.DB);
  /* Bütçe kapısı burada, kuyruğu okumadan önce. Sağlayıcının kotası
   * bittiğinde sıradaki posta da gitmiyor — ve sıradaki posta bir güvenlik
   * bildirimi olabilir. Yani kotayı bir duyuru dalgasına harcamanın bedeli
   * duyurunun gitmemesi değil, ondan sonrakinin gidememesi. */
  const spent = await repository.countAttemptsSince(now - EMAIL_BUDGET_WINDOW_MS);
  const budgetRemaining = Math.max(0, EMAIL_DAILY_BUDGET - spent);
  /* Bu erken dönüş bir kısayol, kapının kendisi değil: kapı aşağıdaki
   * LIMIT. Ölçtüm — bu bloğu kaldırınca davranış değişmiyor, çünkü kalan
   * sıfırken LIMIT 0 zaten boş liste döndürüyor. Duruyor olmasının sebebi
   * bütçe dolduğunda gereksiz bir sorgudan kaçınmak. */
  if (budgetRemaining === 0) {
    return { attempted: 0, sent: 0, failed: 0, senderConfigured: true, budgetRemaining: 0 };
  }

  const pending = await repository.listPending(Math.min(EMAIL_DRAIN_BATCH, budgetRemaining));
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
    await repository.markAttemptFailed(email.id, result.error, result.outcome === 'permanent', now);
    failed += 1;
  }

  return {
    attempted: pending.length,
    sent,
    failed,
    senderConfigured: true,
    budgetRemaining: budgetRemaining - pending.length,
  };
}
