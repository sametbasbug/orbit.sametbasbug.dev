import type { GithubProfileSnapshot } from '../repositories/identity-repository';

export interface GithubClientConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

interface GithubUserResponse {
  id?: number;
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
}

interface GithubEmailResponse {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

async function githubJson<T>(response: Response, errorCode: string): Promise<T> {
  if (!response.ok) throw new Error(`${errorCode}:${response.status}`);
  return await response.json() as T;
}

export class GithubClient {
  readonly #config: GithubClientConfig;
  readonly #fetch: typeof fetch;

  constructor(config: GithubClientConfig, fetchImpl?: typeof fetch) {
    this.#config = config;
    this.#fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  authorizationUrl(state: string, challenge: string): string {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.#config.clientId);
    url.searchParams.set('redirect_uri', this.#config.callbackUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    /* user:email, kullanıcıya hesap, güvenlik, moderasyon ve yasal bildirim
     * gönderebilmek için. Kimlik tespiti için değil — onu zaten sayısal
     * GitHub kimliği taşıyor. Kapsam genişlerse gizlilik metni de değişmeli;
     * site testi ikisini birbirine bağlıyor. */
    url.searchParams.set('scope', 'read:user user:email');
    return url.toString();
  }

  async exchangeCode(code: string, verifier: string): Promise<string> {
    const response = await this.#fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'Equinox-Orbit-V6',
      },
      body: JSON.stringify({
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
        code,
        redirect_uri: this.#config.callbackUrl,
        code_verifier: verifier,
      }),
    });
    const body = await githubJson<{
      access_token?: string;
      error?: string;
    }>(response, 'github_token_exchange_failed');
    if (!body.access_token || body.error) throw new Error('github_token_exchange_rejected');
    return body.access_token;
  }

  async currentUser(accessToken: string): Promise<GithubProfileSnapshot> {
    const response = await this.#fetch('https://api.github.com/user', {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'Equinox-Orbit-V6',
        'x-github-api-version': '2022-11-28',
      },
    });
    const profile = profileFromGithub(await githubJson<GithubUserResponse>(response, 'github_user_failed'));
    return { ...profile, email: await this.#primaryEmail(accessToken) };
  }

  /* /user'ın email alanı yalnız kullanıcının herkese açık adresini döndürür
   * ve çoğu kişide boştur; gerçek adresler yalnız /user/emails ucunda.
   *
   * Seçim şu sırayla: önce doğrulanmış VE birincil olan, o yoksa herhangi
   * bir doğrulanmış adres. Birincil adres geçici olarak doğrulanmamış
   * olabilir (adres yeni değişmiş, doğrulama beklemede) ve o anda başka
   * doğrulanmış adresi varken hiç adres saklamamak, güvenlik bildirimi
   * gönderebileceğimiz tek kanalı kaybetmek olurdu.
   *
   * Katı olan tek şart `verified`. Doğrulanmamış bir kutuya bildirim
   * göndermek, adresi henüz sahiplenmemiş birine — yani başkasına — yazmak
   * riskini taşıyor.
   *
   * Bu çağrının düşmesi girişi düşürmez. Kullanıcı user:email iznini
   * vermemiş olabilir (403), GitHub o an cevap vermiyor olabilir. Adres bir
   * kolaylık; onun yokluğu yüzünden kimsenin giremediği bir sistem, adresin
   * kendisinden büyük bir arıza olurdu. */
  async #primaryEmail(accessToken: string): Promise<string | null> {
    try {
      const response = await this.#fetch('https://api.github.com/user/emails', {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${accessToken}`,
          'user-agent': 'Equinox-Orbit-V6',
          'x-github-api-version': '2022-11-28',
        },
      });
      if (!response.ok) return null;
      const rows = await response.json() as GithubEmailResponse[];
      if (!Array.isArray(rows)) return null;
      const usable = rows.filter((row) => row?.verified === true
        && typeof row.email === 'string'
        && row.email.trim() !== ''
        /* "E-posta adresimi gizli tut" açık olan kullanıcılarda listede bir
         * @users.noreply.github.com adresi bulunuyor ve doğrulanmış
         * görünüyor — hatta birincil olabiliyor. GitHub o adrese posta
         * teslim etmez. Saklarsak elimizde ulaşabildiğimizi sandığımız ama
         * ulaşamadığımız bir adres olur; üstelik her gönderim geri döner ve
         * geri dönen postalar gönderim itibarını bozarak gerçek adresi olan
         * kullanıcılara ulaşmamızı da engeller. */
        && !/@users\.noreply\.github\.com$/iu.test(row.email.trim()));
      const chosen = usable.find((row) => row.primary === true) ?? usable[0];
      const address = chosen?.email?.trim() ?? '';
      return address ? address.slice(0, 320) : null;
    } catch {
      return null;
    }
  }

  async resolveLogin(login: string): Promise<GithubProfileSnapshot> {
    const normalized = login.trim();
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(normalized)) {
      throw new Error('invalid_github_login');
    }
    const response = await this.#fetch(`https://api.github.com/users/${encodeURIComponent(normalized)}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'Equinox-Orbit-V6',
        'x-github-api-version': '2022-11-28',
      },
    });
    return profileFromGithub(await githubJson<GithubUserResponse>(response, 'github_login_resolution_failed'));
  }
}

function profileFromGithub(body: GithubUserResponse): GithubProfileSnapshot {
  if (!Number.isSafeInteger(body.id) || typeof body.login !== 'string' || !body.login) {
    throw new Error('invalid_github_user_response');
  }
  return {
    userId: String(body.id),
    login: body.login,
    displayName: body.name?.trim() || body.login,
    avatarUrl: body.avatar_url ?? null,
    /* resolveLogin başkasının herkese açık profilini çözüyor; oradan adres
     * almak ne mümkün ne de doğru. Adresi yalnız kendi hesabına giren
     * kullanıcı için, kendi izniyle alıyoruz. */
    email: null,
  };
}
