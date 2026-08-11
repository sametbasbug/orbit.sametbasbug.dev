-- Orbit başka sitelerin giriş kapısı oluyor.
--
-- Bugüne kadar Orbit bir kimlik TÜKETİCİSİYDİ: Google'dan kim olduğunu öğrenip
-- kendi oturumunu kuruyordu. Bu göç onu bir kimlik SAĞLAYICISINA çeviriyor —
-- Anime sitesi gibi diğer Equinox siteleri kendi hesap sistemini kurmayacak,
-- kullanıcı orada "Orbit ile devam et"e basacak.
--
-- Tasarım kaydı: docs/FUTURE_PLANS.md Plan 008.
--
-- Neden MCP tablolarının üstüne kurulmuyor: `mcp_authorization_grants` bir
-- AJANA yetki veriyor ve satırı `agent_id` olmadan var olamıyor. Buradaki izin
-- bir SİTEYE kim olduğunu söylüyor ve ajanla hiç ilgisi yok — hesabın ajanı
-- olmasa da geçerli. İkisini tek tabloya sıkıştırmak, her sorguya "bu satır
-- hangi cinsten" sorusunu eklemek ve iki özelliğin tetikleyicilerini
-- birbirine dolaştırmak olurdu.

PRAGMA foreign_keys = ON;

-- 1. Bağlanacak siteler.
--
-- Dinamik kayıt yok: site sayısı beş ve istemciler operatör eliyle giriliyor.
-- Kendi kendine kaydolabilen bir istemci yüzeyi, onay ekranında rastgele bir
-- ismin görünmesine izin vermek demekti.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE CHECK (length(trim(client_id)) BETWEEN 8 AND 255),
  secret_digest TEXT NOT NULL,
  hash_version INTEGER NOT NULL CHECK (hash_version > 0),
  -- Onay ekranında kullanıcının göreceği ad. "Anime sitesi" gibi.
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  site_url TEXT NOT NULL CHECK (site_url LIKE 'https://%' OR site_url LIKE 'http://localhost%'),
  -- İzin verilen kapsamların ÜST SINIRI, boşlukla ayrılmış.
  --
  -- Neden bir CHECK listesi değil: 0022 kapsamı `CHECK (scopes = 'feed:read')`
  -- diye çivilemişti ve kapsam ikinci kez genişlediğinde tabloyu yeniden kurmak
  -- gerekti (0024, 0025). Yayımlanmış bir migration değiştirilemediği için o
  -- bedel her genişlemede tekrar ödeniyor. Kapsam listesinin doğrulaması bu
  -- yüzden kodda: `site-authorization-scopes.ts`.
  allowed_scopes TEXT NOT NULL CHECK (length(trim(allowed_scopes)) BETWEEN 6 AND 500),
  environment TEXT NOT NULL CHECK (environment IN ('production', 'development')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE INDEX oauth_clients_status_idx ON oauth_clients (status, created_at DESC);

-- 2. Yönlendirme adresleri.
--
-- Bu tablonun tek işi açık yönlendiriciyi engellemek. Adres tam eşleşiyor;
-- joker, önek eşleşmesi veya "aynı alan adı olsun yeter" yok. Gevşek bir
-- eşleşme, kullanıcının Orbit'te verdiği onayın karşılığındaki anahtarın
-- saldırganın seçtiği adrese gitmesi demek.
CREATE TABLE oauth_client_redirect_uris (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  redirect_uri TEXT NOT NULL CHECK (
    length(redirect_uri) BETWEEN 8 AND 500
    -- Parça (#fragment) taşıyan adres yok: yönlendirme parametrelerini
    -- fragment'a yazmak onları sunucuya hiç ulaşmayan bir yere koyar.
    AND instr(redirect_uri, '#') = 0
  ),
  created_at INTEGER NOT NULL,
  UNIQUE (client_id, redirect_uri)
);

-- `http://localhost` yalnız development istemcisinde. İstemcinin ortamı başka
-- bir tabloda olduğu için bu bir CHECK ile yazılamıyor; tetikleyici gerekiyor.
CREATE TRIGGER oauth_client_redirect_uris_scheme_insert
BEFORE INSERT ON oauth_client_redirect_uris
BEGIN
  SELECT RAISE(ABORT, 'oauth_redirect_uri_insecure')
  WHERE NOT EXISTS (
    SELECT 1
    FROM oauth_clients client
    WHERE client.id = NEW.client_id
      AND (
        NEW.redirect_uri LIKE 'https://%'
        OR (client.environment = 'development' AND NEW.redirect_uri LIKE 'http://localhost%')
      )
  );
END;

-- 3. Site başına kullanıcı kimliği.
--
-- Alt siteye giden `sub` claim'i budur ve `accounts.id` DEĞİLDİR. Her istemci
-- aynı insanı farklı bir kimlikle görüyor.
--
-- Dürüst sınır: e-posta her siteye verildiği için siteler kullanıcıyı adres
-- üzerinden yine eşleştirebilir, yani buradaki kazanç gizlilik değil. Kazanç
-- iç kimliklerimizin dışarı hiç çıkmaması: `accounts.id` bir kez dağıldıktan
-- sonra geri toplanamaz ve bir gün başka bir yerde anahtar olarak kullanılır.
CREATE TABLE oauth_client_subjects (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  subject TEXT NOT NULL UNIQUE CHECK (length(subject) BETWEEN 16 AND 64),
  created_at INTEGER NOT NULL,
  UNIQUE (client_id, account_id)
);

-- 4. Kullanıcının bir siteye verdiği izin.
--
-- Onayın kaydı bu satır. Kullanıcı panelde "bağlı siteler"i buradan görüyor ve
-- iptal buradan yürüyor. İstemci + hesap başına tek satır: aynı siteye ikinci
-- kez giriş yeni bir izin doğurmuyor, mevcut izni tazeliyor.
CREATE TABLE oauth_client_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  scopes TEXT NOT NULL CHECK (length(trim(scopes)) BETWEEN 6 AND 500),
  -- Hangi onay metniyle verildi. "Bir zamanlar kabul etmişti" bir cevap değil;
  -- kapsam genişlediğinde kullanıcının yeniden onaylaması bu alana bakıyor.
  consent_version TEXT NOT NULL CHECK (length(trim(consent_version)) BETWEEN 1 AND 40),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT,
  UNIQUE (client_id, account_id),
  CHECK (updated_at >= created_at),
  CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR
    (
      revoked_at IS NOT NULL
      AND revoked_reason IS NOT NULL
      AND length(trim(revoked_reason)) BETWEEN 1 AND 120
    )
  )
);

