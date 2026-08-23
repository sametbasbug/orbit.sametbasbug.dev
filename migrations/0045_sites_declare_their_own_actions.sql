-- Siteler kendi işlemlerini kendileri bildirsin.
--
-- Orbit, bağlı sitelerdeki işlerin NE olduğunu bilmiyor. "Listeye anime ekle"
-- burada tanımlı değil; Orbit yetkiyi tutuyor, imzalıyor ve taşıyor. İşlem
-- kataloğunu site kendi adresinde yayımlıyor ve Orbit onu okuyor.
--
-- Alternatifi her site özelliği için Orbit'e kod eklemekti. Beş sitede Orbit
-- her şeyi bilmek zorunda olan bir yere dönerdi ve her yeni site işlemi Orbit
-- dağıtımı beklerdi.
--
-- NULL = site ajan eylemi sunmuyor. Bağlı olan her siteyi eylem sunuyor
-- saymak, olmayan bir dosyayı her katalog isteğinde aramak olurdu.
ALTER TABLE oauth_clients ADD COLUMN actions_url TEXT;

-- İsteğin gideceği adres. KATALOG DOSYASINDAN DEĞİL buradan okunuyor.
--
-- İlk tasarımda endpoint'i katalog dosyası bildiriyordu ve Orbit onu kayıtlı
-- alan adıyla karşılaştırıyordu. İki sorun: (1) katalog dosyası siteye ait ama
-- Orbit'in ağından çıkacak isteğin adresini belirlemiş oluyordu, (2) kural
-- Rota'yı reddediyordu — katalog GitHub Pages'te, yazma ucu Supabase'de, farklı
-- alan adları. İkisini de çözen yer burası: adres kayıt anında, platform
-- sahibi tarafından veriliyor ve site sonradan değiştiremiyor.
ALTER TABLE oauth_clients ADD COLUMN actions_endpoint TEXT;

-- Adres https olmak zorunda; yerel geliştirme dışında istisna yok.
-- SQLite ALTER TABLE ile CHECK eklenemediği için kontrol trigger'da, ve
-- INSERT ile UPDATE ayrı ayrı yazılıyor — SQLite tek trigger'da ikisini
-- birden kapsamıyor.
--
-- Bu yalnız birinci savunma. Adresin KAYITLI SİTEYE ait olduğu ayrıca kodda
-- doğrulanıyor: katalog dosyası Orbit'i keyfi bir adrese istek atmaya ikna
-- edememeli.
CREATE TRIGGER oauth_clients_actions_insert_https
BEFORE INSERT ON oauth_clients
BEGIN
  SELECT RAISE(ABORT, 'oauth_client_actions_url_insecure')
  WHERE NEW.actions_url IS NOT NULL
    AND NEW.actions_url NOT LIKE 'https://%'
    AND NEW.actions_url NOT LIKE 'http://localhost%';

  SELECT RAISE(ABORT, 'oauth_client_actions_endpoint_insecure')
  WHERE NEW.actions_endpoint IS NOT NULL
    AND NEW.actions_endpoint NOT LIKE 'https://%'
    AND NEW.actions_endpoint NOT LIKE 'http://localhost%';

  -- İkisi birlikte anlamlı: katalog var ama gidilecek adres yoksa ajan
  -- yapabileceği işleri görür ve hiçbirini çalıştıramaz.
  SELECT RAISE(ABORT, 'oauth_client_actions_incomplete')
  WHERE (NEW.actions_url IS NULL) <> (NEW.actions_endpoint IS NULL);
END;

CREATE TRIGGER oauth_clients_actions_update_https
BEFORE UPDATE OF actions_url, actions_endpoint ON oauth_clients
BEGIN
  SELECT RAISE(ABORT, 'oauth_client_actions_url_insecure')
  WHERE NEW.actions_url IS NOT NULL
    AND NEW.actions_url NOT LIKE 'https://%'
    AND NEW.actions_url NOT LIKE 'http://localhost%';

  SELECT RAISE(ABORT, 'oauth_client_actions_endpoint_insecure')
  WHERE NEW.actions_endpoint IS NOT NULL
    AND NEW.actions_endpoint NOT LIKE 'https://%'
    AND NEW.actions_endpoint NOT LIKE 'http://localhost%';

  SELECT RAISE(ABORT, 'oauth_client_actions_incomplete')
  WHERE (NEW.actions_url IS NULL) <> (NEW.actions_endpoint IS NULL);
END;
