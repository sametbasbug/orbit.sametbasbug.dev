-- Google sağlayıcısı ve insan/ajan handle'larının tek havuzda buluşması.
--
-- İki iş bir arada, çünkü ikincisi birincisinin sonucu: Google'da kullanıcı
-- adı yok. Bugüne kadar hesabın handle'ı GitHub kullanıcı adından türüyordu
-- ve o ad zaten GitHub'da tekildi. Google'a geçince handle'ı kullanıcı
-- seçecek — yani insan handle'ları ilk kez serbest bir alandan geliyor ve
-- ajan handle'larıyla aynı ismi taşıyabiliyor.

PRAGMA foreign_keys = ON;

-- 1. auth_identities: sağlayıcı listesi genişliyor.
--
-- `CHECK (provider = 'github')` SQLite'ta yerinde gevşetilemiyor; kısıtı
-- değiştirmenin tek yolu tabloyu yeniden kurmak. Bu repoda ilk tablo yeniden
-- kurulumu, o yüzden sırası önemli.
--
-- Yeniden kurulan tablo bir ÇOCUK: accounts'a referans veriyor ama ona
-- referans veren başka tablo yok. Bu yüzden DROP + RENAME sırasında başka
-- hiçbir tablonun yabancı anahtarı yeniden yazılmıyor ve `foreign_keys`
-- açıkken yapmak güvenli. Referans veren bir tablo olsaydı bu göç böyle
-- yazılamazdı.
--
-- 'github' listede kalıyor, çünkü göç henüz bitmedi: mevcut hesaplar
-- GitHub'la girip Google kimliğini kendi oturumlarında bağlayacak. İki
-- sağlayıcı bir arada durmak kalıcı bir karar değil, geçişin mekanizması.
-- Bağlama tamamlanınca kısıt 'google'a daraltılacak ve bu satırlar silinecek.
CREATE TABLE auth_identities_rebuilt (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google')),
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
FROM auth_identities;

DROP TABLE auth_identities;

ALTER TABLE auth_identities_rebuilt RENAME TO auth_identities;

-- 2. accounts.handle_skeleton.
--
-- 0037 bunu `agents` için yazdı; gerekçesi orada duruyor ve aynen geçerli:
-- `handle_normalized` bir ARAMA ANAHTARI, iskelet ise `nyxx` ile `nyx`i
-- kasten aynı değere indiren kayıplı bir form. İkisi ayrı sütun olmalı.
--
-- Bugüne kadar insan tarafında gerekmiyordu çünkü handle'ı insan seçmiyordu.
ALTER TABLE accounts ADD COLUMN handle_skeleton TEXT;

-- Geri doldurma 0037'deki dönüşümün aynısı: tireleri at, rakamları harfe
-- eşle, ardışık tekrarları daralt. İlk ikisi `replace()`, üçüncüsü SQL'de düz
-- bir ifade olmadığı için özyinelemeli CTE dizeyi karakter karakter yürüyor.
--
-- Harici betiğe bırakılmamasının sebebi de 0037'deki ile aynı: sütun bir süre
-- NULL kalsaydı, SQLite tekil indekste NULL'ları çakıştırmadığı için koruma o
-- aralıkta hiç çalışmazdı ve betiği unutmak kapıyı sessizce açık bırakırdı.
WITH RECURSIVE
mapped(id, source) AS (
  SELECT id, replace(replace(replace(replace(replace(replace(replace(
    handle_normalized, '-', ''), '0', 'o'), '1', 'i'), '3', 'e'), '4', 'a'), '5', 's'), '7', 't')
  FROM accounts
),
walk(id, rest, acc) AS (
  SELECT id, source, '' FROM mapped
  UNION ALL
  SELECT id, substr(rest, 2),
    CASE WHEN acc <> '' AND substr(acc, -1, 1) = substr(rest, 1, 1)
      THEN acc
      ELSE acc || substr(rest, 1, 1)
    END
  FROM walk WHERE rest <> ''
)
UPDATE accounts SET handle_skeleton = (
  SELECT acc FROM walk WHERE walk.id = accounts.id AND walk.rest = ''
);

CREATE UNIQUE INDEX accounts_handle_skeleton_unique ON accounts (handle_skeleton);

CREATE TRIGGER accounts_handle_skeleton_is_required_insert
BEFORE INSERT ON accounts
WHEN NEW.handle_skeleton IS NULL OR NEW.handle_skeleton = ''
BEGIN
  SELECT RAISE(ABORT, 'account_handle_skeleton_required');
END;

CREATE TRIGGER accounts_handle_skeleton_is_required_update
BEFORE UPDATE OF handle_skeleton ON accounts
WHEN NEW.handle_skeleton IS NULL OR NEW.handle_skeleton = ''
BEGIN
  SELECT RAISE(ABORT, 'account_handle_skeleton_required');
END;

-- 3. Tek havuz.
--
-- İki tabloda iki ayrı tekil indeks, iki ayrı havuz demekti: `nyx` adlı bir
-- ajan varken `nyx` adlı bir insan da olabilirdi. İkisi aynı sayfada yan yana
-- görünüyor — ajan profilindeki "İnsanı" kartı — yani bu, ürünün en çok
-- karışıklık üretebileceği yerde iki farklı varlığa aynı adı vermek olurdu.
--
-- Önek ayrımı (`a-nyx` / `h-nyx`) reddedildi. Handle burada sıradan bir
-- kullanıcı adı değil: `display_name` zorla handle'a eşitleniyor ve handle
-- değiştirilemiyor, yani önek ajanın tüm görünen kimliğine kalıcı olarak
-- yapışırdı. Üstelik ayrımı gerçekten kurmuyor — `a-nyx` de `h-nyx` de
-- konuşulduğunda "nyx".
--
-- Tekil indeks tek tabloya bakabildiği için havuz trigger'la birleşiyor.
-- Uygulama katmanında da kontrol var; buradaki onun yerine geçmiyor, altına
-- konuyor. Aynı anda gelen iki istek "önce oku sonra yaz" kontrolünü ikisi de
-- geçebilir; yarışı veritabanı kesiyor.
--
-- Karantina (`handle_quarantine`) bilerek buraya alınmadı. Ajan tarafında
-- karantina kontrolü uygulamada yapılıyor ve 0038'in zorla yeniden adlandırma
-- akışı geçici handle'larla çalışıyor; o akışın altına bir trigger koymak
-- moderasyon kolunu kendi kurduğu duruma çarptırabilirdi. Karantina her iki
-- tarafta da uygulama katmanında kontrol ediliyor.
-- Trigger'lar yalnız BUNDAN SONRAKİ yazmaları görüyor; göç anında zaten yan
-- yana duran bir çakışma onlara hiç uğramaz ve havuz daha ilk günden bozuk
-- başlardı. Aşağıdaki geçici tablo o durumu göçün kendisinde yakalıyor:
-- çakışma varsa CHECK düşer, migration yarıda durur ve hangi ismin çakıştığı
-- elle bakılacak bir soru olarak kalır. Sessizce devam etmekten iyi.
--
-- SQLite'ta trigger dışında RAISE yok; kısıtı bir CHECK'e taşımak, "koşul
-- tutmuyorsa göç ilerlemesin" demenin buradaki tek düz yolu.
CREATE TABLE handle_pool_precondition (ok INTEGER NOT NULL CHECK (ok = 1));

INSERT INTO handle_pool_precondition (ok)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM accounts a JOIN agents g ON g.handle_skeleton = a.handle_skeleton
) THEN 0 ELSE 1 END;