CREATE INDEX oauth_client_grants_account_idx
  ON oauth_client_grants (account_id, revoked_at, created_at DESC);

CREATE INDEX oauth_client_grants_client_idx
  ON oauth_client_grants (client_id, revoked_at, created_at DESC);

-- İzin yalnız aktif hesaba ve aktif istemciye yazılabiliyor. MCP tarafındaki
-- `mcp_authorization_grants_validate` ile aynı gerekçe: kapıyı uygulama
-- katmanında tutmak, o kontrolü atlayan ikinci bir yazma yolunun eninde
-- sonunda yazılmasına güvenmek demek.
CREATE TRIGGER oauth_client_grants_validate
BEFORE INSERT ON oauth_client_grants
BEGIN
  SELECT RAISE(ABORT, 'oauth_grant_account_inactive')
  WHERE NOT EXISTS (
    SELECT 1 FROM accounts account
    WHERE account.id = NEW.account_id AND account.status = 'active'
  );

  SELECT RAISE(ABORT, 'oauth_grant_client_inactive')
  WHERE NOT EXISTS (
    SELECT 1 FROM oauth_clients client
    WHERE client.id = NEW.client_id AND client.status = 'active'
  );
END;

-- Kimin kime izin verdiği değişmez. Kapsam, kullanım ve iptal değişir.
CREATE TRIGGER oauth_client_grants_identity_immutable
BEFORE UPDATE OF id, client_id, account_id, created_at ON oauth_client_grants
BEGIN
  SELECT RAISE(ABORT, 'oauth_grant_identity_immutable');
END;

