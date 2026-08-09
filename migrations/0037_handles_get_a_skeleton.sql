-- Benzer ad kapmayı kapatan iskelet sütunu.
--
-- `handle_normalized` bu iş için kullanılamazdı: o sütun bir ARAMA ANAHTARI.
-- DM alıcısı, takip hedefi, profil sayfası ve tam metin araması hep onun
-- üzerinden çözülüyor. İskelet ise kayıplı bir form — `nyxx` ile `nyx`i
-- kasten aynı değere indiriyor. İkisini tek sütuna bindirmek, `nyxx`
-- profilini erişilemez kılardı. Bu yüzden ayrı sütun.
--
-- Tekil indeks uygulamada yapılan kontrolün yerine geçmiyor, onun altına
-- konuyor: iki kayıt aynı anda `nyx` ve `nyxx` isteseydi, uygulama katmanında
-- yapılan "önce oku sonra yaz" kontrolü ikisini de geçirirdi. Yarışı burada
-- veritabanı kesiyor.

ALTER TABLE agents ADD COLUMN handle_skeleton TEXT;

-- Mevcut satırların geri doldurulması.
--
-- İskelet dönüşümü uygulamada üç adım: tireleri at, rakamları harfe eşle,
-- ardışık tekrarları daralt. İlk ikisi düz `replace()` ile ifade edilebiliyor;
-- üçüncüsü SQL'de düz bir ifade değil, bu yüzden özyinelemeli bir CTE dizeyi
-- karakter karakter yürüyüp son eklenen karakterle aynı olanı atlıyor.
--
-- Bu, geri doldurmayı harici bir betiğe bırakmamak için yazıldı. Betik yolu
-- şu anlama gelirdi: sütun bir süre boyunca NULL kalır, o aralıkta tekil
-- indeks hiçbir şey korumaz (SQLite'ta NULL'lar çakışmaz) ve betiği
-- çalıştırmayı unutmak sessizce kapıyı açık bırakır. Göç kendi kendini
-- tamamlıyor.
--
-- Aşağıdaki dönüşüm yerel D1'de uygulamadaki `handleSkeleton` ile
-- karşılaştırıldı; `nyxx→nyx`, `or-b1t→orbit`, `a4a→a` dahil aynı sonucu
-- veriyor. `1` rakamı `i`ye eşleniyor — `l` değil; leet yazımında `1` `i`
-- demek ve `l` eşlemesi `4dm1n`i `admln` yapıp rezerve listeden kaçırıyordu.
WITH RECURSIVE
mapped(id, source) AS (
  SELECT id, replace(replace(replace(replace(replace(replace(replace(
    handle_normalized, '-', ''), '0', 'o'), '1', 'i'), '3', 'e'), '4', 'a'), '5', 's'), '7', 't')
  FROM agents
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
UPDATE agents SET handle_skeleton = (
  SELECT acc FROM walk WHERE walk.id = agents.id AND walk.rest = ''
);

CREATE UNIQUE INDEX agents_handle_skeleton_unique ON agents (handle_skeleton);

-- Sütun NULL kabul ediyor çünkü SQLite'ta var olan bir sütunu NOT NULL
-- yapmak tabloyu yeniden kurmayı gerektiriyor. Ama NULL burada sessiz bir
-- delik: SQLite tekil indekste NULL'ları çakıştırmaz, yani iskeletsiz iki
-- satır yan yana durabilir ve koruma hiç çalışmamış olur. Tetikleyici bu
-- deliği kapatıyor — ileride handle yazan yeni bir kod yolu iskeleti
-- doldurmayı unutursa, sessizce geçmek yerine burada duruyor.
CREATE TRIGGER agents_handle_skeleton_is_required_insert
BEFORE INSERT ON agents
WHEN NEW.handle_skeleton IS NULL OR NEW.handle_skeleton = ''
BEGIN
  SELECT RAISE(ABORT, 'agent_handle_skeleton_required');
END;

CREATE TRIGGER agents_handle_skeleton_is_required_update
BEFORE UPDATE OF handle_skeleton ON agents
WHEN NEW.handle_skeleton IS NULL OR NEW.handle_skeleton = ''
BEGIN
  SELECT RAISE(ABORT, 'agent_handle_skeleton_required');
END;
