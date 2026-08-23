# Bağlı sitelerde ajan eylemleri — kontrat

Durum: **tasarım kesinleşti, uygulama sürüyor.** Bu belge Orbit ile MCP köprüsü
arasındaki sözleşmedir. MCP tarafını Selene kuruyor; buradaki hiçbir şey
`orbit-remote-mcp` deposuna dokunmadan değişmemeli.

## Neyi çözüyor

İnsan, Orbit hesabıyla girdiği bir siteyi panelden ajanına açıyor. Ajan o
sitede **insanın adına** iş yapıyor — ayrı ajan hesabı, ayrı ajan listesi
oluşmuyor. Orbit'in kendisi istisna: orada ajanlar kendi adına davranır ve o
yol `mcp_authorization_grants` üzerinden yürür, buraya karışmaz.

Tasarımın taşıyıcı kısıtı: **Orbit sitelerin işlerini bilmez.** "Listeye anime
ekle" Orbit'te tanımlı değildir. Orbit yetkiyi tutar, imzalar ve taşır; işlemin
ne olduğunu site söyler. Beşinci site eklendiğinde Orbit'e kod girmemesinin
sebebi bu.

İkinci kısıt: **ajan hiçbir şey saklamaz.** ChatGPT Web gibi istemcilerde
konuşmalar arasında kalıcı depo yok. Ajanın elinde site anahtarı tutulmaz;
Orbit'e bağlı olması yeter, site anahtarını Orbit üretip kendisi kullanır.

## 1. Katalog — ajan ne yapabileceğini nereden öğrenir

```
GET /v1/me/connected-sites/actions
Authorization: Bearer <ajan credential>
```

Ajan kimliğiyle çağrılır. Yanıt, ajanın insanının **ajan erişimi açık** olan
bağlı sitelerini ve o sitelerin bildirdiği işlemleri taşır. Erişimi kapalı
siteler listede hiç görünmez — kapalı bir kapıyı katalogda göstermek, ajanı
kesin reddedilecek bir isteğe davet etmek olurdu.

```json
{
  "sites": [
    {
      "grantId": "grant_01H…",
      "clientId": "orbit-equinox-rota",
      "label": "Equinox Rota",
      "siteUrl": "https://anime.sametbasbug.dev",
      "catalogFetchedAt": 1756000000000,
      "operations": [
        {
          "operationId": "rota.listeyeEkle",
          "summary": "İnsanın listesine anime ekler veya durumunu günceller.",
          "idempotent": true,
          "input": {
            "type": "object",
            "required": ["animeId", "durum"],
            "additionalProperties": false,
            "properties": {
              "animeId": { "type": "string", "maxLength": 300 },
              "durum": { "enum": ["IZLIYOR", "BITTI", "PLANLI", "BIRAKTI"] },
              "ilerleme": { "type": "integer", "minimum": 0, "maximum": 100000 },
              "puan": { "type": "integer", "minimum": 1, "maximum": 10 }
            }
          },
          "output": {
            "type": "object",
            "properties": { "animeId": { "type": "string" }, "durum": { "type": "string" } }
          }
        }
      ]
    }
  ]
}
```

### `describe` neden ayrı bir uç değil

Şema kataloğun içinde geliyor. Ayrı bir `describe` ucu her işlem için ek bir
gidiş-dönüş demekti ve ajanın elinde saklayacak yer olmadığı için o gidiş-dönüş
her seferinde tekrarlanırdı. Katalog küçük ve zaten site başına filtreli.

`input` ve `output` **JSON Schema draft 2020-12** alt kümesidir: `type`,
`required`, `properties`, `enum`, `additionalProperties`, `minimum`, `maximum`,
`maxLength`, `items`. Bu listeyi genişletmek MCP tarafını kırabilir; genişlerse
burada ilan edilir.

## 2. Çağrı — ajan işi nasıl yaptırır

```
POST /v1/me/connected-sites/{grantId}/actions
Authorization: Bearer <ajan credential>
Content-Type: application/json

{
  "operationId": "rota.listeyeEkle",
  "input": { "animeId": "kitsu:1376", "durum": "IZLIYOR" },
  "idempotencyKey": "<yazdıran tarafın ürettiği, ≤128 basılabilir karakter>"
}
```

`grantId` yolda, çünkü yetki kontrolünün baktığı satır o. Gövdede `clientId`
taşımak, aynı bilgiyi iki yerden alıp uyuşmazlığını kontrol etmek olurdu.

`idempotencyKey` **zorunlu**. Bu bir yazma işlemi ve ajan tarafı yeniden
denemeye yatkın; anahtarsız bir tekrar, listeye ikinci kez yazmak demek.
Biçim Orbit'in başka yerlerindekiyle aynı: 1–128 basılabilir ASCII.

### Yanıt

```json
{
  "action": {
    "operationId": "rota.listeyeEkle",
    "status": "applied",
    "output": { "animeId": "kitsu:1376", "durum": "IZLIYOR" }
  }
}
```

`status`: `applied` (uygulandı) veya `replayed` (aynı `idempotencyKey` ile daha
önce uygulanmıştı; `output` ilk çalışmanınkidir).

### Hatalar

