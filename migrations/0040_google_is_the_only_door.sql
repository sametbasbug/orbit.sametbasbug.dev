-- GitHub'ın kaldırılması. 0039'un açtığı geçişin kapanışı.
--
-- 0039 sağlayıcı listesini genişletmişti ve gerekçesi orada yazılı: liste
-- geçişin mekanizmasıydı, bir karar değil. Üç hesap da Google kimliğini
-- bağladı, yani GitHub'ın taşıdığı tek iş bitti.

PRAGMA foreign_keys = ON;

-- Ön koşul: KULLANILAN bir hesap anahtarsız kalmamalı.
--
-- Bu göçün tek gerçek riski bu. GitHub satırları silinirken Google kimliği
-- olmayan bir hesap varsa o hesabın hiçbir anahtarı kalmıyor — kimse
-- giremiyor ve kurtarma yolu yok, çünkü Orbit'te şifre diye bir şey yok.
-- Kontrol uygulamada değil göçün kendisinde: göç bir kez çalışıyor ve yanlış
-- çalıştığında geri dönüş elle veri yazmaktan geçiyor.
--
-- Koşuldaki `last_login_at IS NOT NULL` süzgeci gevşetme değil, kapsamın
-- kendisi. 0005 sahip hesabını bir GitHub kimliğiyle birlikte KURUYOR ve o
-- migration yayımlanmış, değiştirilemez — yani sıfırdan kurulan her
-- veritabanında (yerel geliştirme, test, yarın açılacak yeni bir ortam)
-- Google kimliği olmayan bir GitHub satırı bulunuyor. O satır bir fikstür:
-- arkasında kilitlenecek bir insan yok ve hiç giriş yapılmamış. Gerçek bir
-- hesabın ise ilk girişinde `last_login_at` yazılıyor.
--
-- Yani sorulan soru "GitHub satırı var mı" değil, olması gereken soru:
-- birinin gerçekten girdiği bir hesabı anahtarsız bırakıyor muyum. Canlıda
-- üç hesabın üçü de girmiş ve üçünün de Google kimliği var; koşul orada
-- tam gücüyle çalışıyor.
--
-- Hiç kimliği olmayan hesaplar zaten kapsam dışı: onlar bir sağlayıcıyla
-- ilişkili değil, sildiğimiz satır onlara ait değil.
--
-- SQLite'ta trigger dışında RAISE yok; koşulu bir CHECK'e taşımak, "tutmuyorsa
-- göç ilerlemesin" demenin buradaki tek düz yolu. 0039'da da aynı kalıp var.
CREATE TABLE google_migration_precondition (ok INTEGER NOT NULL CHECK (ok = 1));

INSERT INTO google_migration_precondition (ok)
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM auth_identities gh
  JOIN accounts a ON a.id = gh.account_id
  WHERE gh.provider = 'github'
    AND a.last_login_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM auth_identities gg
      WHERE gg.account_id = gh.account_id AND gg.provider = 'google'
    )
) THEN 0 ELSE 1 END;

DROP TABLE google_migration_precondition;

-- Kısıt yeniden daralıyor, tablo yine yeniden kuruluyor. Sebep 0039'daki ile
-- aynı: SQLite bir CHECK'i yerinde değiştiremiyor. Tablo hâlâ bir ÇOCUK —
-- accounts'a referans veriyor, ona referans veren yok — o yüzden DROP +
-- RENAME sırasında başka hiçbir yabancı anahtar yeniden yazılmıyor.
--
-- `provider` sütunu duruyor, tek değerli olmasına rağmen. Silmek bugünü
-- doğru anlatırdı ama Orbit'in gittiği yer belli: kendisi kimlik sağlayıcısı
-- olacak ve ikinci bir sağlayıcı eklenirse sütun geri gelmek zorunda. Sütunu
-- tutup kısıtı daraltmak, ikisini de söylüyor — bugün tek kapı var, yarın
-- başka bir kapı eklemek şema değişikliği ama tablo yeniden kurulumu değil.
--
-- GitHub satırları ayrıca DELETE edilmiyor: aşağıdaki SELECT onları hiç
-- almıyor. Aynı sonuç, tek adım.
CREATE TABLE auth_identities_rebuilt (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL CHECK (provider = 'google'),
  provider_user_id TEXT NOT NULL,
  provider_login_snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  provider_email_snapshot TEXT,
  UNIQUE (provider, provider_user_id),
  UNIQUE (account_id, provider)
);

INSERT INTO auth_identities_rebuilt (
  id, account_id, provider, provider_user_id, provider_login_snapshot,
  created_at, last_seen_at, provider_email_snapshot
)
SELECT
  id, account_id, provider, provider_user_id, provider_login_snapshot,
  created_at, last_seen_at, provider_email_snapshot
FROM auth_identities
WHERE provider = 'google';

DROP TABLE auth_identities;

ALTER TABLE auth_identities_rebuilt RENAME TO auth_identities;
