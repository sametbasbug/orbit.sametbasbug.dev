import type { ProviderProfileSnapshot } from '../repositories/identity-repository';

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

interface GoogleUserInfoResponse {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string | null;
  picture?: string | null;
}

async function googleJson<T>(response: Response, errorCode: string): Promise<T> {
  if (!response.ok) throw new Error(`${errorCode}:${response.status}`);
  return await response.json() as T;
}

export class GoogleClient {
  readonly #config: GoogleClientConfig;
  readonly #fetch: typeof fetch;

  constructor(config: GoogleClientConfig, fetchImpl?: typeof fetch) {
    this.#config = config;
    this.#fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  authorizationUrl(state: string, challenge: string): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', this.#config.clientId);
    url.searchParams.set('redirect_uri', this.#config.callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    /* openid email profile — üçü de Google'ın "hassas" saymadığı kapsamlar,
     * yani ek bir inceleme kapısı açmıyorlar. Kapsam genişlerse gizlilik
     * metni de değişmeli; site testi ikisini birbirine bağlıyor.
     *
     * `email`, kimlik tespiti için değil: kimliği sayısal `sub` taşıyor ve o
     * hiç değişmiyor. Adres, kullanıcıya hesap, güvenlik, moderasyon ve yasal
     * bildirim gönderebilmek için. */
    url.searchParams.set('scope', 'openid email profile');
    /* Tarayıcısında birden fazla Google hesabı açık olan çok insan var ve
     * Google sessizce sonuncusunu seçebiliyor. Orbit hesabı bir kez hangi
     * Google hesabına bağlandıysa ona bağlı kalıyor; yanlış hesapla açılmış
     * bir hesabı düzeltmenin ucuz bir yolu yok. Bu yüzden seçim ekranını her
     * seferinde gösteriyoruz — bir tık, geri alınamayan bir hatadan iyi. */
    url.searchParams.set('prompt', 'select_account');
    /* Yenileme jetonu istemiyoruz. Google'a yalnız girişin o anında bir kez
     * soruyoruz; kullanıcı adına sonradan bir şey okuyacak değiliz. İstenmemiş
     * bir yenileme jetonu, saklanması ve iptal edilmesi gereken fazladan bir
     * sırdan başka bir şey olmazdı. */
    url.searchParams.set('access_type', 'online');
    return url.toString();
  }

  async exchangeCode(code: string, verifier: string): Promise<string> {
    /* Gövde form kodlu, JSON değil. GitHub ikisini de kabul ediyor, Google
     * yalnız form kodluyu; JSON gönderirsen `invalid_request` dönüyor ve hata
     * mesajı sebebi söylemiyor. İki sağlayıcının istemcisi birbirine çok
     * benzediği için bu satır kopyalanırken bozulmaya açık. */
    const body = new URLSearchParams({
      client_id: this.#config.clientId,
      client_secret: this.#config.clientSecret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: this.#config.callbackUrl,
    });
    const response = await this.#fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const payload = await googleJson<{
      access_token?: string;
      error?: string;
    }>(response, 'google_token_exchange_failed');
    if (!payload.access_token || payload.error) throw new Error('google_token_exchange_rejected');
    return payload.access_token;
  }

  /* Profil `userinfo` ucundan okunuyor, token cevabındaki `id_token`
   * çözülerek değil.
   *
   * İkisi de meşru: `id_token` token ucundan, TLS üzerinden, kendi
   * client_secret'ımızla doğrudan geldiği için OIDC onu imza doğrulaması
   * gerektirmeyen durum sayıyor. Ama "doğrulamadan güvendiğimiz bir JWT"
   * kodda durduğu sürece, ileride biri onu başka bir yerden gelen bir JWT'ye
   * bağlayabilir ve o an imza doğrulamasının yokluğu bir açık olur.
   *
   * `userinfo` bir ekstra istek karşılığında geriye çözülecek hiçbir şey
   * bırakmıyor: cevap ya erişim jetonuyla geldi ya gelmedi. */
  async currentUser(accessToken: string): Promise<ProviderProfileSnapshot> {
    const response = await this.#fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
    });
    return profileFromGoogle(
      await googleJson<GoogleUserInfoResponse>(response, 'google_userinfo_failed'),
    );
  }
}

function profileFromGoogle(body: GoogleUserInfoResponse): ProviderProfileSnapshot {
  const userId = typeof body.sub === 'string' ? body.sub.trim() : '';
  if (!userId) throw new Error('invalid_google_user_response');

  const address = typeof body.email === 'string' ? body.email.trim() : '';
  /* Katı olan tek şart `email_verified`. Doğrulanmamış bir kutuya bildirim
   * göndermek, adresi henüz sahiplenmemiş birine — yani başkasına — yazmak
   * riskini taşıyor. GitHub tarafında da kural buydu.
   *
   * Adresin yokluğu girişi düşürmüyor: adres bir kolaylık, kimlik değil.
   * Kimliği `sub` taşıyor. */
  const email = body.email_verified === true && address ? address.slice(0, 320) : null;

  /* `provider_login_snapshot` NOT NULL ve Google'da kullanıcı adı diye bir
   * şey yok. Sütunun işi kullanıcıya "hangi hesapla bağlısın" diye
   * gösterebilmek; bunu en iyi karşılayan alan adres. Adres yoksa geriye
   * `sub` kalıyor — insana bir şey söylemiyor ama sütunu boş bırakmaktan
   * iyi ve hangi hesap olduğunu tekil olarak yine tarif ediyor.
   *
   * Doğrulanmamış adres burada kullanılabiliyor, çünkü bu alan bir posta
   * kutusu değil bir etiket: buraya yazılan adrese hiçbir zaman posta
   * gitmiyor, posta yalnız `provider_email_snapshot`tan gidiyor. */
  const login = address || userId;

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const picture = typeof body.picture === 'string' && body.picture.trim() !== ''
    ? body.picture.trim()
    : null;

  return {
    userId,
    login,
    displayName: name || login,
    avatarUrl: picture,
    email,
  };
}
