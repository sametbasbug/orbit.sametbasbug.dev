/* Sitenin bildirdiği işlem kataloğu.
 *
 * Orbit bağlı sitelerin işlerini BİLMİYOR. "Listeye anime ekle" burada tanımlı
 * değil; site kendi adresinde bir JSON yayımlıyor, Orbit onu okuyup ajana
 * sunuyor. Beşinci site geldiğinde Orbit'e kod girmemesinin sebebi bu.
 *
 * Bu dosyanın işi o JSON'a GÜVENMEMEK: dosya siteye ait ama Orbit'in ağından
 * çıkacak isteği o belirliyor. Doğrulanmazsa katalog, Orbit'i seçtiği herhangi
 * bir adrese istek attırabilir.
 */

export interface SiteActionOperation {
  operationId: string;
  summary: string;
  idempotent: boolean;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
}

export interface SiteActionCatalog {
  version: 1;
  operations: SiteActionOperation[];
}

export class SiteActionCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteActionCatalogError';
  }
}

/* Katalog 10 dakika önbellekte. Site yeni bir işlem eklediğinde Orbit'e kod
 * girmiyor; en geç 10 dakika sonra ajanın kataloğunda görünüyor. Daha uzun
 * tutmak "ekledim ama görünmüyor" şikâyeti, daha kısası her ajan isteğinde
 * siteye çıkmak olurdu. */
export const SITE_ACTION_CATALOG_TTL_MS = 600_000;

const MAX_OPERATIONS = 100;
const MAX_CATALOG_BYTES = 128 * 1024;

/* Şema dilinin İZİN VERİLEN alt kümesi.
 *
 * Tam JSON Schema kabul etmiyoruz: `$ref` uzak adres çeker, `patternProperties`
 * ve `pattern` düzenli ifade çalıştırır (ReDoS), `allOf`/`anyOf` iç içe geçip
 * doğrulayıcıyı patlatır. Ajanın gördüğü şema aynı zamanda Orbit'in girdi
 * doğrulamasında koştuğu şema, yani buraya giren her anahtar bizim de
 * çalıştırdığımız kod demek.
 *
 * Liste genişlerse `docs/baglisite-ajan-eylemleri.md` içinde ilan edilir —
 * MCP tarafı bu alt kümeye göre yazılıyor ve sessiz genişleme onu kırar. */
const ALLOWED_SCHEMA_KEYS = new Set([
  'type', 'required', 'properties', 'items', 'enum',
  'additionalProperties', 'minimum', 'maximum', 'maxLength', 'description',
]);

const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean']);

function assertSchema(value: unknown, yol: string, derinlik = 0): Record<string, unknown> {
  /* Derinlik sınırı: iç içe geçmiş bir şema özyinelemeli doğrulayıcıyı yığın
   * taşmasına sürükleyebilir ve bunu tetikleyen dosya bize ait değil. */
  if (derinlik > 8) throw new SiteActionCatalogError(`${yol}: şema fazla derin`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SiteActionCatalogError(`${yol}: şema bir nesne olmalı`);
  }
  const schema = value as Record<string, unknown>;
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) {
      throw new SiteActionCatalogError(`${yol}: desteklenmeyen şema anahtarı "${key}"`);
    }
  }
  if (typeof schema.type === 'string' && !ALLOWED_TYPES.has(schema.type)) {
    throw new SiteActionCatalogError(`${yol}: desteklenmeyen tür "${schema.type}"`);
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      throw new SiteActionCatalogError(`${yol}.properties: nesne olmalı`);
    }
    for (const [ad, alt] of Object.entries(schema.properties as Record<string, unknown>)) {
      assertSchema(alt, `${yol}.properties.${ad}`, derinlik + 1);
    }
  }
  if (schema.items !== undefined) assertSchema(schema.items, `${yol}.items`, derinlik + 1);
  return schema;
}

function assertString(value: unknown, yol: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new SiteActionCatalogError(`${yol}: ${min}-${max} karakter arası metin olmalı`);
  }
  return value;
}

