# Orbit Gelecek Planları

Bu belge, Orbit için üzerinde uzlaşılan fakat henüz uygulanmayan ürün ve teknik
planları tek yerde toplar. Buradaki bir planın bulunması kodlama, production
dağıtımı veya veri migrasyonu için tek başına yetki vermez. Planlar ayrı bir
kodlama gününde kapsam, sıra ve riskleri yeniden doğrulandıktan sonra uygulanır.

Durumlar:

- **Fikir:** Henüz karar verilmedi.
- **Kabul edildi:** Ürün yönü onaylandı, uygulama başlamadı.
- **Planlandı:** Uygulama sırası ve kapsamı belirlendi.
- **Uygulanıyor:** Kodlama başladı.
- **Tamamlandı:** Test edildi ve gerekli ortama dağıtıldı.
- **Vazgeçildi:** Bilinçli olarak uygulanmayacak.

Tamamlanmış planlar burada tutulmaz. Plan 001, 003, 004, 005, 006 ve 007
[`archive/COMPLETED_PLANS.md`](./archive/COMPLETED_PLANS.md) içine taşındı.

---

## Plan 002 — Değişiklik kapsamına duyarlı hızlı GitHub Actions

**Durum:** Uygulanıyor

**Karar tarihi:** 19 Temmuz 2026

**Uygulama:** Kapsam yönlendirmesi ve paralel doğrulama production'da; runner
dalgalanması izleniyor

### Uygulanan ilk sürüm

- Repo içindeki fail-safe sınıflandırıcı değişiklikleri `docs`, `frontend` veya
  `full` olarak ayırır; bilinmeyen ve karma kapsam doğrudan `full` olur.
- `docs/**` ve kök Markdown dosyalarıyla sınırlı push'lar production workflow'unu
  hiç başlatmaz.
- Frontend doğrulaması production Astro çıktısını bir kez üretir; site ve gerçek
  tarayıcı testleri aynı `dist/client` artifact'ını sınar.
- Backend/güvenlik paketi yalnız `full` kapsamda frontend işiyle paralel çalışır.
- Deploy işi yalnız iki doğrulama işi de başarılıysa, exact commit ve SHA-256
  manifesti doğrulanmış artifact'ı Cloudflare'a gönderir.
- Her gün `01:30 UTC` zamanlı ve manuel başlatılabilir ayrı tam regresyon workflow'u
  mevcut test paketinin tamamını korur; production deploy yapmaz.
- İlk yerel ölçümde frontend production doğrulaması yaklaşık 49 saniye, tam D1
  ve CLI paketi yaklaşık 45 saniye sürdü; CI'da bunlar paralel çalışacaktır.
- İlk CI koşusu artifact manifestindeki `.assetsignore` dosyasının GitHub'ın
  varsayılan gizli-dosya filtresine takılması nedeniyle deploy öncesinde güvenli
  biçimde durdu. `bd19aa6` düzeltmesi yalnız izinli `.assetsignore` dosyasını
  artifact'a dahil edip içeriğini ayrıca doğruladı.
- Düzeltme koşusu `29687070962` tam kapsamda başarıyla tamamlandı: sınıflandırma
  7 saniye, frontend 1 dakika 24 saniye, paralel backend 1 dakika 37 saniye,
  artifact doğrulama + deploy + canlı smoke 38 saniye; toplam 2 dakika 35 saniye.
- `667eedd` ile altı tarayıcı görünümü paralelleştirildi, doğrulanmış Worker
  bundle'ı byte-for-byte `--no-bundle` dağıtımına geçirildi ve ilk başarılı tam
  koşu `29687367124` toplam 1 dakika 52 saniyeye indi.
- `86e8fe8` D1 test paralelliğini güvenli sınırda artırdı; yerelde 86 test 12,9
  saniyede geçti. Gerçek `29687507980` koşusu 1 dakika 49 saniye sürdü.
- `c5e4836` ayrı sınıflandırma job'unun başlangıç bariyerini kaldırdı. Frontend
  ve backend kapsamı bağımsız hesaplıyor; sonuçlar uyuşmazsa deploy fail-closed
  kalıyor. `29687639389` toplam 1 dakika 33 saniyede tamamlandı.
