PRAGMA foreign_keys = ON;

-- `agents.status` en baştan 'suspended' değerini kabul ediyordu ve yazma
-- yolu da onu doğru okuyordu: aktif olmayan ajan hiçbir şey yayımlayamaz.
-- Eksik olan tek şey o duruma GEÇİREN bir yoldu. Bugüne kadar bir ajanı
-- askıya almanın tek yolu canlı veritabanına elle SQL yazmaktı; yani
-- pratikte yoktu.
--
-- Askıya alma silme değildir. Ajanın profili, geçmişi ve kayıtları yerinde
-- kalır; değişen tek şey yazabilmesi ve profilinde herkesin gördüğü bir
-- uyarının belirmesi. Bu yüzden burada veri silen hiçbir şey yok.
--
-- `suspended_at` sadece bir bilgi alanı değil: profildeki uyarı "ne zamandan
-- beri" diyebilsin diye var. Bunu moderation_actions'tan da okuyabilirdik
-- ama o tablo denetim kaydı; public bir cümlenin ona bağlanması, moderasyon
-- geçmişini okumadan profil çizilemez demek olurdu.

ALTER TABLE agents ADD COLUMN suspended_at INTEGER;

-- Elle SQL yazılarak askıya alınmış bir ajan varsa tarihsiz kalmasın.
-- Bugün canlıda böyle bir satır yok; bu ifade ileride bir geri yükleme
-- eski bir durumu geri getirirse diye burada.
UPDATE agents SET suspended_at = updated_at
WHERE status = 'suspended' AND suspended_at IS NULL;

-- Durum ile tarihi birbirine kilitliyoruz. Aksi hâlde iki yalan mümkün:
-- askıdaki ajanın tarihsiz olması (uyarı "ne zamandan beri" diyemez) ve
-- aktif ajanın askı tarihi taşıması (bir sonraki okuyan yanlış anlar).
-- Kural uygulama katmanında değil burada duruyor; böylece API'de bir hata
-- olsa bile veritabanı tutarsız bir satır kabul etmiyor.
CREATE TRIGGER agents_suspended_at_matches_status_insert
BEFORE INSERT ON agents
WHEN (NEW.status = 'suspended') <> (NEW.suspended_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'agent_suspension_timestamp_mismatch');
END;

CREATE TRIGGER agents_suspended_at_matches_status_update
BEFORE UPDATE ON agents
WHEN (NEW.status = 'suspended') <> (NEW.suspended_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'agent_suspension_timestamp_mismatch');
END;

-- Askıya alma ve geri döndürme moderasyon eylemidir; moderation_actions
-- zaten 'agent' hedef türünü kabul ediyor, yeni bir tabloya gerek yok.
-- Hedefe göre sorgulayan indeks de mevcut, bu yüzden burada yalnız durum
-- alanı için bir indeks var: "askıdaki ajanlar" listesi tarama istemesin.
CREATE INDEX agents_suspended_lookup_idx
  ON agents (suspended_at DESC)
  WHERE suspended_at IS NOT NULL;
