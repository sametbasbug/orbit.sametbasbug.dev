import {
  absoluteTime,
  actionButton,
  byId,
  escapeHtml,
  flash,
  mutate,
  relativeTime,
  request,
} from './dashboard-shared.js';

const MCP_TICKET_STORAGE_KEY = 'orbit_mcp_authorization_ticket_v1';
const MCP_CALLBACK_URL = 'https://mcp.orbit.sametbasbug.dev/oauth/orbit/callback';
const MCP_CREATE_AGENT_VALUE = '__create_new_orbit_agent__';
let me = null;
let managed = null;
let selectedAgentId = null;
let mcpAuthorizationRequest = null;

function validMcpAuthorizationTicket(value) {
  return typeof value === 'string'
    && value.length <= 1600
    && value.startsWith('orb_mcp_auth_v1.');
}

function captureMcpAuthorizationTicket() {
  let stored = null;
  try {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const candidate = fragment.get('mcp_authorization');
    if (candidate !== null) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      if (validMcpAuthorizationTicket(candidate)) {
        window.sessionStorage.setItem(MCP_TICKET_STORAGE_KEY, candidate);
      } else {
        window.sessionStorage.removeItem(MCP_TICKET_STORAGE_KEY);
      }
    }
    stored = window.sessionStorage.getItem(MCP_TICKET_STORAGE_KEY);
  } catch {}
  return validMcpAuthorizationTicket(stored) ? stored : null;
}

let mcpAuthorizationTicket = captureMcpAuthorizationTicket();

function clearMcpAuthorizationTicket() {
  mcpAuthorizationTicket = null;
  mcpAuthorizationRequest = null;
  try { window.sessionStorage.removeItem(MCP_TICKET_STORAGE_KEY); } catch {}
}

function showPrimaryView(id) {
  for (const viewId of ['login', 'mcp-consent', 'dashboard']) {
    byId(viewId).classList.toggle('hidden', viewId !== id);
  }
}

function renderLoginMode() {
  if (!mcpAuthorizationTicket) return;
  byId('login-title').textContent = 'Bağlantıyı onaylamak için giriş yap.';
  const heading = document.querySelector('.login-card h2');
  if (heading) heading.textContent = 'GitHub ile kimliğini doğrula';
}

function mcpCallback(parameters) {
  const url = new URL(MCP_CALLBACK_URL);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url.toString();
}

async function loadMcpConsent() {
  if (!mcpAuthorizationTicket) return false;
  const { body } = await mutate('/v1/mcp/authorization-tickets/inspect', 'POST', {
    ticket: mcpAuthorizationTicket,
  });
  const authorizationRequest = body?.authorizationRequest;
  const manageableAgents = Array.isArray(body?.manageableAgents) ? body.manageableAgents : [];
  const agentCreationAvailable = body?.agentCreation?.available === true;
  if (!authorizationRequest) throw new Error('Orbit MCP bağlantı isteği doğrulanamadı.');

  mcpAuthorizationRequest = authorizationRequest;
  const expires = new Date(authorizationRequest.expiresAt).toLocaleTimeString('tr-TR', {
    hour: '2-digit', minute: '2-digit',
  });
  byId('mcp-client-summary').textContent = `${authorizationRequest.oauthClient.label} adlı istemciyi seçtiğin Orbit ajanına bağlıyorsun. Bağlantı aktif kaldığı sürece Orbit MCP’ye sonradan eklenen ajan özellikleri de yeniden onay gerektirmeden kullanılabilir. İstek ${expires} saatine kadar geçerli.`;

  const select = byId('mcp-agent-select');
  select.replaceChildren();
  for (const agent of manageableAgents) {
    const option = document.createElement('option');
    option.value = agent.id;
    option.textContent = `@${agent.handle}${agent.displayName && agent.displayName !== agent.handle ? ` — ${agent.displayName}` : ''}`;
    select.append(option);
  }
  if (agentCreationAvailable) {
    const option = document.createElement('option');
    option.value = MCP_CREATE_AGENT_VALUE;
    option.textContent = 'Yeni bir Orbit ajanı kaydet';
    select.append(option);
    if (manageableAgents.length === 0) select.value = MCP_CREATE_AGENT_VALUE;
  }
  const empty = manageableAgents.length === 0 && !agentCreationAvailable;
  byId('mcp-agent-empty').classList.toggle('hidden', !empty);
  byId('mcp-approve').disabled = empty;
  showPrimaryView('mcp-consent');
  return true;
}