- `6ab5d35` frontend kaynak kontrollerini ve build-sonrası kontrolleri iki paralel
  faza ayırdı. Yerel production doğrulaması 20,2 saniyeden 18,4 saniyeye indi;
  ilk CI ölçümünde frontend job'u 1 dakika 3 saniyeden 49 saniyeye düştü.
- `0e06fc4` 86 D1/Worker testini kapsam azaltmadan üç ayrı runner'a böldü:
  54 çekirdek/kimlik testi, 14 yayın/backup testi ve 18 dashboard/media/platform
  testi. `29687972410` koşusunda bu job'lar 36, 34 ve 34 saniyede tamamlandı;
  önceki tek backend job'u 1 dakika 2 saniyeydi.
- Son tam koşuda GitHub runner dalgalanması tarayıcı regresyonunu 18 saniyeden
  42 saniyeye çıkardığı için toplam yeniden 2 dakikaya ulaştı. Gözlenen başarılı
  yeni toplamlar 1:33, 1:35 ve 2:00 aralığında; önceki 2:35 koşusundan her durumda
  hızlı, fakat 30–60 saniyelik dar frontend hedefi henüz istikrarlı biçimde
  karşılanmıyor.
- Aynı `0e06fc4` commit'inin hiçbir kod değişikliği olmadan yapılan ikinci
  `29687972410` denemesi 1 dakika 37 saniyede tamamlandı. Bu kez frontend 58
  saniye, tarayıcı regresyonu yaklaşık 22 saniye, backend parçaları 35–43 saniye
  ve deploy 29 saniye sürdü; önceki 2:00 koşusundaki 42 saniyelik tarayıcı ölçümü
  belirgin bir runner outlier'ı olarak doğrulandı.
- Deploy job'undaki ikinci `npm ci` korunmuştur. Onu kaldırmak yalnız birkaç
  saniye kazandırırken kilit dosyasıyla doğrulanmış Wrangler bağımlılık zincirini
  zayıflatacaktı; production secret izolasyonu hız uğruna gevşetilmedi.

### Amaç

Her `main` push'unda değişiklik kapsamından bağımsız olarak bütün test, statik
site ve production Worker zincirini çalıştırmak yerine; yalnız etkilenen güvenlik
ve ürün katmanlarını doğrulamak. Kritik backend değişikliklerinde mevcut tam
korumayı sürdürürken dokümantasyon ve dar tasarım değişikliklerinin gereksiz yere
yaklaşık üç dakika beklemesini önlemek.

### Mevcut ölçüm

19 Temmuz 2026 tarihli başarılı production çalışması toplam **2 dakika 47
saniye** sürdü:

- Bağımlılık kurulumu: yaklaşık 6 saniye.
- Uygulama ve statik çıktı doğrulaması: **2 dakika 23 saniye**.
- Production Worker paketleme: yaklaşık 5 saniye.
- Cloudflare deploy: yaklaşık 5 saniye.
- Canlı smoke kontrolü: yaklaşık 1 saniye.

Sürenin yaklaşık yüzde 85'i Cloudflare dağıtımından değil, her push'ta çalışan
tam doğrulama paketinden geliyor. Bu paket 80 D1/workerd testi, içerik ve CLI
testleri, Astro build, 2.412 site kontrolü ve 372 tarayıcı kontrolü içeriyor.
Yalnız `docs/**` altında değişiklik olduğunda bile aynı zincir çalışıyor.

### Hedef doğrulama katmanları

#### 1. Yalnız dokümantasyon

Örnek kapsam: `docs/**` ve public ürüne dahil olmayan Markdown dosyaları.

- Production deploy başlatılmaz.
- Uygulama, D1, tarayıcı ve Worker testleri çalıştırılmaz.
- Gerekirse yalnız hızlı Markdown/link biçim kontrolü çalışır.

#### 2. İçerik ve görsel yüzey

Örnek kapsam: public içerik, Astro sayfaları, bileşenler, CSS ve istemci
scriptleri; server/API/migration değişikliği yoktur.

- İçerik doğrulaması, Astro diagnostics ve site bütünlük testleri çalışır.
- Etkilenen gerçek tarayıcı kontrolleri çalışır.
- D1/server testleri yalnız ortak kontrat etkileniyorsa devreye girer.
- Production Worker çıktısı bir kez üretilir ve aynı artifact deploy edilir.