-- 5. Yetkilendirme kodu.
--
-- Tarayıcıdan geçen tek kullanımlık, 60 saniyelik parça. Sırrın kendisi
-- saklanmıyor, digest'i saklanıyor.
CREATE TABLE oauth_authorization_codes (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_client_grants(id),
  code_digest TEXT NOT NULL UNIQUE,
  hash_version INTEGER NOT NULL CHECK (hash_version > 0),
  -- Kod hangi adrese verildiyse yalnız o adresle takas edilebilir. Bu alan
  -- olmadan, izinli adreslerden birine verilen kod başka birine taşınabilirdi.
  redirect_uri TEXT NOT NULL,
  -- PKCE: kodu kim istediyse yalnız o takas edebilsin. Supabase tarafı bu
  -- akışı zaten PKCE ile kuruyor.
  pkce_challenge TEXT NOT NULL CHECK (length(pkce_challenge) BETWEEN 43 AND 128),
  -- `nonce` opsiyonel bir süs değil: Supabase custom OIDC sağlayıcısı
  -- varsayılan olarak nonce doğruluyor. İstemci gönderdiyse ID token'a
  -- birebir yazılmak zorunda.
  nonce TEXT CHECK (nonce IS NULL OR length(nonce) BETWEEN 8 AND 200),
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX oauth_authorization_codes_grant_idx
  ON oauth_authorization_codes (grant_id, created_at DESC);
CREATE INDEX oauth_authorization_codes_expiry_idx
  ON oauth_authorization_codes (expires_at);

-- İptal edilmiş bir izne kod yazılamaz. Kullanıcı izni geri aldıktan sonra
-- üretilen bir kod, iptali sessizce geçersiz kılardı.
CREATE TRIGGER oauth_authorization_codes_validate
BEFORE INSERT ON oauth_authorization_codes
BEGIN
  SELECT RAISE(ABORT, 'oauth_code_grant_revoked')
  WHERE NOT EXISTS (
    SELECT 1 FROM oauth_client_grants grant_row
    WHERE grant_row.id = NEW.grant_id AND grant_row.revoked_at IS NULL
  );
END;

-- 6. Siteye verilen anahtarlar.
--
-- İki cins tek tabloda, çünkü ikisinin de yaşam döngüsü aynı: bir izne bağlı
-- doğuyor, süresi bitiyor, iptal ediliyor. Ayrı tablolar iptali iki yere
-- yazmak olurdu ve bir gün biri unutulurdu.
--
-- Erişim anahtarı 15 dakika yaşıyor. Sebep askıya alma: hesabı askıya
-- alındığında alt sitedeki oturumun en çok 15 dakika içinde ölmesi gerekiyor.
-- Alternatif her istekte Orbit'e sormaktı — daha doğru ama alt siteyi her
-- sayfa için Orbit'e bağımlı yapıyor.
CREATE TABLE oauth_site_tokens (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_client_grants(id),
  token_type TEXT NOT NULL CHECK (token_type IN ('access', 'refresh')),
  secret_digest TEXT NOT NULL UNIQUE,
  hash_version INTEGER NOT NULL CHECK (hash_version > 0),
  -- Rotasyon zinciri. Yenileme anahtarı her kullanımda yenisini doğuruyor ve
  -- eskisi burada yenisine işaret ediyor. Kullanılmış bir yenileme
  -- anahtarının ikinci kez gelmesi çalınmış olmasının işareti; o an bütün
  -- zincir düşüyor.
  replaced_by_id TEXT REFERENCES oauth_site_tokens(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT,
  CHECK (expires_at > created_at),
  CHECK (used_at IS NULL OR used_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR
    (
      revoked_at IS NOT NULL
      AND revoked_reason IS NOT NULL
      AND length(trim(revoked_reason)) BETWEEN 1 AND 120
    )
  ),
  -- Yalnız yenileme anahtarı yenisiyle değiştirilebilir.
  CHECK (replaced_by_id IS NULL OR token_type = 'refresh')
);

CREATE INDEX oauth_site_tokens_grant_idx
  ON oauth_site_tokens (grant_id, token_type, revoked_at, expires_at);
CREATE INDEX oauth_site_tokens_expiry_idx ON oauth_site_tokens (expires_at);

CREATE TRIGGER oauth_site_tokens_validate
BEFORE INSERT ON oauth_site_tokens
BEGIN
  SELECT RAISE(ABORT, 'oauth_token_grant_revoked')
  WHERE NOT EXISTS (
    SELECT 1 FROM oauth_client_grants grant_row
    WHERE grant_row.id = NEW.grant_id AND grant_row.revoked_at IS NULL
  );
END;

CREATE TRIGGER oauth_site_tokens_identity_immutable
BEFORE UPDATE OF id, grant_id, token_type, secret_digest, created_at, expires_at
ON oauth_site_tokens
BEGIN
  SELECT RAISE(ABORT, 'oauth_token_identity_immutable');
END;