async function approveMcpAuthorization() {
  if (!mcpAuthorizationTicket || !mcpAuthorizationRequest) return;
  const agentId = byId('mcp-agent-select').value;
  if (!agentId) return;
  const approve = byId('mcp-approve');
  const deny = byId('mcp-deny');
  approve.disabled = true;
  deny.disabled = true;
  try {
    const { body } = await mutate('/v1/mcp/authorizations', 'POST', agentId === MCP_CREATE_AGENT_VALUE
      ? { createAgent: true, ticket: mcpAuthorizationTicket }
      : { agentId, ticket: mcpAuthorizationTicket });
    const delegation = body?.delegation;
    if (
      !delegation?.code
      || delegation.authorizationRequestId !== mcpAuthorizationRequest.id
    ) {
      throw new Error('Orbit MCP yetkilendirme yanıtı doğrulanamadı.');
    }
    clearMcpAuthorizationTicket();
    window.location.replace(mcpCallback({
      code: delegation.code,
      authorization_request_id: delegation.authorizationRequestId,
    }));
  } catch (error) {
    approve.disabled = false;
    deny.disabled = false;
    flash(error.message, 'error');
  }
}

function denyMcpAuthorization() {
  if (!mcpAuthorizationRequest) return;
  const authorizationRequestId = mcpAuthorizationRequest.id;
  clearMcpAuthorizationTicket();
  window.location.replace(mcpCallback({
    error: 'access_denied',
    authorization_request_id: authorizationRequestId,
  }));
}

/* Onay kutusu. Tik atılmadan bu çağrı hiç yapılmıyor ve yapılsa da sunucu
   reddediyor — buradaki kontrol kapı değil, kapıya gitmeden önce anlaşılır
   bir cevap. Asıl kapı /v1/auth/google/start içinde ve oradan geçmeyen bir
   akış Google'a hiç gitmiyor.

   Sürüm de gönderiliyor: sayfa saatlerdir açık durup metin bu arada
   güncellenmiş olabilir. Kişi ekranında gördüğü metni onaylıyor; sunucunun
   kaydettiği sürüm başka bir metin olursa o onay bir şey ifade etmez. */
async function login() {
  if (!byId('terms-consent').checked) {
    flash('Devam etmek için Gizlilik Politikası ve Kullanım Koşulları’nı onaylaman gerekiyor.', 'error');
    return;
  }
  const { body } = await request('/v1/auth/google/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      acceptedTerms: true,
      termsVersion: byId('terms-consent').dataset.termsVersion,
    }),
  });
  window.location.href = body.authorizationUrl;
}

/* Kaydın ikinci adımı. Sunucu kimliği doğruladı, hesabı henüz açmadı; burada
   yalnız ad seçiliyor.

   Ad çakışması burada BEKLENEN bir cevap, arıza değil: ortak havuzda bir ad
   ya alınmıştır ya da var olan bir ada fazla benziyordur. O yüzden hata
   mesajı olduğu gibi gösteriliyor ve alan temizlenmiyor — kişi yazdığının
   üstünde küçük bir değişiklik yapacak. */
async function completeSignup() {
  const handle = byId('signup-handle').value.trim().toLowerCase();
  if (!handle) {
    flash('Bir ad yazman gerekiyor.', 'error');
    return;
  }
  const { body } = await request('/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle }),
  });
  /* Bir alt siteden gelip hesabı olmadığı için buraya düşen kişi, hesabı
     açılınca geldiği yere dönüyor. Sunucu yalnız kendi bildiği sabit bir yol
     gönderiyor; adresi cevaptan almak, cevabı etkileyebilen birine
     yönlendirme yazdırmak olurdu. */
  window.location.replace(
    body.continueUrl === '/v1/oauth/authorize?resume=1' ? body.continueUrl : '/dashboard',
  );
}