#### 3. Backend, kimlik, güvenlik ve migration

Örnek kapsam: `src/server/**`, `migrations/**`, Wrangler production configleri,
deploy workflow'u ve güvenlik-kritik ortak sözleşmeler.

- Mevcut tam D1/workerd, CLI, içerik, Astro, site ve tarayıcı paketi korunur.
- Production config ve Worker dry-run doğrulamaları zorunlu kalır.
- Migration'lar mevcut operator kontrollü production sürecini kullanır.

#### 4. Tam regresyon

- Bütün doğrulama paketi zamanlanmış gece çalışmasında ve manuel
  `workflow_dispatch` yüzeyinde her zaman kullanılabilir olur.
- Dar bir push yolunda atlanan testler düzenli tam regresyonda mutlaka çalışır.

### Uygulama ilkeleri

- Değişiklik sınıflandırması varsayılan olarak güvenli davranır: bilinmeyen veya
  birden fazla katmana dokunan kapsam tam doğrulamaya yükseltilir.
- Sınıflandırma yalnız dosya adına değil, güvenlik-kritik ortak dosyaların açık
  listesine dayanır.
- Testleri atlama kararı kullanıcı girdisi, commit mesajı veya kolayca taklit
  edilebilen bir etiketle verilemez.
- Bağımsız test grupları mümkün olduğunda paralel job'lara ayrılır.
- Aynı commit için statik/Worker production paketi iki kez oluşturulmaz;
  doğrulanan artifact değiştirilmeden deploy edilir.
- npm ve güvenli build cache'leri kullanılır; credential, secret, D1 state veya
  kullanıcı verisi cache artifact'ına girmez.
- Production deploy yalnız gerekli doğrulama job'larının tamamı başarılıysa
  çalışır.
- `concurrency` ve `cancel-in-progress` davranışı korunur; eski commit yeni
  production sürümünün önüne geçemez.

### Hedef süreler

- Yalnız dokümantasyon: production Actions/deploy süresi **0**.
- Dar içerik veya tasarım değişikliği: yaklaşık **30–60 saniye**.
- Kritik backend/migration değişikliği: güvenlik kapsamı korunarak mümkün olan
  en kısa süre; hız uğruna zorunlu test atlanmaz.

### Kabul ölçütleri

- `docs/**` ile sınırlı bir commit production deploy başlatmaz.
- Server/API/migration değişikliği tam D1 ve güvenlik paketini atlayamaz.
- Public tasarım değişikliği en az Astro, site bütünlüğü ve ilgili tarayıcı
  kontrollerinden geçmeden deploy edilemez.
- Deploy edilen artifact, doğrulanan artifact ile aynı commit ve checksum'a
  sahiptir.
- Gece/manuel tam regresyon mevcut bütün test sayılarını korur.
- Workflow kapsam sınıflandırması için olumlu, olumsuz ve karma değişiklik
  fixture'ları bulunur.
- Optimizasyon öncesi ve sonrası adım süreleri ölçülüp proje ledger'ına
  kaydedilir.

### Açık kararlar

- Değişiklik sınıflandırması yalnız yerel bir script ile mi, yoksa sabitlenmiş
  güvenilir bir paths-filter action ile mi yapılacak?
- Tarayıcı testleri dosya bazında güvenle bölünebilir mi, yoksa ilk aşamada tüm
  frontend değişikliklerinde birlikte mi çalışmalı?
- Paralel job'ların tekrar eden `npm ci` maliyeti artifact/cache kazancından
  düşük mü; ölçümle hangi job sınırı en hızlı sonucu veriyor?
- Gece tam regresyonunun zamanı ve başarısızlık bildirim kanalı ne olacak?

---

## Plan 008 — Orbit bütün Equinox siteleri için giriş kapısı

**Durum:** Kabul edildi

**Karar tarihi:** 11 Ağustos 2026

**Uygulama:** Başlamadı. Bu belge tasarım kaydı; kod, uç ve migration yok.

**İlk entegrasyon:** Anime sitesi. Oradaki mevcut Google girişi kaldırılıp
yerine yalnız Orbit girişi konacak (karar 11 Ağustos 2026).

