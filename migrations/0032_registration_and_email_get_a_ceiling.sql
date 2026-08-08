-- Davet kapısı kalkmadan önce iki tavan.
--
-- Bugün Orbit'e kayıt olmak için elde bir davet olması gerekiyor ve o davet
-- tek tek veriliyor. Kapı kalktığında GitHub hesabı olan herkes kayıt
-- olabilecek — yani kayıt hacmini bir insanın kararı değil, internet
-- belirleyecek. Bu iki tavan o devri karşılamak için.

-- 1. Kayıt hızı.
--
-- Kayıt sayacının kaynağı yeni bir tablo değil: account_sign_in_events zaten
-- her kaydı 'registration' olarak yazıyor, IP'siyle birlikte. Sayaç için ayrı
-- bir tablo açmak, aynı olayı iki yere yazıp ikisinin birbirinden kaymasını
-- beklemek olurdu.
--
-- Bunun bir sonucu var ve bilerek kabul ediliyor: sayılan şey BAŞARILI
-- kayıtlar, denemeler değil. Yani bu bir "brute force" savunması değil —
-- GitHub OAuth'u zaten o işi yapıyor. Buradaki tavan hacim tavanı: bir gecede
-- yüzlerce hesabın açılmasını engelliyor.
--
-- Mevcut indeks (account_id, created_at DESC) bu sorguya yaramıyor; sorgu
-- hesaptan değil zamandan ve IP'den giriyor. Kısmi indeks, tabloda çoğunluğu
-- oluşturan 'sign_in' satırlarını dışarıda bırakıyor.
CREATE INDEX account_sign_in_events_registration_rate_idx
  ON account_sign_in_events (created_at)
  WHERE event_type = 'registration';

CREATE INDEX account_sign_in_events_registration_ip_idx
  ON account_sign_in_events (ip, created_at)
  WHERE event_type = 'registration' AND ip IS NOT NULL;

-- 2. Posta bütçesi.
--
-- Gönderim sağlayıcısının ücretsiz katmanı günde 100, ayda 3000 posta
-- veriyor. Bugün abone sayısı bir avuç olduğu için bu sınır uzak duruyor;
-- kapı açıldığında duyuru postası alan kişi sayısı kayıt sayısıyla birlikte
-- artacak ve sınıra ilk çarpan şey bir duyuru olacak.
--
-- Sınıra çarpmanın bedeli "duyuru gitmedi" değil: kota bittiğinde SIRADAKİ
-- posta da gitmiyor, ve sıradaki posta bir güvenlik veya moderasyon bildirimi
-- olabilir. Yani önemsiz bir duyuru, hesabıyla ilgili bir kararı insana
-- ulaştırmamıza mal olabilir.
--
-- Bütçeyi ölçebilmek için denemenin ne zaman yapıldığını bilmek gerekiyor.
-- sent_at yetmiyor: başarısız denemeler de sağlayıcının kotasından düşüyor
-- ama sent_at'leri hiç dolmuyor. attempts sütunu kaç denendiğini söylüyor,
-- ne zaman denendiğini söylemiyor — 24 saatlik pencereyi ondan çıkaramayız.
--
-- Nullable ve geriye doldurulmuyor: göç anında kuyrukta bekleyen satırlar
-- henüz denenmemiş sayılır. Geçmiş gönderimleri sent_at'ten türetip bütçeye
-- yazmak, göçün ertesi günü bütçeyi olduğundan dolu göstermek olurdu.
ALTER TABLE email_deliveries ADD COLUMN last_attempt_at INTEGER;

-- Bütçe sorgusu her boşaltma turunda çalışıyor ve tablonun tamamını değil,
-- son 24 saati okuyor.
CREATE INDEX email_deliveries_attempt_budget_idx
  ON email_deliveries (last_attempt_at)
  WHERE last_attempt_at IS NOT NULL;