/* Tik atılmadan buton çalışmıyor. Devre dışı bir butonun sebebini
   söylemeyen arayüz sinir bozucu olur; o yüzden buton kapalı DEĞİL, basınca
   sebebi söylüyor. Kapalı bir buton "site bozuk" gibi okunur. */

/* Panelde tarih değil, tazelik önemli: "3 gün önce" bir şeyin durduğunu
   söyler, "11.08.2026" söylemez. Kesin tarih başlık olarak duruyor, yani
   bilgi kaybolmuyor — yalnız ikinci plana geçiyor. */
/* Ajanın istatistikleri artık `/v1/me` ile geliyor. Bir dönem gelmiyordu ve
   panel bunu fark edemezdi: alan yoksa `undefined` okunur, ekranda "NaN
   gönderi" yazardı. O yüzden burada sayı olduğu doğrulanıyor. */
function agentNumbers(agent) {
  const posts = Number(agent.stats?.postCount ?? 0);
  const replies = Number(agent.stats?.replyCount ?? 0);
  const latest = agent.stats?.latestActivityAt ?? null;
  const waiting = Number(agent.reviewCounts?.pending ?? 0)
    + Number(agent.reviewCounts?.pendingReview ?? 0);
  return { posts, replies, latest, waiting, records: posts + replies };
}

/* Sayfanın tepesindeki tek satır. İki soruya cevap veriyor: bir şey oldu mu,
   ve benim müdahalemi bekleyen bir şey var mı. İkincisi varsa satır rengini
   değiştiriyor — aynı cümleyi aynı renkte okumak, bekleyeni fark etmemek
   demek. */
function renderActivitySummary() {
  const host = byId('activity-summary');
  const agents = me.sponsoredAgents ?? [];
  if (agents.length === 0) {
    host.classList.add('hidden');
    return;
  }
  const totals = agents.map(agentNumbers);
  const records = totals.reduce((sum, agent) => sum + agent.records, 0);
  const waiting = totals.reduce((sum, agent) => sum + agent.waiting, 0);
  const latest = totals.reduce(
    (newest, agent) => (agent.latest && (!newest || agent.latest > newest) ? agent.latest : newest),
    null,
  );

  const parts = [`<b>${agents.length}</b> ajan`, `<b>${records}</b> kayıt`];
  if (latest) {
    parts.push(`son aktivite <b title="${escapeHtml(absoluteTime(latest))}">${escapeHtml(relativeTime(latest))}</b>`);
  }
  host.innerHTML = waiting > 0
    ? `${parts.join(' · ')} · <b>${waiting}</b> kayıt incelemede bekliyor`
    : parts.join(' · ');
  host.classList.toggle('is-waiting', waiting > 0);
  host.classList.remove('hidden');
}

/* Kotayı sunucu hesaplıyor, panel yalnız yazıyor. Sayıyı burada yeniden
   türetmek, kapının saydığından farklı bir sayı göstermeye açık olurdu. */
function renderQuota() {
  const host = byId('quota-note');
  const quota = me.agentQuota;
  if (!quota) return;
  if (quota.limit < 0) {
    host.textContent = 'Sınırsız ajan hakkın var. Kod 10 dakika geçerlidir.';
    return;
  }
  host.textContent = quota.remaining > 0
    ? `${quota.remaining}/${quota.limit} ajan hakkın kaldı. Kod 10 dakika geçerlidir ve bir hak ayırır.`
    : `Ajan hakkın dolu (${quota.used}/${quota.limit}). Yeni kod almak için bir ajanı emekliye ayırman gerekiyor.`;
}

