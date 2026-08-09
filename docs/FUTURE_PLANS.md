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
