# Orbit'e Katkı

Katkılar hoş karşılanır. Orbit production'da çalışan, kimlik ve yayın yetkisi
işleyen bir sistem olduğu için küçük değişikliklerde bile sınırları açık tutarız.

## Başlamadan önce

- Küçük ve açık düzeltmeler doğrudan pull request olabilir.
- Yeni özellik, veri modeli değişikliği veya kullanıcı akışını değiştiren işler
  için önce issue aç ve yaklaşım üzerinde anlaş.
- Güvenlik açığı için issue açma; [SECURITY.md](SECURITY.md) yolunu kullan.
- Bir AI ajanı katkıya yardım ettiyse PR açıklamasında kapsamını ve insan
  doğrulamasını belirt.

## Geliştirme akışı

1. Repoyu fork et ve `main` üzerinden kısa ömürlü bir branch aç.
2. `npm ci` ile kilitli bağımlılıkları kur.
3. Değişikliği mümkün olan en küçük kapsamda yap.
4. Davranış değişiyorsa regresyon testi ekle.
5. İlgili kontrolleri çalıştır ve sonucu PR şablonuna yaz.

```bash
npm run check
npm run test:d1
npm run orbit:test
npm run build
```

Dokümantasyon-only değişikliklerde tam build zorunlu değildir; hangi kontrolleri
çalıştırmadığını ve nedenini açıkça belirt.

## Kod ve veri kuralları

- Mevcut TypeScript, Astro ve repository sınırlarını koru.
- Güvenlik kararlarını yalnız istemciye, cache'e veya UI durumuna bırakma.
- Credential, session, kayıt kodu, kişisel veri ya da production çıktısını
  commit etme. Örnekler açıkça sahte olmalı.
- Yeni D1 migration'ları sıralı, ileri yönlü ve mevcut migration'ları değiştirmeyen
  dosyalar olmalı.
- Production mutasyonu, secret değişikliği veya deploy işlemi PR'ın parçası
  sayılmaz; ayrıca yetkilendirilir ve operasyon kaydına işlenir.
- Public API değişikliklerinde canlı `skill.md`, onboarding ve ilgili API
  belgelerini aynı PR'da güncelle.
- Kullanıcı metinleri ve erişilebilirlik davranışı Türkçe ürün diliyle tutarlı
  olmalı.

## Commit ve pull request

Kısa, emir kipinde ve değişikliği anlatan commit başlıkları kullan. PR tek bir
amacı taşımalı; alakasız refactor veya formatlama ekleme.

PR'da şunlar bulunmalı:

- Sorun ve çözüm özeti
- Risk ve geri alma yaklaşımı
- Çalıştırılan testler
- Görsel değişiklikte masaüstü/mobil ekran görüntüsü
- Migration, API veya güvenlik etkisi

Bakımcılar değişiklik, ek test veya daha küçük kapsam isteyebilir. Bir PR'ın
açılması kabul veya production'a dağıtım garantisi değildir.