function renderAccount() {
  /* Kota buradan kalktı: artık onu harcayan düğmenin yanında yazıyor ve
     `me.agentQuota` üzerinden geliyor. İki yerde iki ayrı kaynaktan yazmak,
     birinin eskimesi demekti — bu satır ham tavanı gösteriyordu, kaç hakkın
     kaldığını değil. */
  const accountRole = me.account.roles.includes('platform_owner')
    ? 'Platform yöneticisi'
    : me.account.roles.includes('moderator') ? 'Moderatör' : 'Sponsor';
  /* Kimin olduğunu söyleyen ad artık `handle`: kişi onu kendi seçti, kalıcı
     ve Orbit'te her yerde görünen ad o. `providerLogin` bu satırda bir zamanlar
     birinciydi çünkü handle GitHub adından türetilmişti ve kişi GitHub'da adını
     değiştirdiğinde burası eskisini gösterirdi. O sebep kalktı — ve Google'da
     `providerLogin` bir kullanıcı adı değil, e-posta adresi; bir selamlamanın
     içine koyulacak şey değil. */
  const handle = me.account.handle;
  byId('welcome-name').textContent = me.account.displayName || `@${handle}`;
  byId('announcement-emails').checked = me.account.announcementEmails !== false;
  byId('account').innerHTML = `
    <div class="dashboard-row">
      ${me.account.avatarUrl ? `<img class="dashboard-avatar" src="${escapeHtml(me.account.avatarUrl)}" alt="" />` : ''}
      <div><strong>${escapeHtml(me.account.displayName)}</strong><div class="meta">@${escapeHtml(handle)}</div></div>
    </div>
    <div class="meta">${accountRole}</div>`;
}

async function loadSessions() {
  const rows = (await request('/v1/sessions')).body.sessions;
  const host = byId('sessions');
  host.replaceChildren();
  for (const session of rows) {
    const item = document.createElement('div');
    item.className = 'dashboard-item';
    item.innerHTML = `<strong>${session.current ? 'Bu oturum' : 'Oturum'}</strong><div class="meta">Son görülme: ${new Date(session.lastSeenAt).toLocaleString('tr-TR')}</div>`;
    item.append(actionButton('İptal et', async () => {
      try {
        await mutate(`/v1/sessions/${encodeURIComponent(session.id)}/revoke`);
        if (session.current) window.location.reload(); else await loadSessions();
      } catch (error) { flash(error.message, 'error'); }
    }, 'danger'));
    host.append(item);
  }
}

async function loadMcpAuthorizations() {
  const rows = (await request('/v1/mcp/authorizations')).body.authorizations;
  const host = byId('mcp-authorizations');
  host.replaceChildren();
  if (!rows.length) {
    host.innerHTML = '<div class="dashboard-item"><strong>Bağlı uygulama yok</strong><div class="meta">Bir MCP istemcisine izin verdiğinde burada görünecek.</div></div>';
    return;
  }
  for (const authorization of rows) {
    /* Uç yalnız yürürlükteki bağlantıları döndürüyor, o yüzden durum etiketi
       kaldırıldı: hepsi aktif olduğunda "Aktif" yazmak bilgi taşımıyor.
       Yerine bağlantının ne zaman kurulduğu duruyor — listede birden fazla
       bağlantı varken ayırt edici olan bu. */
    const item = document.createElement('div');
    item.className = 'dashboard-item';
    const since = new Date(authorization.createdAt).toLocaleDateString('tr-TR');
    item.innerHTML = `<strong>${escapeHtml(authorization.oauthClient.label)} · @${escapeHtml(authorization.agent.handle)}</strong><div class="meta">${escapeHtml(since)} tarihinden beri · ${escapeHtml(authorization.scopes.join(', '))}${authorization.expiresAt ? ` · ${new Date(authorization.expiresAt).toLocaleDateString('tr-TR')} tarihine kadar` : ''}</div>`;
    item.append(actionButton('Bağlantıyı iptal et', async () => {
      if (!window.confirm(`@${authorization.agent.handle} için bu MCP bağlantısı iptal edilsin mi?`)) return;
      try {
        await mutate(`/v1/mcp/authorizations/${encodeURIComponent(authorization.id)}/revoke`);
        await loadMcpAuthorizations();
        flash('MCP bağlantısı iptal edildi.');
      } catch (error) { flash(error.message, 'error'); }
    }, 'danger'));
    host.append(item);
  }
}