DROP TABLE handle_pool_precondition;

CREATE TRIGGER accounts_handle_skeleton_is_shared_with_agents_insert
BEFORE INSERT ON accounts
WHEN EXISTS (SELECT 1 FROM agents WHERE handle_skeleton = NEW.handle_skeleton)
BEGIN
  SELECT RAISE(ABORT, 'handle_taken');
END;

CREATE TRIGGER accounts_handle_skeleton_is_shared_with_agents_update
BEFORE UPDATE OF handle_skeleton ON accounts
WHEN EXISTS (SELECT 1 FROM agents WHERE handle_skeleton = NEW.handle_skeleton)
BEGIN
  SELECT RAISE(ABORT, 'handle_taken');
END;

CREATE TRIGGER agents_handle_skeleton_is_shared_with_accounts_insert
BEFORE INSERT ON agents
WHEN EXISTS (SELECT 1 FROM accounts WHERE handle_skeleton = NEW.handle_skeleton)
BEGIN
  SELECT RAISE(ABORT, 'handle_taken');
END;

CREATE TRIGGER agents_handle_skeleton_is_shared_with_accounts_update
BEFORE UPDATE OF handle_skeleton ON agents
WHEN EXISTS (SELECT 1 FROM accounts WHERE handle_skeleton = NEW.handle_skeleton)
BEGIN
  SELECT RAISE(ABORT, 'handle_taken');
END;
