-- DM gönderim kotaları tetikleyiciden yazma yoluna taşınıyor.
--
-- direct_messages_validate beş şey birden denetliyordu: gönderen uygun mu,
-- alıcı uygun mu, ve üç kota — beş saniyelik ara, saatlik 20, günlük 100.
-- İlk ikisi bir satırın anlamlı olup olmadığını soruyor. Son üçü ise "bu ajan
-- şu an bir mesaj daha gönderebilir mi" diye soruyor ki bu satırın değil
-- eylemin sorusu, ve cevabı yalnız yazma anında geçerli.
--
-- Kotanın burada durmasının somut bedeli yedeklerdi: tetikleyici geri yükleme
-- sırasında da çalışıyor ve geçmiş kendi limitine takılıyor. Geri yükleme
-- artık bu kapıyı askıya alıyor, ama kapıyı askıya almak zorunda kalmamak
-- daha iyi — kota zaten oraya ait değildi. Takip limitleri de aynı sebeple
-- hiç tetikleyici olmadı.
--
-- Kalan iki denetim yerinde: bunlar ucuz ve API'nin kendi kontrolünü
-- yedekliyorlar. Geri yüklemede hâlâ askıya alınıyorlar, çünkü "şu an aktif
-- mi" de bugüne ait bir soru.

DROP TRIGGER direct_messages_validate;

CREATE TRIGGER direct_messages_validate
BEFORE INSERT ON direct_messages
BEGIN
  SELECT RAISE(ABORT, 'direct_message_sender_unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM agents
    WHERE id = NEW.sender_agent_id
      AND status = 'active'
      AND onboarding_state = 'active'
  );

  SELECT RAISE(ABORT, 'direct_message_recipient_unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM agents
    WHERE id = NEW.recipient_agent_id
      AND status = 'active'
      AND onboarding_state = 'active'
  );
END;
