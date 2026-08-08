-- Giden posta kuyruğu ve kaydı.
--
-- Neden kuyruk, neden doğrudan gönderim değil: bir duyuru yayına
-- alındığında onlarca kişiye posta gidecek. Bunu istek içinde yapmak yayını
-- postanın hızına bağlar; Worker'ın istek yolunda waitUntil yok ve alt-istek
-- sınırları var. Satırlar yayınla AYNI batch'te yazılıyor — yayın
-- başarılıysa gönderilecekler kesin yazılmıştır, yayın düşerse ikisi de
-- düşer. "Yayımlandı ama kimseye haber verilmedi" hâli mümkün değil.
--
-- Tablo aynı zamanda kayıt: kime, ne zaman, hangi konuyla yazıldığı ve
-- sonucu burada duruyor. Bir güvenlik bildiriminin gönderildiğini
-- söyleyebilmek, gönderebilmek kadar önemli.

CREATE TABLE email_deliveries (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  -- Adres satıra kopyalanıyor, hesaptan okunmuyor: gönderim anında hangi
  -- adrese yazdığımız sonradan değişmemeli. Kullanıcı adresini
  -- değiştirdiğinde geçmiş kayıt yalan söylemeye başlardı.
  recipient TEXT NOT NULL,
  -- 'announcement' tercihe tabidir; 'moderation' ve 'security' değildir.
  -- Hesabınla ilgili bir karardan haberdar olmamayı seçemezsin.
  kind TEXT NOT NULL CHECK (kind IN ('announcement', 'moderation', 'security')),
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  -- Aynı olayın aynı kişiye iki kez yazılmasını veritabanı engelliyor.
  -- Uygulama katmanındaki bir kontrol, iki isteğin yarıştığı anda
  -- tutmazdı; burada tutuyor.
  subject_ref TEXT NOT NULL,
  UNIQUE (account_id, subject_ref)
);

-- Kuyruğu boşaltan işleyicinin tek sorgusu: en eski bekleyenler önce.
CREATE INDEX email_deliveries_pending_idx
  ON email_deliveries (status, created_at)
  WHERE status = 'pending';

CREATE INDEX email_deliveries_account_idx
  ON email_deliveries (account_id, created_at DESC);

-- Duyuru postalarını kapatabilmek yasal bir zorunluluk değil (bunlar hizmet
-- bildirimi, ticari ileti değil) ama kapatamadığı postayı insan spam
-- işaretler; o da gönderim itibarını bozarak GERÇEKTEN kritik bir bildirimi
-- göndermemiz gerektiğinde kimseye ulaşamamamıza yol açar. Anahtar bu yüzden
-- var. Varsayılan açık: haber almak istemediğini söyleyene kadar istiyorsun.
ALTER TABLE accounts ADD COLUMN announcement_emails_enabled INTEGER NOT NULL DEFAULT 1;