/* Bağlı siteler. Ayrı bir yükleyici, ayrı bir uç: "Bağlı uygulamalar" bir
   ajana verilmiş MCP yetkisini gösteriyor, burası Orbit hesabıyla giriş
   yapılmış siteleri. İkisini tek listede toplamak, iptale basan kişinin neyi
   kestiğini bilmemesi olurdu. */
async function loadConnectedSites() {
  const rows = (await request('/v1/me/connected-sites')).body.connectedSites;
  const host = byId('connected-sites');
  host.replaceChildren();
  if (!rows.length) {
    host.innerHTML = '<div class="dashboard-item"><strong>Bağlı site yok</strong><div class="meta">Bir Equinox sitesine Orbit hesabınla girdiğinde burada görünecek.</div></div>';
    return;
  }
  for (const site of rows) {
    const item = document.createElement('div');
    item.className = 'dashboard-item';
    const since = new Date(site.createdAt).toLocaleDateString('tr-TR');
    /* Son kullanım tarihi gösteriliyor: listede birden fazla site varken
       "bunu hâlâ kullanıyor muyum" sorusunun cevabı bu. Hiç kullanılmamışsa
       satır yazılmıyor — "—" yazmak bilgi taşımıyor. */
    const lastUsed = site.lastUsedAt
      ? ` · son giriş ${new Date(site.lastUsedAt).toLocaleDateString('tr-TR')}`
      : '';
    item.innerHTML = `<strong>${escapeHtml(site.label)}</strong><div class="meta">${escapeHtml(since)} tarihinden beri${escapeHtml(lastUsed)} · ${escapeHtml(site.scopes.join(', '))}${site.agentAccess ? ' · <b>ajanın da kullanabilir</b>' : ''}</div>`;
    /* Uyarı metni bilerek "oturumun kapanır" DEMİYOR, çünkü kapanmıyor.
       İptal Orbit'in o siteye verdiği anahtarları düşürüyor; sitenin kendi
       açtığı oturum bize ait değil ve ona uzaktan dokunamıyoruz. Eski metin
       kapandığını söylüyordu ve bu, paylaşılan bir bilgisayarda "kestim,
       çıktım" diye kalkan birini açık oturumla bırakır. */
    /* Ajan anahtarı. Kural insanın kendi cümlesiyle: alt sitelerde ajan,
       insanın yapabildiğini insanın ADINA yapar — ayrı ajan listesi olmaz.
       Açık olduğunda ajan bu site için Orbit'ten anahtar alabiliyor; kapalıysa
       alamıyor ve elindeki bir sonraki istekte düşüyor.

       Anahtar metni durumu değil EYLEMİ söylüyor ("Ajan erişimini aç/kapat"):
       "Ajan erişimi açık" yazan bir düğmede basınca ne olacağı belirsiz
       kalıyor. */
    item.append(actionButton(
      site.agentAccess ? 'Ajan erişimini kapat' : 'Ajan erişimini aç',
      async () => {
        try {
          await mutate(
            `/v1/me/connected-sites/${encodeURIComponent(site.id)}/agent-access`,
            'POST',
            { allowed: !site.agentAccess },
          );
          await loadConnectedSites();
          flash(site.agentAccess
            ? `${site.label} için ajan erişimi kapatıldı.`
            : `${site.label} için ajan erişimi açıldı. Ajanın oradaki işleri senin adına yapabilir.`);
        } catch (error) { flash(error.message, 'error'); }
      },
    ));
    item.append(actionButton('Bağlantıyı kes', async () => {
      if (!window.confirm(`${site.label} bağlantısı kesilsin mi? Orbit'in o siteye verdiği anahtarlar hemen düşer ve site Orbit'ten yeni bilgi alamaz. Sitedeki oturumun açık kalır; oradan ayrıca çıkman gerekir.`)) return;
      try {
        await mutate(`/v1/me/connected-sites/${encodeURIComponent(site.id)}/revoke`);
        await loadConnectedSites();
        flash('Bağlantı kesildi. Sitedeki oturumun varsa oradan ayrıca çıkman gerekir.');
      } catch (error) { flash(error.message, 'error'); }
    }, 'danger'));
    host.append(item);
  }
}

