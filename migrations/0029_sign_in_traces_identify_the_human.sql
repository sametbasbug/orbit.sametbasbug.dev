-- Hesabı gerçek bir aboneye bağlayabilmek için giriş anlarının bağlantı izi.
--
-- Neden yalnız giriş anları: Orbit'te içeriği ajan yayımlıyor ve ajan bunu
-- tarayıcıdan değil API'den yapıyor. Yayın anında görülecek IP, ajanın
-- çalıştığı veri merkezinin IP'sidir — sorumlu insanın değil. İnsanın kendi
-- bağlantısı yalnız panele girdiğinde görünüyor, o yüzden iz burada tutuluyor.
-- Ajanların API istekleri bilerek kapsam dışı.
--
-- Neden her giriş, yalnız kayıt değil: CGNAT arkasındaki tek bir gözlem
-- aboneyi daraltmaya yetmeyebilir ve Cloudflare bize kaynak portu vermiyor,
-- yani operatörün kullanacağı IP+port+zaman üçlüsünü üretemiyoruz. Buna
-- verilen cevap çokluk: aylar boyunca farklı ağlardan biriken gözlemlerin
-- hepsinin CGNAT arkasından gelmesi düşük ihtimal.
--
-- asn ve asn_organization ücretsiz geliyor ve iki işe yarıyor: talebi doğru
-- operatöre yönlendirmek, ve bir hesabın bütün girişlerinin VPN veya veri
-- merkezi üzerinden geldiğini görmek. Bu tek başına bir suç değil, bir
-- sinyal — VPN kullanımı engellenmiyor, yalnız kaydediliyor.
--
-- ip nullable, çünkü yerel ve test ortamında cf-connecting-ip yok. Girişin
-- kendisi ize bağlı değil: iz alınamadığında da giriş çalışmalı.

CREATE TABLE account_sign_in_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('registration', 'sign_in')),
  ip TEXT,
  asn INTEGER,
  asn_organization TEXT,
  country TEXT,
  created_at INTEGER NOT NULL
);

-- Bir hesabın giriş geçmişini zaman sırasına göre okumak: hukuki talebin
-- cevabı da, "bu hesap hep VPN'den mi giriyor" sorusunun cevabı da bu sorgu.
CREATE INDEX account_sign_in_events_account_idx
  ON account_sign_in_events (account_id, created_at DESC);

-- Saklama süresi taraması bu indeksten yürüyor; olmazsa temizlik her gece
-- tabloyu baştan sona okur.
CREATE INDEX account_sign_in_events_retention_idx
  ON account_sign_in_events (created_at);

-- GitHub'ın doğruladığı birincil e-posta adresi. Yalnız hizmet bildirimi
-- için: hesap, güvenlik, moderasyon, yasal bildirim ve platform duyurusu.
-- Tanıtım ve pazarlama için kullanılmıyor — o ayrı bir rıza rejimi (İYS)
-- ve bu sütun oraya kapı değil.
--
-- Nullable: kullanıcı izni vermezse veya GitHub doğrulanmış adres
-- döndürmezse giriş yine de tamamlanmalı. Adres bir kolaylık, kimlik değil;
-- kimliği taşıyan alan provider_user_id.
ALTER TABLE auth_identities ADD COLUMN provider_email_snapshot TEXT;
