/* Giden posta: Resend üzerinden tek bir HTTP çağrısı.
 *
 * Bir SDK bağlamıyorum. Gönderdiğimiz şey düz metin bir bildirim; araya
 * bir bağımlılık koymak, Worker paketini büyütmekten başka bir şey
 * getirmezdi.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  bodyText: string;
  /* Duyuru postaları kapatılabilir; hesap ve güvenlik postaları
   * kapatılamaz. Ayrım burada da duruyor çünkü List-Unsubscribe başlığı
   * yalnız gerçekten kapatılabilen postaya konmalı: kapatılamayan bir
   * postaya o başlığı koymak, tutulmayacak bir söz vermek olur. */
  unsubscribable: boolean;
}

/* Gönderim sonucu üç hâlden biri. Ayrım tekrar denemeyi belirliyor:
 * kalıcı hatada tekrar denemek aynı cevabı alır ve her denemede geri dönen
 * posta üretir; geçici hatada denememek ise bildirimi kaybetmek olur. */
export type EmailResult =
  | { outcome: 'sent' }
  | { outcome: 'permanent'; error: string }
  | { outcome: 'transient'; error: string };

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailResult>;
}

export interface ResendConfig {
  apiKey: string;
  from: string;
  replyTo: string;
}

export class ResendSender implements EmailSender {
  readonly #config: ResendConfig;
  readonly #fetch: typeof fetch;

  constructor(config: ResendConfig, fetchImpl?: typeof fetch) {
    this.#config = config;
    this.#fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    let response: Response;
    try {
      response = await this.#fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.#config.from,
          /* Gönderen adresi posta almak zorunda değil; yanıtlar insanın
           * gerçekten okuduğu kutuya gitsin. */
          reply_to: this.#config.replyTo,
          to: [message.to],
          subject: message.subject,
          text: message.bodyText,
          ...(message.unsubscribable
            ? { headers: { 'List-Unsubscribe': `<${this.#config.replyTo}>` } }
            : {}),
        }),
      });
    } catch (error) {
      /* Ağ hatası geçicidir: Resend'e ulaşamamak, Resend'in bizi
       * reddettiği anlamına gelmiyor. */
      return { outcome: 'transient', error: errorText(error) };
    }
    if (response.ok) return { outcome: 'sent' };
    const detail = `${response.status}:${(await response.text().catch(() => '')).slice(0, 200)}`;
    /* 4xx bizim isteğimizin yanlış olduğunu söylüyor — geçersiz adres,
     * doğrulanmamış alan adı, reddedilen anahtar. Tekrar göndermek aynı
     * cevabı alır. 429 istisna: "şu an fazla" demek, "asla" değil.
     * 5xx Resend tarafındaki geçici arıza. */
    if (response.status === 429 || response.status >= 500) {
      return { outcome: 'transient', error: detail };
    }
    return { outcome: 'permanent', error: detail };
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/* Anahtar yoksa gönderim kapalıdır ve bu bir arıza değil: yerel geliştirme,
 * test ve staging bu hâlde çalışıyor. Kuyruk yazılmaya devam eder, yalnız
 * boşaltılmaz — yani gönderim açıldığında bekleyenler gider. Sessizce
 * "gönderildi" demek ise yalan olurdu, o yüzden satırlar bekliyor kalıyor. */
export function createEmailSender(env: {
  RESEND_API_KEY?: string;
  ORBIT_EMAIL_FROM?: string;
  ORBIT_EMAIL_REPLY_TO?: string;
}, fetchImpl?: typeof fetch): EmailSender | null {
  if (!env.RESEND_API_KEY || !env.ORBIT_EMAIL_FROM || !env.ORBIT_EMAIL_REPLY_TO) return null;
  return new ResendSender({
    apiKey: env.RESEND_API_KEY,
    from: env.ORBIT_EMAIL_FROM,
    replyTo: env.ORBIT_EMAIL_REPLY_TO,
  }, fetchImpl);
}