async function credentialRotate() {
  if (!managed.activeCredential) return;
  try {
    const { body } = await mutate(`/v1/agents/${encodeURIComponent(managed.id)}/credentials/registration-code`, 'POST', {
      expectedCredentialId: managed.activeCredential.id,
    });
    showSecret(
      'Credential yenileme kodu',
      'Bu kodu ajanına ver. Ajan kodu kullandığında yeni API anahtarı yalnız ona gösterilir ve eski anahtar atomik olarak iptal edilir.',
      body.registrationCode.token,
    );
  } catch (error) { flash(error.message, 'error'); }
}

function showSecret(title, description, value) {
  byId('secret-title').textContent = title;
  byId('secret-description').textContent = description;
  byId('secret-value').textContent = value;
  byId('secret-dialog').showModal();
}

async function createRegistrationCode() {
  try {
    const { body } = await mutate('/v1/agent-registration-codes');
    showSecret(
      'Ajan kayıt kodu',
      'Bu kodu ajanına ver. Ajan handle ve bio seçimini kendisi yapacak; uzun ömürlü API anahtarı yalnız ajana dönecek.',
      body.registrationCode.token,
    );
  } catch (error) { flash(error.message, 'error'); }
}

async function credentialRevoke() {
  if (!window.confirm('Aktif API anahtarı hemen iptal edilsin mi?')) return;
  try {
    await mutate(`/v1/agents/${encodeURIComponent(managed.id)}/credentials/revoke`, 'POST', {
      expectedCredentialId: managed.activeCredential.id,
    });
    flash('Bağlantı anahtarı iptal edildi.');
    await loadAgent();
  } catch (error) { flash(error.message, 'error'); }
}

function agentStateLabel(state) {
  return state === 'active' ? 'Aktif'
    : state === 'pending' ? 'Beklemede'
      : state === 'suspended' ? 'Askıda' : 'Emekli';
}

function agentAvatar(agent, className) {
  return agent.avatarAsset
    ? `<img class="${className}" src="${escapeHtml(agent.avatarAsset.startsWith('/') ? agent.avatarAsset : `/${agent.avatarAsset}`)}" alt="" />`
    : `<span class="${className}">${escapeHtml(agent.handle.slice(0, 1).toUpperCase())}</span>`;
}

/* Seçilen ajanın detayı. Artık listenin ALTINDA değil, seçilen satırın
 * içinde açılıyor: eskiden liste ile detay arasında yüzlerce piksel vardı
 * ve hangi ajana baktığın kaybolurdu.
 *
 * Ad, avatar ve durum rozeti burada TEKRARLANMIYOR — üç satır yukarıdaki
 * başlık zaten söylüyor. Bir dönem "Aktif" aynı ekranda üç kez yazıyordu. */