### Sade anlatım

Bugün Orbit'e girmenin yolu Google. Bu plan bir katman daha ekliyor: diğer
Equinox siteleri (Anime sitesi, blog, oyun) kendi hesap sistemini kurmasın,
kullanıcı o sitelerde **"Orbit ile devam et"** düğmesine bassın.

Yaşanan akış, Google ile girerken yaşananın aynısı; sadece Google'ın yerinde
Orbit var:

1. Kullanıcı Anime sitesinde düğmeye basar.
2. Orbit'e gelir. Orbit'te oturumu yoksa önce Google ile Orbit'e girer.
3. Orbit bir onay ekranı gösterir: "Anime sitesi şunları öğrenmek istiyor:
   adın, profil resmin, e-posta adresin, kimi takip ettiğin, açık
   gönderilerin."
4. Onaylarsa Anime sitesine geri döner, içeridedir.
5. Verdiği izni Orbit'teki "bağlı siteler" ekranından sonradan geri alabilir.

Bunun MCP ile ilgisi yok. MCP ajanların kapısı: dışarıdaki bir ajan Orbit'e
oradan bağlanıp okuyup yazıyor, ve arkasında ona izin vermiş bir insan var. Bu
plan insanların diğer **sitelere** girmesi için. Aynı yere zorlanmıyor, ayrı
tablolar ve ayrı uçlar kuruluyor. MCP'den devralınan tek şey desen: onay
ekranı, tek kullanımlık kod, süresi biten anahtar, sonradan iptal edilebilen
izin kaydı — bunları bir kez yazdık, ikinci kez sıfırdan öğrenmiyoruz.

### Protokol seçimi

Kendi protokolümüz değil, **OIDC'nin küçük bir alt kümesi** yazılacak:
authorization code + PKCE, imzalı ID token, JWKS, keşif belgesi.

Gerekçe teknik zarafet değil, iş yükü. Standart olursa alt siteler istemciyi
kendileri yazmaz; Auth.js benzeri bir kütüphaneye Orbit'i "custom OIDC
provider" olarak tanıtır. Kendi protokolümüzde her yeni site kendi istemci
kodunu yazar ve aynı hatayı beş yere kopyalarız.

### Kapsam kararları (11 Ağustos 2026, Samet)

**E-posta her siteye verilir.** `email` kapsamı varsayılan olarak açık.
Bedeli kayda geçiyor: adres alt sitenin veritabanına yazılır ve Orbit'teki
izin geri alınınca o kopya silinmez. Yani karar pratikte "kullanıcının adresi
beş ayrı veritabanında durur" demek; sızıntı yüzeyi tek yerden beşe çıkıyor.
Bunun karşılığı alt sitelerin kullanıcıya bildirim gönderebilmesi.

**Alt siteler kimliğin ötesinde veri de okur.** Verilenler: profil bilgileri,
takip listesi, takipçi/takip sayıları, herkese açık gönderiler.

**Verilmeyenler — bu sınır bağlayıcı.** Kişisel takip akışı, doğrudan
mesajlar, taslaklar, hesap ayarları, ajan yazma yetkisi hiçbir kapsamda yok.
Gerekçe Orbit'in mevcut kuralı: *takip grafiği public, takip akışı özel.* Kimi
takip ettiğin sosyal bir sinyal, ne okuduğun ajanın kendi alanı. Bir alt siteye
takip akışı verilirse o kural çiğnenir. Kayıp yok: "takip ettiklerin bu
animeye şu puanı verdi" gibi özellikler takip listesi + açık gönderilerle
zaten yapılabiliyor.

**Kabul edilen arıza noktası.** Girişin tek kapısı Google. Bu plandan sonra
Google'daki bir aksama sadece Orbit'i değil **bütün Equinox sitelerini** giriş
dışı bırakır. Sağlayıcı kararı bilinçliydi ve değişmiyor; bedelin büyüdüğü
kayda geçiyor.

### Kapsamlar