/** Katalog gövdesini doğrular. Ağ erişimi yok — sınanabilir olsun diye ayrı. */
export function normalizeSiteActionCatalog(value: unknown): SiteActionCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SiteActionCatalogError('katalog bir nesne olmalı');
  }
  const doc = value as Record<string, unknown>;
  if (doc.version !== 1) throw new SiteActionCatalogError('katalog sürümü 1 olmalı');

  /* Gidilecek adres BURADAN OKUNMUYOR. Katalog dosyası siteye ait ama
   * doğrulanmadan güvenilemez; adresi o belirleseydi dosyayı ele geçiren biri
   * Orbit'i seçtiği herhangi bir yere — iç ağ, bulut metadata servisi, üçüncü
   * taraf — istek atmaya ikna edebilirdi, üstelik Orbit'in imzalı belgesini de
   * yanında taşıyarak. Adres `oauth_clients.actions_endpoint` içinde, kayıt
   * anında platform sahibi tarafından veriliyor.
   *
   * `actionsEndpoint` alanı gövdede varsa yok sayılıyor, hata verilmiyor:
   * kontratın erken sürümü onu istiyordu ve elinde o dosyayla duran bir site
   * yüzünden katalogun tamamı düşmemeli. */

  const rawOperations = doc.operations;
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    throw new SiteActionCatalogError('operations boş olmayan bir dizi olmalı');
  }
  if (rawOperations.length > MAX_OPERATIONS) {
    throw new SiteActionCatalogError(`operations en fazla ${MAX_OPERATIONS} olabilir`);
  }

  const gorulen = new Set<string>();
  const operations = rawOperations.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new SiteActionCatalogError(`operations[${index}]: nesne olmalı`);
    }
    const op = item as Record<string, unknown>;
    const operationId = assertString(op.operationId, `operations[${index}].operationId`, 3, 80);
    if (!/^[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/u.test(operationId)) {
      throw new SiteActionCatalogError(
        `operations[${index}].operationId "site.islem" biçiminde olmalı`,
      );
    }
    if (gorulen.has(operationId)) {
      /* Yinelenen kimlik, hangi işlemin çalıştığını belirsiz bırakır. */
      throw new SiteActionCatalogError(`operations: "${operationId}" iki kez tanımlı`);
    }
    gorulen.add(operationId);
    return {
      operationId,
      summary: assertString(op.summary, `operations[${index}].summary`, 1, 300),
      idempotent: op.idempotent === true,
      input: assertSchema(op.input, `operations[${index}].input`),
      output: op.output === undefined || op.output === null
        ? null
        : assertSchema(op.output, `operations[${index}].output`),
    };
  });

  return { version: 1, operations };
}

/** Girdiyi işlemin şemasına göre doğrular. Orbit'te, siteye geçmeden önce. */
export function validateOperationInput(
  input: unknown,
  schema: Record<string, unknown>,
  yol = 'input',
): void {
  const tur = typeof schema.type === 'string' ? schema.type : null;

  if (tur === 'object') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new SiteActionCatalogError(`${yol}: nesne olmalı`);
    }
    const nesne = input as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const ad of (Array.isArray(schema.required) ? schema.required : [])) {
      if (typeof ad === 'string' && nesne[ad] === undefined) {
        throw new SiteActionCatalogError(`${yol}.${ad}: zorunlu`);
      }
    }
    /* Varsayılan KAPALI: şema `additionalProperties` demediyse bile fazladan
     * alan reddediliyor. Ajanın uydurduğu bir alanı sessizce siteye taşımak,
     * sitenin beklemediği bir şeyi yazmasına yol açabilir. */
    if (schema.additionalProperties !== true) {
      for (const ad of Object.keys(nesne)) {
        if (properties[ad] === undefined) {
          throw new SiteActionCatalogError(`${yol}.${ad}: tanımsız alan`);
        }
      }
    }
    for (const [ad, alt] of Object.entries(properties)) {
      if (nesne[ad] !== undefined) validateOperationInput(nesne[ad], alt, `${yol}.${ad}`);
    }
    return;
  }

  if (tur === 'array') {
    if (!Array.isArray(input)) throw new SiteActionCatalogError(`${yol}: dizi olmalı`);
    if (schema.items) {
      input.forEach((eleman, i) =>
        validateOperationInput(eleman, schema.items as Record<string, unknown>, `${yol}[${i}]`));
    }
    return;
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(input as never)) {
      throw new SiteActionCatalogError(`${yol}: izin verilen değerlerden biri olmalı`);
    }
    return;
  }

  if (tur === 'string') {
    if (typeof input !== 'string') throw new SiteActionCatalogError(`${yol}: metin olmalı`);
    if (typeof schema.maxLength === 'number' && input.length > schema.maxLength) {
      throw new SiteActionCatalogError(`${yol}: en fazla ${schema.maxLength} karakter`);
    }
    return;
  }

  if (tur === 'integer' || tur === 'number') {
    if (typeof input !== 'number' || !Number.isFinite(input)) {
      throw new SiteActionCatalogError(`${yol}: sayı olmalı`);
    }
    if (tur === 'integer' && !Number.isInteger(input)) {
      throw new SiteActionCatalogError(`${yol}: tam sayı olmalı`);
    }
    if (typeof schema.minimum === 'number' && input < schema.minimum) {
      throw new SiteActionCatalogError(`${yol}: en az ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && input > schema.maximum) {
      throw new SiteActionCatalogError(`${yol}: en fazla ${schema.maximum}`);
    }
    return;
  }

  if (tur === 'boolean' && typeof input !== 'boolean') {
    throw new SiteActionCatalogError(`${yol}: doğru/yanlış olmalı`);
  }
}

/** Katalogu siteden çeker ve doğrular. */
export async function fetchSiteActionCatalog(input: {
  actionsUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<SiteActionCatalog> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.actionsUrl, {
    headers: { accept: 'application/json' },
    /* Yönlendirme izlenmiyor: katalog adresi doğrulandı ama yönlendirme onu
     * doğrulanmamış bir yere taşıyabilir. */
    redirect: 'manual',
  });
  if (response.status !== 200) {
    throw new SiteActionCatalogError(`katalog ${response.status} döndü`);
  }
  const govde = await response.text();
  if (govde.length > MAX_CATALOG_BYTES) {
    throw new SiteActionCatalogError('katalog fazla büyük');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(govde);
  } catch {
    throw new SiteActionCatalogError('katalog geçerli JSON değil');
  }
  return normalizeSiteActionCatalog(parsed);
}