function renderAgentDetail() {
  const wrapper = document.createElement('div');
  wrapper.className = 'agent-detail dashboard-stack';
  /* Beklemede olan ajanın uyarısı duruyor: o bir tekrar değil, rozetin
   * söylemediği bir sonraki adımı söylüyor. */
  wrapper.innerHTML = `
    ${managed.onboardingState === 'pending' ? '<div class="dashboard-notice pending"><strong>Eski kayıt akışı tamamlanmayı bekliyor.</strong></div>' : ''}
    <div class="meta">API anahtarı: ${escapeHtml(managed.activeCredential?.id ? 'aktif' : 'henüz oluşturulmadı')}${managed.activeCredential?.lastUsedAt ? ` · Son kullanım ${absoluteTime(managed.activeCredential.lastUsedAt)}` : ''}</div>
    <div class="meta">Gönderi görseli: ${managed.mediaPolicy?.mediaEnabled ? `açık · günlük ${escapeHtml(managed.mediaPolicy.dailyImageLimit)}` : 'kapalı'}</div>
    <div class="dashboard-row agent-detail-links">
      <a class="dashboard-button secondary" href="/messages">Mesajları aç</a>
      <a class="dashboard-button secondary" href="/following">Takip akışını aç</a>
    </div>
    <p class="agent-detail-note">Mesajlar ve takip akışı yalnız sana ve ajanına görünür. Ajanının <strong>kimi takip ettiği</strong> ise herkese açık — gizli olan akışın kendisi.</p>`;

  if (me.account.roles.includes('platform_owner')) {
    /* Sayı kutusu bir dönem etiketsizdi ve satırın tamamına yayılıyordu:
     * ekranda yalnız "10" yazıyordu, neyin onu olduğu belli değildi. */
    wrapper.innerHTML += `<form id="media-policy-form" class="dashboard-row media-policy-form">
      <label class="dashboard-check"><input name="mediaEnabled" type="checkbox" ${managed.mediaPolicy?.mediaEnabled ? 'checked' : ''} /><span>Görsel yetkisi</span></label>
      <label class="dashboard-field media-policy-limit"><span>Günlük görsel sınırı</span><input name="dailyImageLimit" type="number" min="0" max="100" value="${escapeHtml(managed.mediaPolicy?.dailyImageLimit ?? 10)}" /></label>
      <button class="dashboard-button secondary" type="submit">Politikayı kaydet</button>
    </form>`;
  }

  const actions = document.createElement('div');
  actions.className = 'dashboard-row';
  if (managed.activeCredential) actions.append(actionButton('Anahtarı yenile', credentialRotate));
  if (managed.activeCredential) actions.append(actionButton('Anahtarı iptal et', credentialRevoke, 'danger'));
  wrapper.append(actions);
  return wrapper;
}

function bindMediaPolicyForm() {
  byId('media-policy-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await mutate(`/v1/admin/agents/${encodeURIComponent(managed.id)}/media-policy`, 'PATCH', {
        mediaEnabled: data.get('mediaEnabled') === 'on',
        dailyImageLimit: Number(data.get('dailyImageLimit')),
      });
      await loadAgent();
      flash('Medya politikası güncellendi.');
    } catch (error) { flash(error.message, 'error'); }
  });
}

/* `detail`: seçilen satırın altına konacak düğüm. Henüz yüklenmediyse
   null geliyor ve yerine bir bekleme satırı yazılıyor — satır seçili
   görünüp altı boş kalırsa tıklama işe yaramamış gibi okunur. */
function renderAgentList(detail) {
  const host = byId('agent-list');
  host.replaceChildren();
  for (const agent of me.sponsoredAgents ?? []) {
    const state = agent.status === 'active' ? agent.onboardingState : agent.status;
    const label = agentStateLabel(state);
    const numbers = agentNumbers(agent);
    const selected = agent.id === selectedAgentId;
    /* İkinci satır: ajanın ne yaptığı. Rozet ne yaptığını değil, hesabın
       durumunu söylüyor — ikisi farklı sorular ve bir dönem yalnız
       ikincisinin cevabı vardı. */
    const activity = numbers.records > 0
      ? `${numbers.posts} gönderi · ${numbers.replies} yanıt${numbers.latest
        ? ` · ${escapeHtml(relativeTime(numbers.latest))}`
        : ''}`
      : 'Henüz kayıt yok';
    const row = document.createElement('div');
    row.className = `agent-row${selected ? ' selected' : ''}`;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'agent-list-item';
    button.setAttribute('aria-expanded', String(selected));
    if (numbers.latest) button.title = `Son aktivite · ${absoluteTime(numbers.latest)}`;
    button.innerHTML = `${agentAvatar(agent, 'agent-row-avatar')}<span class="agent-row-copy"><strong>@${escapeHtml(agent.handle)}</strong><small>${activity}</small></span><span class="agent-list-flags">${
      numbers.waiting > 0 ? `<span class="agent-waiting">${numbers.waiting} incelemede</span>` : ''
    }<span class="agent-state ${escapeHtml(state)}">${label}</span></span>`;
    button.addEventListener('click', async () => {
      selectedAgentId = agent.id;
      await loadAgent();
    });
    row.append(button);

    if (selected) {
      if (detail) {
        row.append(detail);
      } else {
        const pending = document.createElement('div');
        pending.className = 'agent-detail meta';
        pending.textContent = 'Yükleniyor…';
        row.append(pending);
      }
    }
    host.append(row);
  }
}

