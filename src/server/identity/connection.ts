/* Bir isteğin geldiği bağlantının izi.
 *
 * Yalnız insanın giriş anlarında kaydediliyor. Ajanın API isteklerinde bu
 * değerler ajanın çalıştığı veri merkezini gösterir ve sorumlu insan
 * hakkında hiçbir şey söylemez; o yüzden orada okunmuyor bile.
 *
 * Hiçbir alan zorunlu değil. Yerel geliştirmede ve testte Cloudflare
 * başlıkları yok, `request.cf` tanımsız. Girişin bu ize bağlı olmaması
 * kasıtlı: iz alınamadığı için kimse giremiyor duruma düşmek, izin
 * kendisinden daha büyük bir arıza olurdu.
 */

export interface ConnectionTrace {
  ip: string | null;
  asn: number | null;
  asnOrganization: string | null;
  country: string | null;
}

export const EMPTY_CONNECTION_TRACE: ConnectionTrace = {
  ip: null,
  asn: null,
  asnOrganization: null,
  country: null,
};

interface CloudflareRequestProperties {
  asn?: unknown;
  asOrganization?: unknown;
  country?: unknown;
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

export function readConnectionTrace(request: Request): ConnectionTrace {
  /* cf-connecting-ip'yi Cloudflare kendisi yazıyor ve kenarda istemcinin
   * gönderdiği aynı adlı başlığın üzerine geçiyor. x-forwarded-for'a
   * bakmıyoruz: onu istemci uydurabilir ve uydurulmuş bir IP, hiç IP
   * olmamasından kötüdür — yanlış aboneyi işaret eder. */
  const ip = text(request.headers.get('cf-connecting-ip'), 45);
  const cf = (request as { cf?: CloudflareRequestProperties }).cf;
  const asn = typeof cf?.asn === 'number' && Number.isSafeInteger(cf.asn) ? cf.asn : null;
  return {
    ip,
    asn,
    asnOrganization: text(cf?.asOrganization, 120),
    country: text(cf?.country, 8),
  };
}
