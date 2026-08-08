-- Kapı açıldı; onay kayda geçiyor.
--
-- Davet sistemi kalktı. Davet, bir insanın bir insanı tanıyıp içeri
-- almasıydı ve o insan koşulları da anlatıyordu. O halka koptuğuna göre
-- koşulların okunduğunu söyleyen tek şey, kişinin kendi işaretlediği kutu.
-- Ve o kutunun bir kıymeti olması için işaretlendiğinin yazılı olması
-- gerekiyor: "kabul etti" diyemiyorsak, kutu yalnız bir süstür.

-- 1. Onay OAuth akışına yazılıyor.
--
-- Neden hesaba değil de önce akışa: kutu tarayıcıda işaretleniyor ve
-- tarayıcıdan gelen hiçbir şey kanıt değil. Akış satırı ise sunucuda
-- doğuyor — GitHub'a gitmeden ÖNCE, /v1/auth/github/start içinde. Dönüşte
-- bu satır boşsa giriş tamamlanmıyor. Yani onaysız bir turu tamamlamanın
-- yolu, sunucuda onaylı bir akış satırı uydurmaktan geçiyor ki mümkün değil.
--
-- Sürüm de yazılıyor: bugün kabul edilen metin ile yarın kabul edilecek
-- metin aynı olmayabilir ve "hangi metni kabul etti" sorusunun cevabı
-- sonradan üretilemez.
ALTER TABLE oauth_flows ADD COLUMN terms_accepted_at INTEGER;
ALTER TABLE oauth_flows ADD COLUMN terms_version TEXT;

-- 2. Onay hesaba taşınıyor.
--
-- Akış satırı bir gün sonra temizleniyor (OAUTH_FLOW_RETENTION_MS); kalıcı
-- cevap hesapta durmalı. Her girişte tazeleniyor, çünkü kutu her girişte
-- işaretleniyor: elimizdeki değer "bir zamanlar kabul etmişti" değil, "en
-- son ne zaman ve hangi sürümü kabul etti".
--
-- Mevcut hesaplarda NULL kalıyor ve geriye doldurulmuyor. Onlar davetle
-- geldi ve o dönemde böyle bir kutu yoktu; onlar adına bir onay yazmak,
-- olmayan bir imzayı kayda geçirmek olurdu. Bir sonraki girişlerinde kendi
-- işaretleriyle dolacak.
ALTER TABLE accounts ADD COLUMN terms_accepted_at INTEGER;
ALTER TABLE accounts ADD COLUMN terms_version TEXT;

-- İkisi birlikte anlamlı: tarihi olup sürümü olmayan bir satır, hangi
-- metnin kabul edildiğini söyleyemediği için hiçbir soruya cevap vermiyor.
CREATE TRIGGER accounts_terms_consent_is_complete_insert
BEFORE INSERT ON accounts
WHEN (NEW.terms_accepted_at IS NULL) <> (NEW.terms_version IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'account_terms_consent_incomplete');
END;

CREATE TRIGGER accounts_terms_consent_is_complete_update
BEFORE UPDATE ON accounts
WHEN (NEW.terms_accepted_at IS NULL) <> (NEW.terms_version IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'account_terms_consent_incomplete');
END;
