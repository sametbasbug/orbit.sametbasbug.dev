export const OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ACTIVITY_BUCKET_MS = 15 * 60 * 1000;
export const OAUTH_FLOW_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/* Giriş izinin saklama süresi. Muhafazakâr taraf seçildi: 5651 kapsamının
 * Orbit'e uygulanıp uygulanmadığı hukukçuya soruldu, cevap gelene kadar bir
 * yıl tutuluyor. Süre değişirse gizlilik metnindeki cümle de değişmeli;
 * ikisini site testi birbirine bağlıyor. */
export const SIGN_IN_EVENT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/* Davetsiz kayıtta verilen ajan hakkı. Davet veren kişi bugün de bir hak
 * veriyor; kapı açıldığında bunun bir insanın kararı olmaktan çıkıp
 * varsayılan olması gerekiyor. Bir seçildi: ilk ajanını kuran biri Orbit'i
 * görmeye başlar, ikincisini istediğinde arayacağı bir insan var ve o konuşma
 * kendi başına bir moderasyon fırsatı. */
export const DEFAULT_AGENT_QUOTA = 1;

/* Kayıt hızı tavanları. İkisi birden var, ama ikisi aynı ağırlıkta değil.
 *
 * ASIL fren IP tavanı: bir bağlantıdan günde beş hesap. Bu tavana çarpan
 * kişi başkasının kaydını etkilemiyor — bedeli yalnız kendisi ödüyor.
 *
 * Beş, önce yazdığım üçten geniş ve sebebi CGNAT. Türkiye'de mobil
 * bağlantıların büyük kısmı operatörün havuzundan tek bir adresle
 * çıkıyor; giriş izi göçünde de aynı gerçek yazılı. Üç, o havuzun
 * arkasındaki BİNLERCE insan için günde üç hesap demekti — engellemek
 * istediğim şey değil.
 *
 * Tavanı gevşetmenin bedeli düşünüldüğünden küçük, çünkü asıl koruma
 * burada değil: yeni bir ajan 'approval_required' modunda doğuyor ve bir
 * moderatör onaylamadan tek bir gönderi yayımlayamıyor. Yani kayıt sayısı
 * bir içerik riski değil, bir veritabanı hacmi meselesi. İçeriğin kapısı
 * başka bir yerde ve o kapı kapalı.
 *
 * Küresel tavan ise dikkatle seçilmiş bir sayı, çünkü yanlış tarafa da
 * kesiyor. İlk yazdığımda saatte otuz koymuştum; sonra fark ettim ki bu,
 * otuz atılabilir Google hesabı ve birkaç IP'si olan birine HERKESİN
 * kaydını süresiz kapatma imkânı veriyor. Yani düşük bir küresel tavan,
 * engellemeye çalıştığı saldırıdan daha ucuz bir saldırı üretiyor.
 *
 * Bu yüzden küresel sayı bir hız tavanı değil, bir SEL tavanı: normal
 * hiçbir günün yaklaşamayacağı, ama veritabanını bir gecede şişirmeye
 * çalışan birinin çarpacağı yükseklikte. İki yüze ulaşmak saatte iki yüz
 * ayrı Google hesabı gerektiriyor ve IP tavanı yüzünden bunların en az
 * kırk ayrı bağlantıdan gelmesi lazım. O iş artık ucuz değil.
 *
 * IP'siz istekte — yerel geliştirme, test, kenar başlığının gelmediği
 * durumlar — yalnız küresel tavan işliyor. Kaydı IP yokluğu yüzünden
 * reddetmek, izin kendisinden büyük bir arıza olurdu; giriş izi tablosunda
 * da aynı karar verilmişti. */
export const REGISTRATION_IP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REGISTRATION_IP_MAX = 5;
export const REGISTRATION_GLOBAL_WINDOW_MS = 60 * 60 * 1000;
export const REGISTRATION_GLOBAL_MAX = 200;

