# MCP köprüsü — bağlı sitelerde ajan eylemleri

Kime: Selene, `orbit-remote-mcp` tarafını kuran taraf.
Durum: **Orbit ucu canlıda ve iki siteyle doğrulandı.** Eksik olan tek şey MCP
köprüsü.

Sözleşmenin kendisi `baglisite-ajan-eylemleri.md`. Bu dosya onu tekrarlamıyor;
köprüyü yazarken verilmesi gereken kararları ve benim canlıda çarptığım
köşeleri yazıyor.

## Kaç araç eklemeli — iki, işlem başına bir değil

`PRIVATE_OPERATIONS` statik ve bunu sen söyledin: API'ye eklenen bir uç MCP'de
kendiliğinden görünmüyor. Buradaki tasarımın taşıyıcı kısıtı da bu yüzden
önemli — **Orbit sitelerin işlerini bilmiyor.** İşlem listesi siteden geliyor
ve site yeni bir işlem eklediğinde Orbit'e kod girmiyor.

İşlem başına bir MCP aracı yazarsan bu kazanç çöper: beşinci site, ya da
Haber'in eklediği üçüncü bir işlem, seni tekrar `orbit-remote-mcp`'ye gitmeye
zorlar. Dolayısıyla **iki genel araç** öneriyorum:

| araç | ne yapar |
|---|---|
| `baglisite_islemleri_listele` | Ajan erişimi açık siteleri ve her birinin işlemlerini şemalarıyla döndürür. |
| `baglisite_islem_calistir` | `grantId` + `operationId` + `input` ile bir işlemi çalıştırır. |

Birincisinin çıktısı ikincisinin girdisini tarif ediyor; model şemayı çalışma
anında okuyup çağrıyı kuruyor. Ajanın hiçbir şey saklamasına gerek yok, ki
zaten saklayacak yeri yok.

## Uçlar

### 1. Katalog

```
GET /v1/me/connected-sites/actions
Authorization: Bearer <ajan credential>
```

Erişimi **kapalı** siteler listede hiç görünmez. Yani liste boşsa cevap
"yapabileceğin bir şey yok" değil, "insan henüz hiçbir siteyi açmamış".
Modele bunu ayırt ettir; yoksa kullanıcıya yanlış şeyi söyler.

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
denedim, reddedildi. `input` işlem parametresizse bile `{}` olarak gitmeli.

**`idempotencyKey` zorunlu ve mantıksal işlem başına üretilmeli, deneme başına
değil.** 1–128 basılabilir ASCII. Aynı anahtar + aynı gövde ilk çalışmanın
cevabını döndürür (`status: "replayed"`); aynı anahtar + FARKLI gövde 409
`idempotency_conflict` alır. Yani modelin her denemede yeni anahtar üretmesi
tekrar korumasını tamamen kapatır — asıl kazanç orada.

**Sitenin hata GÖVDESİ ajana taşınmıyor.** Orbit bunu bilerek yapmıyor: içeriği
doğrulanmamış bir metni kendi cevabı gibi göstermek olurdu. Sonucu şu: siteden
dönen her 4xx sana içeriksiz bir `site_action_failed` (502) olarak geliyor.

Haber bu yüzden **alan kararlarını 2xx ile döndürüyor** ve çıktıda
`uygulandi: false` + sebep taşıyor. Yani `status: "applied"` "iş oldu" demek
DEĞİL; `output.uygulandi` okunmalı. Rota'da böyle bir ayrım yok, orada 4xx
gerçekten hata. Köprü her iki biçimi de modele düz aktarsın, yorumlamasın.

**Katalog 10 dakika önbellekte.** Site yeni işlem eklediyse hemen görünmez.
Kullanıcı "az önce ekledim" diyorsa cevap "yok" değil, "en geç 10 dakika".

**Şema dili dar bir alt küme.** `$ref`, `pattern`, `allOf`/`anyOf`/`oneOf` yok;
nesnelerde `additionalProperties` varsayılan olarak kapalı. Şemayı MCP
`inputSchema`'sına düz geçirebilirsin ama tam JSON Schema varsayan bir
doğrulayıcıya verme.

**403 `agent_access_closed` bir arıza değil, bir kapı.** İnsan Orbit panelinden
kapatmış ya da hiç açmamış. Tekrar denenmemeli; modele "Orbit panelinde
Bağlı siteler → <site> → ajan erişimini aç" dedirtmeli.

## Haber'e özel iki şey

**İşlem sırası var.** `haber.panoYaz` bir `briefId` döndürüyor, `haber.yayinla`
onu tüketiyor. Pano **tek kullanımlık** ve 6 saat sonra doluyor. Tek çağrıda
yayın yok ve olmayacak: panoyu sabitlemek, seçimin hangi adaylar arasından
yapıldığını kayda geçiriyor.

**Yayın imzası senin elinde değil.** Gövdeye yazar alanı koyma — reddedilir.
İmza Haber'in `publishers` tablosundan okunuyor ve senin satırın orada hazır:
`Selene AI`. Bu kasıtlı; kimse başkasının imzasıyla yayımlayamasın diye.

## Nasıl sınarsın

Rota'da `rota.listeyiOku` ile başla — okuma, geri dönüşü yok, katalogdan
çağrıya kadar bütün zinciri yürütüyor. Sonra `rota.katalogdaAra`. Yazma
işlemlerine ancak bu ikisi çalıştıktan sonra geç.

Haber'de `haber.panoYaz` güvenli: pano satırı yazıyor ama hiçbir şey
yayımlamıyor ve 6 saat sonra kendiliğinden düşüyor. `haber.yayinla`yı canlıda
denemeden önce Samet'e söyle — o çağrı gerçekten haber yayımlıyor.

## Dokunmaman gerekenler

Orbit'in kendi ajan yolu (`mcp_authorization_grants`, `posts:write` vb.) bu
işin dışında ve karışmamalı. Orada ajan **kendi adına** davranıyor; burada
insanın adına. İkisini tek araçta birleştirmek, "kimin adına" sorusunu
kaybetmek olur.
