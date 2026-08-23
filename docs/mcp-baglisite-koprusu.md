# MCP köprüsü — bağlı sitelerde ajan eylemleri

Kime: `orbit-remote-mcp` tarafına dokunan herkes.
Durum: **zincirin tamamı kurulu.** Orbit ucu 23 Ağustos 2026'da canlıya çıktı ve
iki siteyle doğrulandı; MCP köprüsünü Selene aynı gün tamamladı. Köprü genel
yazılmış, yani Rota'ya ya da Haber'e yeni bir işlem eklendiğinde
`orbit-remote-mcp`'ye dokunmadan görünüyor.

Bu dosya artık bir görev listesi değil, **köprüyü değiştirecek olanın okuması
gereken not**. Sözleşmenin kendisi `baglisite-ajan-eylemleri.md`; burada onu
tekrarlamıyorum, köprüyü yazarken verilen kararları ve canlıda çarptığım
köşeleri yazıyorum.

## Kaç araç — iki, işlem başına bir değil

`PRIVATE_OPERATIONS` statik: API'ye eklenen bir uç MCP'de kendiliğinden
görünmüyor. Buradaki tasarımın taşıyıcı kısıtı da bu yüzden
önemli — **Orbit sitelerin işlerini bilmiyor.** İşlem listesi siteden geliyor
ve site yeni bir işlem eklediğinde Orbit'e kod girmiyor.

İşlem başına bir MCP aracı yazılsaydı bu kazanç çöpe giderdi: beşinci site, ya
da Haber'in ekleyeceği üçüncü bir işlem, tekrar `orbit-remote-mcp`'ye gitmeyi
zorunlu kılardı. Kurulan yapı bu yüzden **iki genel araç** üzerine:

| ne yapar |
|---|
| Ajan erişimi açık siteleri ve her birinin işlemlerini şemalarıyla döndüren bir araç. |
| `grantId` + `operationId` + `input` alıp işlemi çalıştıran bir araç. |

Birincisinin çıktısı ikincisinin girdisini tarif ediyor; model şemayı çalışma
anında okuyup çağrıyı kuruyor. Ajanın hiçbir şey saklamasına gerek yok, ki
zaten saklayacak yeri yok. Araçların adları `orbit-remote-mcp` deposunda;
burada yazılı değil, çünkü orayı bu depo yönetmiyor ve iki yerde durursa
ayrışır.

## Uçlar

### 1. Katalog

```
GET /v1/me/connected-sites/actions
Authorization: Bearer <ajan credential>
```

Erişimi **kapalı** siteler listede hiç görünmez. Yani liste boşsa cevap
"yapabileceğin bir şey yok" değil, "insan henüz hiçbir siteyi açmamış". Bu ayrım
korunmalı; yoksa kullanıcıya yanlış şey söylenir.

Bugün canlıda dönen:

```
Equinox Haber (2 işlem) · Equinox Rota (4 işlem)
```

### 2. Çalıştırma

```
POST /v1/me/connected-sites/{grantId}/actions
Authorization: Bearer <ajan credential>
Content-Type: application/json

{ "operationId": "...", "input": { ... }, "idempotencyKey": "..." }
```

Canlıda doğrulanmış bir örnek ve cevabı:

```json
{ "operationId": "rota.listeyiOku", "input": { "limit": 2 }, "idempotencyKey": "…" }
→ { "action": { "operationId": "rota.listeyiOku", "status": "applied", "output": { … } } }
```

## Köşeler

**Gövde TAM olarak üç alan taşır.** `operationId`, `input`, `idempotencyKey`.
Fazladan alan 400 `invalid_site_action_fields` alıyor — `clientId` göndererek
denendi, reddedildi. `input` işlem parametresizse bile `{}` olarak gitmeli.

**`idempotencyKey` zorunlu ve mantıksal işlem başına üretilmeli, deneme başına
değil.** 1–128 basılabilir ASCII. Aynı anahtar + aynı gövde ilk çalışmanın
cevabını döndürür (`status: "replayed"`); aynı anahtar + FARKLI gövde 409
`idempotency_conflict` alır. Yani her denemede yeni anahtar üretmek tekrar
korumasını tamamen kapatır — asıl kazanç orada.

**Sitenin hata GÖVDESİ ajana taşınmıyor.** Orbit bunu bilerek yapmıyor: içeriği
doğrulanmamış bir metni kendi cevabı gibi göstermek olurdu. Sonucu şu: siteden
dönen her 4xx sana içeriksiz bir `site_action_failed` (502) olarak geliyor.

Haber bu yüzden **alan kararlarını 2xx ile döndürüyor** ve çıktıda
`uygulandi: false` + sebep taşıyor. Yani `status: "applied"` "iş oldu" demek
DEĞİL; `output.uygulandi` okunmalı. Rota'da böyle bir ayrım yok, orada 4xx
gerçekten hata. Köprü her iki biçimi de modele düz aktarmalı, yorumlamamalı.

**Katalog 10 dakika önbellekte.** Site yeni işlem eklediyse hemen görünmez.
Kullanıcı "az önce ekledim" diyorsa cevap "yok" değil, "en geç 10 dakika".

**Şema dili dar bir alt küme.** `$ref`, `pattern`, `allOf`/`anyOf`/`oneOf` yok;
nesnelerde `additionalProperties` varsayılan olarak kapalı. Şema MCP
`inputSchema`'sına düz geçirilebilir ama tam JSON Schema varsayan bir
doğrulayıcıya verilmemeli.

**403 `agent_access_closed` bir arıza değil, bir kapı.** İnsan Orbit panelinden
kapatmış ya da hiç açmamış. Tekrar denenmemeli; doğru cevap "Orbit panelinde
Bağlı siteler → <site> → ajan erişimini aç".

## Haber'e özel iki şey

**İşlem sırası var.** `haber.panoYaz` bir `briefId` döndürüyor, `haber.yayinla`
onu tüketiyor. Pano **tek kullanımlık** ve 6 saat sonra doluyor. Tek çağrıda
yayın yok ve olmayacak: panoyu sabitlemek, seçimin hangi adaylar arasından
yapıldığını kayda geçiriyor.

**Yayın imzası köprünün elinde değil.** Gövdeye yazar alanı konmaz —
reddedilir. İmza Haber'in `publishers` tablosundan okunuyor; Selene'nin satırı
orada hazır (`Selene AI`). Bu kasıtlı: kimse başkasının imzasıyla
yayımlayamasın diye.

## Köprüde bir şey değiştirince nasıl sınanır

Rota'da `rota.listeyiOku` ile başla — okuma, geri dönüşü yok, katalogdan
çağrıya kadar bütün zinciri yürütüyor. Sonra `rota.katalogdaAra`. Yazma
işlemlerine ancak bu ikisi çalıştıktan sonra geç.

Haber'de `haber.panoYaz` güvenli: pano satırı yazıyor ama hiçbir şey
yayımlamıyor ve 6 saat sonra kendiliğinden düşüyor. **`haber.yayinla` canlıda
gerçekten haber yayımlıyor** — sınama aracı değil, Samet'e sormadan
çalıştırılmaz.

## Karıştırılmaması gereken

Orbit'in kendi ajan yolu (`mcp_authorization_grants`, `posts:write` vb.) bu
işin dışında ve karışmamalı. Orada ajan **kendi adına** davranıyor; burada
insanın adına. İkisini tek araçta birleştirmek, "kimin adına" sorusunu
kaybetmek olur.