| kod | durum | anlamı |
|---|---|---|
| `connected_site_not_found` | 404 | İzin yok ya da başkasına ait. |
| `agent_access_closed` | 403 | İnsan bu site için ajan erişimini açmamış ya da kapatmış. |
| `unknown_site_operation` | 400 | `operationId` sitenin kataloğunda yok. |
| `invalid_site_operation_input` | 400 | `input`, işlemin şemasına uymuyor. |
| `site_catalog_unavailable` | 503 | Sitenin katalog dosyası okunamadı. |
| `site_action_failed` | 502 | Site isteği reddetti ya da erişilemedi; `details.siteStatus` taşınır. |
| `idempotency_conflict` | 409 | Aynı anahtar farklı bir gövdeyle kullanıldı. |

Girdi doğrulaması **Orbit'te** yapılır, siteye geçmeden. Site kendi kontrolünü
ayrıca yapar — iki kat, çünkü Orbit şemayı siteden okur ve okuduğu şey eskimiş
olabilir.

## 3. Site kendini nasıl bildirir

`oauth_clients` satırına `actions_url` alanı eklenir. Site oraya statik bir
JSON koyar; sunucu gerekmez, GitHub Pages'te duran bir dosya yeter.

```json
{
  "version": 1,
  "actionsEndpoint": "https://rslltclzdfzwaxqtozmq.supabase.co/functions/v1/orbit-eylem",
  "operations": [ /* katalogdaki `operations` ile aynı biçim */ ]
}
```

Orbit bu dosyayı okur ve **10 dakika** önbellekte tutar; `catalogFetchedAt` o
anı verir. Yeni bir işlem eklendiğinde Orbit'e kod girmez, en geç 10 dakika
sonra katalogda görünür.

`actionsEndpoint` `https` olmak ve `oauth_clients.site_url` ile aynı kayıtlı
siteye ait olmak zorundadır; katalog dosyası Orbit'i keyfi bir adrese istek
atmaya ikna edemez.

## 4. Orbit → site: devretme belgesi

Orbit siteye şunu gönderir:

```
POST <actionsEndpoint>
Authorization: Bearer <eylem belgesi>
Content-Type: application/json
Idempotency-Key: <ajanın verdiği anahtar>

{ "operationId": "rota.listeyeEkle", "input": { … } }
```

Eylem belgesi **ES256 imzalı JWT**'dir ve Orbit'in mevcut site anahtarlarıyla
imzalanır; site onu `/.well-known/jwks.json` üzerinden doğrular. Siteyle
paylaşılan kalıcı bir sır **yoktur** — sızacak bir şey olmasın diye.

```json
{
  "iss": "https://orbit.sametbasbug.dev",
  "aud": "orbit-equinox-rota",
  "sub": "<pairwise subject — sitenin o insan için tanıdığı kimlik>",
  "act": { "sub": "agent:<agentId>", "handle": "<ajan handle>" },
  "scope": "site.actions",
  "operation": "rota.listeyeEkle",
  "jti": "<tek kullanımlık>",
  "iat": 1756000000,
  "exp": 1756000060
}
```

- `sub` sitenin giriş sırasında tanıdığı **aynı** pairwise kimliktir. Site
  kullanıcıyı kendi kaydında bununla bulur; yeni bir eşleme kurmasına gerek yok.
- `act` (RFC 8693 "actor") işi yapanın ajan olduğunu söyler. İş insanın
  adınadır ama **kimin yaptığı kaybolmaz**; site isterse kaydeder.
- `operation` belgeye gömülüdür: bir işlem için alınmış belge, gövdesi
  değiştirilerek başka bir işlem için kullanılamaz.
- Ömür **60 saniye**. Ajan saklamaz, Orbit her çağrıda yeniden üretir.

Site şunları doğrulamak zorundadır: imza, `iss`, `aud` (kendi clientId'si),
`exp`, ve `operation` ile gövdedeki `operationId`'nin eşleştiği.

## 5. Rota'nın ilk işlemleri

| operationId | ne yapar |
|---|---|
| `rota.listeyeEkle` | Listeye ekler ya da var olan kaydın durumunu/ilerlemesini/puanını günceller. |
| `rota.listeyiOku` | İnsanın listesini döndürür. |

İkisi de `personal_list_entries` üzerinde ve **insanın satırlarında** çalışır.
Ajanın kendi listesi yoktur.

## Kararlar ve gerekçeleri

**Neden ajan siteye doğrudan konuşmuyor.** Konuşsaydı elinde bir site anahtarı
tutması gerekirdi; saklama yeri olmayan istemcilerde bu çalışmaz. Ayrıca iptal
tek yerde kalmaz — insan Orbit'te kapatır ama ajanın elindeki anahtar yaşamaya
devam ederdi.

**Neden izin `oauth_client_grants` satırının içinde.** Site bağlantısı
kesildiğinde ajan erişimi de düşmeli ve bunun ayrı bir temizlik adımı
gerektirmemesi lazım; unutulan temizlik açık kalan kapıdır.

**Neden katalog siteden geliyor.** Alternatifi, her site özelliği için Orbit'e
kod eklemekti. Beş sitede Orbit her şeyi bilmek zorunda olan bir yere dönerdi.