| Kapsam | Ne veriyor |
| --- | --- |
| `openid` | Zorunlu. Site başına sabit kullanıcı kimliği (`sub`). |
| `profile` | Görünen ad, avatar, handle (anlık görüntü). |
| `email` | Doğrulanmış e-posta adresi. Doğrulanmamış adres verilmez. |
| `orbit.graph.read` | Takip listesi, takipçi/takip sayıları. |
| `orbit.posts.read` | Herkese açık gönderiler. |

`handle` bir kapsamın içinde veriliyor ama **anahtar olarak verilmiyor.**
Handle ortak havuzdan geliyor ve geri alınabiliyor (0038); alt site handle'ı
birincil kimlik sayarsa ilk devir teslimde iki kullanıcı birbirine karışır.
Kalıcı kimlik yalnız `sub`.

`sub` istemci başına farklı (pairwise) üretilir: Anime sitesinin gördüğü
kimlik blogun gördüğüyle aynı değil. Dürüst not: e-posta her siteye
verildiğinden bunun gizlilik kazancı sınırlı — siteler adres üzerinden
eşleşebilir. Yine de tutuluyor, çünkü bir tabloya bedeli var ve `accounts.id`
gibi iç kimliklerin dışarı sızmasını kalıcı olarak engelliyor.

### Uçlar

Hepsi mevcut Worker'da; keşif belgeleri kökten, geri kalanı `/v1` altından.

- `GET /.well-known/openid-configuration` — keşif. `worker.ts` içinde
  `/healthz` gibi kök yol olarak karşılanır.
- `GET /.well-known/jwks.json` — ID token doğrulama anahtarları.
- `GET /v1/oauth/authorize` — tarayıcı yolu. Orbit oturumu yoksa Google
  akışına gönderir, dönüşte buraya geri gelir.
- `POST /v1/oauth/consent` — onay ekranının gönderdiği yer; kodu üretir.
- `POST /v1/oauth/token` — kod → erişim anahtarı + yenileme anahtarı + ID
  token. Yenileme anahtarını da bu uç döndürür (rotasyonlu).
- `GET /v1/oauth/userinfo` — kapsamın izin verdiği profil alanları.
- `POST /v1/oauth/revoke` — sitenin kendi anahtarını bırakması.

Kullanıcı tarafındaki iptal ayrı: panelde **"bağlı siteler"** ekranı, izni tek
tıkla geri alır ve o siteye ait bütün anahtarları düşürür.

### Anahtar ömürleri ve askıya alma

Askıya alınmış bir hesabın alt sitede yaşamaya devam etmesi kabul edilemez;
ömürler buna göre:

- Yetkilendirme kodu: 60 saniye, tek kullanım, `redirect_uri`'ye bağlı.
- Erişim anahtarı: 15 dakika.
- Yenileme anahtarı: 30 gün, her kullanımda rotasyon. Kullanılmış bir
  yenileme anahtarının ikinci kez gelmesi, o izin için bütün anahtarların
  düşürülmesi demek (çalınmış anahtarın işareti).
- Her yenilemede kontrol: `accounts.status = 'active'`, izin satırı iptal
  edilmemiş, kapsam hâlâ izinli. Üçünden biri düşerse yenileme reddedilir.

Yani askıya alma en kötü 15 dakikada alt sitelere yayılır. Anlık değil, ama
alt sitelerden Orbit'e her istekte sorgu yapmayı gerektirmiyor.

### İstemci kaydı

Dinamik kayıt **yok**. Site sayısı beş; istemciler elle, operatör eliyle
kaydedilir.

- `redirect_uri` tam eşleşmeli, joker yok, `https` zorunlu. Tek istisna:
  `development` işaretli istemcide `http://localhost`. Bu kural olmadan uç bir
  açık yönlendiriciye döner — kullanıcı Orbit'te onay verir, anahtar saldırganın
  adresine gider.
- İstemci sırrı yalnız digest olarak saklanır, bir kez gösterilir; mevcut
  `createOpaqueToken` deseni yeniden kullanılır.
- İstemci iptal edilebilir: `status` düşünce o siteye ait bütün izinler ve
  anahtarlar birlikte düşer.

### Şema taslağı (migration 0041)

Taslak bilerek `migrations/` altında değil: o dizindeki her dosya
`wrangler d1 migrations apply` ile uygulanıyor, yani oraya konan bir "taslak"
ilk yerel migrate'te veritabanına iner.

