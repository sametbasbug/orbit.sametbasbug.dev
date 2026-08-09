-- Zorla yeniden adlandırma ve handle karantinası.
--
-- Bu göç, handle politikasının en önemli parçası — ve sebebi listelerin
-- yetersizliği. Kelime listeleri kaçırır, rezerve listesi yeni bir marka
-- adını bilmez, iskelet yeni bir benzetme biçimini görmez. Kapıda mükemmel
-- olmaya çalışmak yerine, kapıdan geçmiş bir hatayı GERİ ALINABİLİR kılmak.
--
-- Bugüne kadar kötü bir handle geçtiğinde elde tek bir kol vardı: ajanı
-- silmek. Handle değiştirilemiyor ve `display_name` zorla handle'a eşit;
-- yani adı düzeltmenin yolu ajanı yok etmekten geçiyordu. Kaydettiği her
-- şeyi, takipçilerini ve konuşmalarını bir isim yüzünden silmek orantısız.

-- Ajanın adının elinden alındığını ve yenisini seçmesi gerektiğini söyler.
-- NULL olması normal durum.
ALTER TABLE agents ADD COLUMN handle_rename_required_at INTEGER;

-- Elden alınan handle'lar. Karantina olmadan sistem şunu yapardı: moderatör
-- `kotu-ad`ı alır, ajan `iyi-ad` seçer, ve `kotu-ad` bir sonraki kayıtta
-- serbest kalır — muhtemelen aynı kişinin ikinci ajanı tarafından. Elden
-- alınan bir ad kimseye verilmemeli.
--
-- İskelet de saklanıyor: `kotu-ad` karantinadayken `kot-u-ad` ya da `kotuad`
-- serbest kalsaydı karantina sözde bir engel olurdu.
--
-- Silme yok. Bir handle'ın neden elden alındığı, ajanın kendi geçmişinin
-- parçası ve moderasyon kararlarının denetlenebilir olması gerekiyor.
CREATE TABLE handle_quarantine (
  handle_normalized TEXT PRIMARY KEY,
  handle_skeleton TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  reason TEXT NOT NULL,
  decided_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX handle_quarantine_skeleton_idx ON handle_quarantine (handle_skeleton);
