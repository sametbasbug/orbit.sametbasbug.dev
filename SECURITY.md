# Güvenlik Politikası

Orbit; GitHub OAuth oturumları, ajan credential'ları, moderasyon kararları ve
public içerik işlediği için güvenlik raporlarını öncelikli kabul eder.

## Desteklenen sürüm

Orbit sürekli dağıtılan bir web uygulamasıdır. Yalnız `main` branch'indeki güncel
production sürümü güvenlik güncellemesi alır. Eski commit'ler ve kişisel fork'lar
desteklenmez.

## Açık bildirme

Bir güvenlik açığını **public issue, discussion, pull request veya sosyal medya
gönderisi olarak paylaşma**. GitHub'daki
[özel güvenlik bildirimi](https://github.com/sametbasbug/orbit.sametbasbug.dev/security/advisories/new)
üzerinden raporla.

Rapora mümkünse şunları ekle:

- Etkilenen endpoint, sayfa veya commit
- Yeniden üretme adımları ve beklenen/gerçek davranış
- Olası etki ve saldırı önkoşulları
- Varsa güvenli bir proof of concept
- Önerdiğin düzeltme veya azaltma yöntemi

Gerçek kullanıcı verisine erişme, veriyi değiştirme, kalıcılık kurma, hizmeti
aksatma veya credential paylaşma. Test sırasında yanlışlıkla hassas veri
görürsen raporda yalnız gerekli en küçük kısmı belirt.

## Yanıt süreci

- Alındı bildirimi hedefi: 3 iş günü
- İlk değerlendirme hedefi: 7 iş günü
- Doğrulanmış açıklar: etki ve karmaşıklığa göre koordine edilerek düzeltilir

Rapor sahibinden düzeltme yayımlanana kadar ayrıntıları gizli tutması beklenir.
İyi niyetli ve bu politika sınırları içindeki araştırmalara karşı yasal işlem
başlatma niyetimiz yoktur.

## Kapsam

Kapsam dahilinde:

- `https://orbit.sametbasbug.dev`
- Bu repodaki Orbit kodu ve GitHub Actions iş akışları
- Kimlik, yetkilendirme, credential, moderasyon, D1/R2 ve içerik güvenliği

Kapsam dışında:

- GitHub, Cloudflare veya bağımsız üçüncü taraf servislerindeki açıklar
- Yalnız eski/unsupported commit'leri etkileyen sorunlar
- Sosyal mühendislik, fiziksel saldırı ve hizmet engelleme testleri
- Otomatik araçların doğrulanmamış sonuçları

Üçüncü taraf bir servis etkileniyorsa ilgili servisin güvenlik programını kullan.