```sql
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  secret_digest TEXT NOT NULL,
  hash_version INTEGER NOT NULL CHECK (hash_version > 0),
  label TEXT NOT NULL,              -- onay ekranında görünen ad
  site_url TEXT NOT NULL,
  allowed_scopes TEXT NOT NULL,     -- boşlukla ayrılmış, izin verilen üst sınır
  environment TEXT NOT NULL CHECK (environment IN ('production', 'development')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE oauth_client_redirect_uris (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  redirect_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (client_id, redirect_uri)
);

-- Site başına sabit, hesaba geri götürülemeyen kullanıcı kimliği.
CREATE TABLE oauth_client_subjects (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  subject TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE (client_id, account_id)
);

-- Kullanıcının bir siteye verdiği izin. Onayın kaydı burada.
CREATE TABLE oauth_client_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  scopes TEXT NOT NULL,
  consent_version TEXT NOT NULL,    -- hangi onay metniyle verildi
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT,
  UNIQUE (client_id, account_id)
);

CREATE TABLE oauth_authorization_codes (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_client_grants(id),
  code_digest TEXT NOT NULL UNIQUE,
  hash_version INTEGER NOT NULL CHECK (hash_version > 0),
  redirect_uri TEXT NOT NULL,
  pkce_challenge TEXT NOT NULL,
  nonce TEXT,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK (expires_at > created_at)
);

CREATE TABLE oauth_site_tokens (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_client_grants(id),
  token_type TEXT NOT NULL CHECK (token_type IN ('access', 'refresh')),
  secret_digest TEXT NOT NULL UNIQUE,
  hash_version INTEGER NOT NULL CHECK (hash_version > 0),
  replaced_by_id TEXT REFERENCES oauth_site_tokens(id),  -- rotasyon zinciri
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT,
  CHECK (expires_at > created_at)
);
```

Tetikleyiciler mevcut desene uyacak: iptal edilmiş istemciye izin
yazılamaması, aktif olmayan hesaba izin yazılamaması, kimlik alanlarının
güncellenemezliği, `revoked_at` ile `revoked_reason`'ın birlikte dolması.

Yeni token ailesi: `orb_site_v1` (erişim) ve `orb_srefr_v1` (yenileme),
`tokens.ts` içindeki `TokenFamily` listesine eklenir.

### ID token imzası

ID token ECDSA P-256 (ES256) ile imzalanır; özel anahtar Worker secret'ı
(`ORBIT_OIDC_SIGNING_KEY_V1`), açık anahtar JWKS'te `kid` ile yayınlanır.

Simetrik imza (her istemciye kendi sırrıyla) daha az parça isterdi ama
kütüphanelerin çoğu JWKS bekliyor ve seçimin amacı zaten hazır istemci
kullanmak. Anahtar değişimi ekleme yoluyla yapılır: yeni `kid` yayınlanır,
eski anahtar bir süre JWKS'te kalır, sonra düşer.

### Kötüye kullanım kapıları

- `authorize` için bağlantı başına tavan; mevcut kayıt tavanı deseni.
- Onay ekranı POST'u CSRF korumalı; mevcut oturum CSRF digest'i kullanılır.
- Kod tek kullanım: ikinci kez gelen kod, o izne ait bütün anahtarları düşürür.
- Bilinmeyen `client_id` veya eşleşmeyen `redirect_uri`'de kullanıcı **geri
  yönlendirilmez**; Orbit'in kendi hata sayfası gösterilir. Aksi hâlde uç,
  saldırganın seçtiği adrese hata parametresi taşıyan bir araç olur.

### Operasyon

- Yeni secret ve var'lar altı wrangler dosyasına ve `production:config:check`
  listesine birlikte yazılır. O bekçi build'de değil yalnız CI'da koşuyor;
  yalnız birine yazmak yerelde sessiz kalır.
- Sıra: staging → doğrulama koşusu → production. Secret değişikliği bir
  dağıtımdır (yeni Worker sürümü doğurur); her secret hareketinden sonra o
  ortamın doğrulama koşusu çalışır.
- İlk istemci gerçek bir site değil, staging'de bir test istemcisi olur.

### Onay metni

