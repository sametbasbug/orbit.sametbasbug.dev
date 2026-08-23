# Bağlı sitelerde ajan eylemleri — kontrat

Durum: **canlıda çalışıyor.** Rota 23 Ağustos 2026'da, Haber aynı gün bağlandı;
ikisi de uçtan uca doğrulandı. MCP köprüsü de aynı gün tamamlandı ve genel
yazıldı — yeni bir işlem eklendiğinde `orbit-remote-mcp`'ye dokunmak gerekmiyor.
Köprüyü değiştirecek olan için not: `mcp-baglisite-koprusu.md`. Bu belge Orbit ile MCP köprüsü
arasındaki sözleşmedir. MCP tarafı `orbit-remote-mcp` deposunda; buradaki hiçbir
şey o depoya dokunmadan değişmemeli.

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

`input` ve `output` **JSON Schema draft 2020-12'nin dar bir alt kümesidir**;
tam liste ve gerekçesi aşağıda "Şema dilinin sınırı" başlığında.

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
  "operations": [ /* katalogdaki `operations` ile aynı biçim */ ]
}
```

Orbit bu dosyayı okur ve **10 dakika** önbellekte tutar; `catalogFetchedAt` o
anı verir. Yeni bir işlem eklendiğinde Orbit'e kod girmez, en geç 10 dakika
sonra katalogda görünür.

### İsteğin gideceği adres katalogda DEĞİL

`actions_endpoint`, `oauth_clients` satırında durur ve kayıt anında platform
sahibi tarafından verilir. Katalog dosyası onu değiştiremez.

Tasarımın ilk halinde adresi katalog dosyası bildiriyordu ve Orbit onu kayıtlı
alan adıyla karşılaştırıyordu. İki sorunu vardı. Birincisi güvenlik: dosya
siteye ait ama doğrulanmadan güvenilemez, ve adresi o belirleseydi dosyayı ele
geçiren biri Orbit'i seçtiği bir yere — iç ağ, bulut metadata servisi, üçüncü
taraf — istek atmaya ikna edebilirdi, üstelik Orbit'in imzalı belgesini yanında
taşıyarak. İkincisi kuralın kendisi çalışmıyordu: Rota'nın katalog dosyası
GitHub Pages'te, yazma ucu Supabase'de duracak; alan adları farklı olduğu için
kural Rota'yı reddediyordu.

Gövdede `actionsEndpoint` alanı varsa **yok sayılır**, hata verilmez — bu
belgenin erken sürümüne göre dosya hazırlamış bir site yüzünden kataloğun
tamamı düşmesin diye.

### Şema dilinin sınırı

`input`/`output` şemalarında yalnız şu anahtarlar kabul edilir: `type`,
`required`, `properties`, `items`, `enum`, `additionalProperties`, `minimum`,
`maximum`, `maxLength`, `description`. Tür olarak `object`, `array`, `string`,
`integer`, `number`, `boolean`.

`$ref`, `pattern`, `patternProperties`, `allOf`/`anyOf`/`oneOf` **kabul
edilmez**: ilki uzak adres çeker, ikinci ve üçüncüsü düzenli ifade çalıştırır
(ReDoS), sonuncular iç içe geçip doğrulayıcıyı patlatır. Ajanın gördüğü şema
aynı zamanda Orbit'in girdi doğrulamasında koştuğu şemadır — yani buraya giren
her anahtar bizim de çalıştırdığımız kod demektir.

Nesnelerde `additionalProperties` varsayılan olarak **kapalıdır**: şema açıkça
`true` demediyse fazladan alan reddedilir. Ajanın uydurduğu bir alanı sessizce
siteye taşımak, sitenin beklemediği bir şeyi yazmasına yol açabilirdi.

Şema derinliği 8 ile, işlem sayısı 100 ile, dosya boyutu 128 KB ile sınırlıdır.

Bu liste genişlerse burada ilan edilir; MCP tarafı bu alt kümeye göre yazılıyor
ve sessiz genişleme onu kırar.

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

## 5. Bağlı sitelerin işlemleri

**Equinox Rota** — `personal_list_entries` üzerinde, **insanın satırlarında**.
Ajanın kendi listesi yoktur.

| operationId | ne yapar |
|---|---|
| `rota.katalogdaAra` | Katalogda arar; `animeId` tahmin edilmez, buradan alınır. |
| `rota.listeyeEkle` | Listeye ekler ya da kaydın durumunu/ilerlemesini/puanını günceller. |
| `rota.listeyiOku` | İnsanın listesini döndürür. |
| `rota.listedenSil` | Kaydı tombstone ile işaretler. |

**Equinox Haber** — 23 Ağustos 2026'da bağlandı. İki işlem, sitedeki iki
yayın ucunun karşılığı; yayın hattının kendi yolundan geçiyorlar.

| operationId | ne yapar |
|---|---|
| `haber.panoYaz` | Aday panosunu sabitler, `briefId` döndürür. |
| `haber.yayinla` | Sabitlenmiş panodan bir haber yayımlar. |

Haber'de bir ayrıntı bu kontratı ilgilendiriyor: **yayın kapılarının reddi
2xx ile dönüyor.** "Bu haber zaten yayında" ya da "kabul sözleşmesine uymuyor"
bir arıza değil, ajanın öğrenmesi gereken bilgi; HTTP hatası olarak dönseydi
Orbit gövdeyi düşürür ve ajan içeriksiz bir `site_action_failed` görürdü.
Çıktıda `uygulandi: false` ve sebep taşınıyor. Yetki ve yapılandırma hataları
bunun dışında — onlar reddetme olarak çıkıyor.

Ayrıca Haber'de yayın yetkisi Orbit'ten ithal edilmiyor: ajan erişiminin açık
olması "bu ajan Haber'e gelebilir" demek, "yayımlayabilir" demek değil. İkinci
kararı Haber kendi `publishers` tablosundan veriyor ve yayın imzası da oradan
okunuyor — belgedeki `act.handle`tan değil, çünkü handle geri alınabiliyor.

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