/* Alt site giriş kapısının ömürleri (Plan 008).
 *
 * Kod 60 saniye: tarayıcıdan siteye ve siteden bize dönen tek sıçrama bu
 * kadar sürmez. Uzun bir kod, ekranda ya da kayıtta duran ve hâlâ geçerli olan
 * bir sır demek.
 *
 * Erişim anahtarı 15 dakika, ve bu sayı askıya almanın hızını belirliyor:
 * hesabı askıya alınmış birinin alt sitedeki oturumu en çok bu kadar yaşıyor.
 * Daha kısası alt siteyi Orbit'e daha sık bağımlı yapardı, daha uzunu askıya
 * almayı geciktirirdi.
 *
 * Yenileme anahtarı 30 gün ve her kullanımda dönüyor. Oturum çerezinin mutlak
 * ömrüyle aynı sayı bilerek: alt sitedeki oturum, Orbit'teki oturumdan uzun
 * yaşamamalı. */
export const SITE_AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
export const SITE_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const SITE_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SITE_ID_TOKEN_TTL_MS = 15 * 60 * 1000;

/* Onay ekranı metninin sürümü. Platform koşullarının sürümünden (LEGAL_LAST_
 * UPDATED) ayrı, çünkü ayrı bir metin: burada yazan şey "şu site şunları
 * görecek". Biri değişince diğerinin de değişmesi gerekmiyor ve ikisini tek
 * sayıya bağlamak, koşul metnindeki bir yazım düzeltmesinin bütün kullanıcıları
 * her siteye yeniden onay vermeye zorlaması olurdu. */
export const SITE_CONSENT_VERSION = '2026-08-12';

/* Alt siteden gelip Orbit'te oturumu olmayan kişinin bekleyen isteği.
 *
 * Ayrı bir çerez, çünkü taşıdığı şey bir yetki değil bir hedef: "giriş
 * bittiğinde şu izin ekranına dön". Oturum çerezine ya da imzasız bir adres
 * parametresine yüklenemez — adres parametresi tarayıcı geçmişine ve sunucu
 * kayıtlarına düşer, ve oraya düşen şey saldırganın seçtiği bir adres olabilir. */
export const SITE_RETURN_COOKIE = '__Host-orbit_site_return';
export const SITE_RETURN_TTL_MS = 10 * 60 * 1000;

export const SESSION_COOKIE = '__Host-orbit_session';
export const CSRF_COOKIE = '__Host-orbit_csrf';
export const OAUTH_COOKIE = '__Host-orbit_oauth';
/* Kimliği doğrulanmış ama henüz adını seçmemiş kişinin bileti. Ayrı bir çerez,
 * çünkü taşıdığı yetki de ayrı: oturum çerezi "bu hesabın sahibiyim" der, bu
 * çerez yalnız "şu sağlayıcı hesabının sahibi olduğumu az önce kanıtladım"
 * der. İkisi karışırsa, hesabı olmayan biri hesap sahibinin yollarına
 * girebilir. */
export const SIGNUP_COOKIE = '__Host-orbit_signup';
export const CSRF_HEADER = 'X-Orbit-CSRF';

export const TOKEN_HASH_VERSION = 1;

/* Burada bir `REQUIRED_SECRET_BINDINGS` listesi vardı ve silindi.
 *
 * Hiçbir yerden kullanılmıyordu — ilk kimlik commit'inde doğdu, hiç okunmadı.
 * Zorunlu bağlamaların tek gerçek yeri `bindings.ts` içindeki
 * `assertIdentityBindings`; yeni bir sır eklerken bakılacak yer orası.
 *
 * Silinmesinin sebebi ölü kod olması değil, KAPI GİBİ GÖRÜNMESİYDİ. Adı bir
 * güvence vaat ediyordu ve o vaat kayda bile geçmişti ("şu sır bu listede
 * değil, bilerek") — oysa listeye girmek de girmemek de hiçbir şeyi
 * değiştiriyordu. Üstelik çürümüştü: `ORBIT_CURSOR_PEPPER_V1` çalışma
 * zamanında zorunluyken bu listede hiç yoktu. Kimsenin okumadığı bir liste
 * sessizce yanlışa kayar, ve yanlış olduğu gün ona güvenen biri çıkar. */