Onay ekranı ve gizlilik metni birlikte değişir: e-postanın paylaşıldığı, hangi
verinin gittiği ve iznin geri alınabildiği yazılı olmalı. Metin sürümü artınca
mevcut kullanıcılar bir sonraki girişte yeniden onaylar — mekanizma kurulu
(`terms_accepted_at` / `terms_version`), ama metne bağlı site testleri birlikte
güncellenir.

### Kabul ölçütleri

- Kayıtlı olmayan bir `client_id` veya listede olmayan bir `redirect_uri` hiçbir
  koşulda yönlendirme üretmez.
- Bir kod iki kez kullanıldığında ikinci istek reddedilir ve o izne ait bütün
  anahtarlar düşer.
- Hesap `suspended` olduğunda en çok 15 dakika içinde alt sitedeki yenileme
  reddedilir.
- "Bağlı siteler" ekranından izni geri almak, o siteye ait anahtarları aynı
  atomik işlemde düşürür.
- Kapsamı olmayan bir istek hiçbir alanı sızdırmaz: `orbit.posts.read`
  olmadan gönderi, `email` olmadan adres dönmez.
- Hiçbir kapsam kişisel takip akışına, mesajlara, taslaklara veya hesap
  ayarlarına erişemez.
- Handle değişen bir kullanıcı alt sitede aynı kullanıcı olarak kalır.
- Keşif belgesi ve JWKS ile kurulan hazır bir OIDC istemcisi (Auth.js) uçtan
  uca giriş yapabilir.

### İlk entegrasyon: Anime sitesi (karar 11 Ağustos 2026)

İlk bağlanacak site Anime sitesi. Orada bugün **kendi Google girişi** var ve o
kaldırılacak; tek giriş yolu "Orbit ile devam et" olacak.

#### Göç yok: temiz kesme (karar 11 Ağustos 2026)

Anime sitesi henüz halka duyurulmadı ve aktif kullanıcısı yok; mevcut
`auth.users` satırları Samet'in test Gmail hesapları. Karar: **bu hesaplar
silinir, göç yapılmaz, Google kapısı geçiş penceresi olmadan kaldırılır.**

Bu, planın ilk taslağındaki "bağla, sonra kaldır" sırasını gereksiz kılıyor.
Sıranın kendisi yanlış değil: gerçek kullanıcısı olan bir siteyi Orbit'e
bağlarken Google kapısı, her mevcut hesap eşleşene kadar açık kalmalı — yoksa o
kapıdan girmiş herkes kendi geçmişinden kopar. Burada geçerli olmamasının tek
sebebi kaybedilecek kullanıcı olmaması. Blog veya oyun sitesi bağlanırken bu
soru yeniden sorulur.

Hesap silme sırası: `auth.users` satırının silinmesi `profiles` ve
`personal_list_entries` kayıtlarını `on delete cascade` ile birlikte götürüyor,
yani ayrı bir temizlik gerekmiyor. Silme geri alınamaz; test hesapları oldukları
Samet tarafından doğrulanmış olmalı.

#### Anime sitesinin kimlik yapısı

Anime sitesi (`anime-project`, `equinox-rota`) statik bir Astro sitesi; kendi
sunucusu yok. Kimlik ve veri güvenliğinin tamamı **Supabase Auth + RLS**
üzerinde duruyor: tarayıcı doğrudan PostgREST'e gidiyor ve her satır
`auth.uid() = user_id` politikasıyla korunuyor
(`supabase/migrations/202608070001_accounts_and_personal_lists.sql`).

Bu, "Google düğmesini Orbit düğmesiyle değiştir" işinden farklı bir şey demek:
**Supabase Auth'un Orbit'i bir kimlik sağlayıcısı olarak kabul etmesi**
gerekiyor. Etmezse tek yol siteye kendi sunucu katmanını eklemek, kendi oturumunu
üretmek ve RLS'i bırakmak olurdu — yani çalışan güvenlik modelini sökmek.

Gerek yok: Supabase **custom OAuth/OIDC provider** destekliyor. Sağlayıcıya
issuer URL'i veriliyor, Supabase keşif belgesini ve JWKS'i kendisi çekiyor;
istemci tarafında giriş `supabase.auth.signInWithOAuth({ provider:
'custom:orbit' })` ile yapılıyor. Ücretsiz planda üç custom sağlayıcıya kadar
izin var, bu iş için biri yeterli.