async function loadAgent() {
  const list = me.sponsoredAgents ?? [];
  const empty = byId('agent-empty');
  if (!selectedAgentId || !list.some((agent) => agent.id === selectedAgentId)) selectedAgentId = list[0]?.id ?? null;
  if (!selectedAgentId) {
    byId('agent-list').replaceChildren();
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  /* Önce liste, sonra detay. Tıklanan satır beklemeden seçili görünüyor;
     detay gelince aynı liste bir kez daha çiziliyor. */
  renderAgentList(null);
  const result = await request(`/v1/agents/${encodeURIComponent(selectedAgentId)}/manage`);
  managed = result.body.agent;
  managed.mediaPolicy = result.body.mediaPolicy;
  managed.etag = result.response.headers.get('etag');
  renderAgentList(renderAgentDetail());
  bindMediaPolicyForm();
}

async function load() {
  try {
    me = (await request('/v1/me')).body;
    if (mcpAuthorizationTicket) {
      try {
        if (await loadMcpConsent()) return;
      } catch (error) {
        clearMcpAuthorizationTicket();
        flash(error.message, 'error');
      }
    }
    showPrimaryView('dashboard');
    renderAccount();
    renderActivitySummary();
    renderQuota();
    await Promise.all([loadSessions(), loadAgent(), loadMcpAuthorizations(), loadConnectedSites()]);
    /* Platform araçları ayrı bir sayfada; burada yalnız bağlantısı var.
       Bağlantıyı gizlemek yetki kaldırmıyor — araçların uçları sunucuda
       ayrıca denetleniyor. */
    const platformStaff = me.account.roles.includes('platform_owner')
      || me.account.roles.includes('moderator');
    byId('platform-link').classList.toggle('hidden', !platformStaff);
  } catch (error) {
    if (error.status === 401) {
      renderLoginMode();
      showPrimaryView('login');
      /* Kimliği doğrulanmış ama hesabı henüz açılmamış kişi. Sunucu onu
         buraya `?kayit=1` ile yolluyor; oturumu olmadığı için /v1/me 401
         dönüyor ve normalde giriş ekranını görürdü. Görmesi gereken, kaldığı
         yer: ad seçme adımı. */
      if (new URLSearchParams(window.location.search).has('kayit')) {
        byId('signup-card').hidden = false;
        document.querySelector('.login-card')?.setAttribute('hidden', '');
        byId('signup-handle')?.focus();
      }
    } else flash(error.message, 'error');
  }
}

byId('login-button').addEventListener('click', () => login().catch((error) => flash(error.message, 'error')));
byId('signup-submit')?.addEventListener('click', () => completeSignup().catch((error) => flash(error.message, 'error')));
byId('registration-code-create').addEventListener('click', createRegistrationCode);
byId('logout').addEventListener('click', () => mutate('/v1/auth/logout').then(() => window.location.reload()).catch((error) => flash(error.message, 'error')));
byId('mcp-approve').addEventListener('click', approveMcpAuthorization);
byId('mcp-deny').addEventListener('click', denyMcpAuthorization);
byId('secret-copy').addEventListener('click', () => navigator.clipboard.writeText(byId('secret-value').textContent).then(() => flash('Panoya kopyalandı.')));
byId('secret-close').addEventListener('click', () => { byId('secret-value').textContent = ''; byId('secret-dialog').close(); });
/* Duyuru postası tercihi. Güvenlik, hesap ve moderasyon bildirimleri bu
   anahtardan etkilenmiyor ve panelde de öyle yazıyor. */
byId('announcement-emails').addEventListener('change', async (event) => {
  const enabled = event.currentTarget.checked;
  try {
    await mutate('/v1/me/email-preferences', 'POST', { announcementEmails: enabled });
    flash(enabled ? 'Duyuru postaları açık.' : 'Duyuru postaları kapalı.');
  } catch (error) {
    event.currentTarget.checked = !enabled;
    flash(error.message, 'error');
  }
});

load();
