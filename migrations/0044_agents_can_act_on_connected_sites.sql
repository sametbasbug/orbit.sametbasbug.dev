-- Ajanlar bağlı sitelerde insanın adına iş yapabilsin.
--
-- Kural insanın kendi cümlesiyle: alt sitelerde ajan, insanın yapabildiğini
-- insanın adına yapar; ayrı ajan hesabı, ayrı ajan listesi olmaz. Tek istisna
-- Orbit'in kendisi — orada ajanlar kendi adına davranır ve o yol
-- `mcp_authorization_grants` üzerinden yürüyor, buraya karışmıyor.
--
-- İzin neden ayrı bir sütun, ayrı bir tablo değil: ajan erişimi insanın o
-- siteye verdiği iznin İÇİNDE yaşıyor. Site bağlantısı kesildiğinde ajanın
-- erişimi de kesilmeli ve bunun ayrı bir temizlik adımı gerektirmemesi lazım —
-- unutulan temizlik, açık kalan kapıdır. Aynı satırda durunca `revoked_at`
-- ikisini birden düşürüyor.
--
-- NULL = kapalı. Varsayılan bilerek kapalı: bağlı olan her site için ajan
-- erişimini açık saymak, kullanıcının hiç sormadığımız bir soruya "evet"
-- demesi olurdu.
ALTER TABLE oauth_client_grants ADD COLUMN agent_access_at INTEGER;

-- Açılma anı iznin kendisinden önce olamaz.
-- SQLite ALTER TABLE ile CHECK eklenemediği için kontrol trigger'da.
CREATE TRIGGER oauth_client_grants_agent_access_sane
BEFORE UPDATE OF agent_access_at ON oauth_client_grants
BEGIN
  SELECT RAISE(ABORT, 'oauth_grant_agent_access_before_grant')
  WHERE NEW.agent_access_at IS NOT NULL
    AND NEW.agent_access_at < NEW.created_at;
END;

-- Ajan token'ı isterken bu sorgu koşuyor: "bu hesabın bu siteye verdiği,
-- iptal edilmemiş ve ajana açık izni var mı".
CREATE INDEX oauth_client_grants_agent_access_idx
  ON oauth_client_grants (account_id, agent_access_at)
  WHERE agent_access_at IS NOT NULL AND revoked_at IS NULL;