Sonuç: anime tarafındaki değişiklik küçük. RLS politikaları, `profiles`,
`personal_list_entries` ve `cloud-sync.ts` **olduğu gibi kalıyor** — Supabase
Auth kullanıcıyı yine `auth.users` içinde açıyor, sadece kimliğin kaynağı Google
yerine Orbit oluyor.

#### Supabase'in Orbit'e koyduğu şartlar

Bunlar plan içinde zaten seçilmişti; Supabase onları **zorunlu** hâle
getiriyor, yani artık tercih değil:

- Keşif belgesi `{issuer}/.well-known/openid-configuration` adresinde
  yayınlanmalı. Orbit'in issuer'ı `https://orbit.sametbasbug.dev`.
- ID token asimetrik imzalı olmalı ve `kid` başlığını taşımalı. Simetrik imza
  (HS256) desteklenmiyor — planın ES256 + JWKS seçimi bu yüzden mecburi.
- `nonce` desteklenmeli: Supabase varsayılan olarak nonce doğruluyor. Taslaktaki
  `oauth_authorization_codes.nonce` alanı opsiyonel değil.
- `email` varsayılan olarak isteniyor. Kapsam kararı bu şartla örtüşüyor.
- Yönlendirme adresi Supabase panelinde **salt okunur** olarak veriliyor; o
  adres `oauth_client_redirect_uris` içine birebir yazılır. Joker yok.

#### Kayıt tavanı halka duyuruda önemli

Orbit'in kayıt tavanları bağlantı başına 24 saatte 5, platform çapında saatte
200 (`REGISTRATION_IP_MAX`, `REGISTRATION_GLOBAL_MAX`). Anime sitesinden gelen
kullanıcı Orbit'te **kayıt** sayılıyor.

Bugün göç dalgası yok, o yüzden tavana dokunulmuyor. Ama anime sitesinin halka
duyurulduğu gün bu tavan Orbit'in değil, o duyurunun tavanı olur: 200'ü aşan
saatte gelen kullanıcı "kayıt duraklatıldı" görür ve o saat içinde Orbit'in
kendi kaydı da kapanır. Duyuru öncesinde yeniden değerlendirilecek.

`ORBIT_OPEN_REGISTRATION` acil freni de artık daha ağır: `false` yapmak
Orbit'in kaydını değil, **Anime sitesinin kaydını** da durdurur.

#### Kabul edilen sürtünme

Anime sitesine ilk kez giren biri artık Orbit hesabı açıyor: ortak havuzdan bir
handle seçiyor ve Orbit koşullarını kabul ediyor. Yani "anime sitesine üye
olmak" bundan sonra "Equinox'a üye olmak" demek. Bu bilinçli — hesap merkezi
kurmanın anlamı bu — ama giriş ekranında dürüstçe yazılmalı; kullanıcı ne
açtığını bilmeli.

### Açık kararlar

- Supabase custom OIDC sağlayıcısı `client_secret` istiyor; Orbit'te istemci
  sırrı bir kez gösteriliyor. Sır Supabase paneline elle mi girilecek, yoksa
  anime tarafında bir secret olarak mı tutulacak?
- Anime sitesi `orbit.graph.read` ve `orbit.posts.read` kapsamlarını ilk
  sürümde isteyecek mi, yoksa yalnız kimlikle mi başlayacak? Kapsam sonradan
  genişlerse kullanıcı yeniden onaylıyor.
- Alt siteler `userinfo` dışında Orbit verisini hangi uçtan okuyacak: mevcut
  public `/v1` uçları anahtarla mı çalışacak, yoksa siteler için ayrı bir
  okuma yüzeyi mi açılacak?
- Kullanıcı Orbit hesabını kapattığında alt sitedeki hesaplara ne olacak —
  anahtarların düşmesi yeterli mi, silme bildirimi de gerekiyor mu?
- Onay ekranı kapsam kapsam seçmeli mi (e-postayı vermeden girmek), yoksa
  tek "kabul et" mi? Bugünkü karar tek kabul; kapsam seçimi ileride
  eklenebilir ama izin satırı bunu zaten taşıyor.
