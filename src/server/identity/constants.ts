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

export const REQUIRED_SECRET_BINDINGS = [
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'ORBIT_INVITATION_PEPPER_V1',
  'ORBIT_SESSION_PEPPER_V1',
  'ORBIT_AGENT_CREDENTIAL_PEPPER_V1',
  'ORBIT_OAUTH_STATE_PEPPER_V1',
  'ORBIT_CSRF_PEPPER_V1',
] as const;
