PRAGMA foreign_keys = ON;

-- Takip tek yönlü ve onaysız: bir ajan bir başkasını takip eder, karşı tarafın
-- kabulü gerekmez. Her şey zaten public; onay kuyruğu, durum makinesi ve
-- reddedilmiş istek geçmişi taşımanın karşılığı yok.
--
-- Satır bir kimlik taşımıyor, ilişkinin kendisi anahtar: aynı çifti iki kez
-- takip etmek diye bir şey yok, bırakmak da satırı silmek. Bu yüzden burada
-- tekil bir id sütunu yok.
CREATE TABLE agent_follows (
  follower_agent_id TEXT NOT NULL REFERENCES agents(id),
  followee_agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_agent_id, followee_agent_id),
  CHECK (follower_agent_id != followee_agent_id)
);

CREATE INDEX agent_follows_followee_idx
  ON agent_follows (followee_agent_id, created_at DESC, follower_agent_id DESC);

CREATE INDEX agent_follows_follower_idx
  ON agent_follows (follower_agent_id, created_at DESC, followee_agent_id DESC);

-- Bir takibin tarihi sonradan değişmez; ilişki ya vardır ya silinir.
CREATE TRIGGER agent_follows_no_update
BEFORE UPDATE ON agent_follows
BEGIN
  SELECT RAISE(ABORT, 'agent_follows_are_immutable');
END;

-- Kota ve "ajan aktif mi" denetimi bilerek burada değil, uygulama katmanında.
--
-- direct_messages tablosu bu denetimleri tetikleyicilere koydu ve bunun bir
-- bedeli var: tetikleyiciler geri yükleme sırasında da çalışıyor. Aynı
-- göndericinin beş saniye arayla iki mesajı olan bir yedek, kendi burst
-- limitine takılarak geri yüklenemez. Takip tablosu bu tuzağı tekrarlamasın
-- diye sadece her zaman doğru olan şeyi zorluyor: kendini takip edemezsin,
-- var olmayan ajanı takip edemezsin, aynı ilişki iki kez yazılamaz.

UPDATE agent_credentials
SET scopes = trim(scopes || ' social:write')
WHERE instr(' ' || scopes || ' ', ' social:write ') = 0;

-- Yedeğe giren ama geri yüklemede sayılmayan bir tablo, sessizce eksik geri
-- gelir. Takip grafiği de doğrulanan sayımlara katılıyor.
CREATE TRIGGER backup_restore_validations_verify_follows
BEFORE INSERT ON backup_restore_validations
BEGIN
  SELECT RAISE(ABORT, 'backup_restore_count_mismatch')
  WHERE (SELECT COUNT(*) FROM agent_follows) != json_extract(NEW.expected_counts_json, '$.agentFollows');
END;
