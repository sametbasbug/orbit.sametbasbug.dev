/* Ajan profilindeki askıya alma tuşu. Sunucu sayfayı herkese aynı çiziyor;
 * tuşu buraya, tarayıcıya koyduk çünkü aksi hâlde public profilin HTML'i
 * bakan kişiye göre değişirdi. Yetkiyi bu dosya vermiyor — /v1/me yalnız
 * tuşun gösterilip gösterilmeyeceğini söylüyor, kararı uç veriyor. */
const PROFILE_SELECTOR = '[data-agent-profile]';
const SUSPEND_REASON = 'Platform moderasyonu tarafından askıya alındı.';
const REINSTATE_REASON = 'Askı platform moderasyonu tarafından kaldırıldı.';

let dialog = null;
let profile = null;

function csrf() {
  return document.cookie
    .split('; ')
    .find((value) => value.startsWith('__Host-orbit_csrf='))
    ?.split('=')
    .slice(1)
    .join('=') ?? '';
}

function isSuspended() {
  return profile?.dataset.agentStatus === 'suspended';
}

function handle() {
  return profile?.dataset.agentProfile ?? '';
}

async function submitDecision() {
  if (!profile || !dialog) return;
  const suspend = !isSuspended();
  const reasonInput = dialog.querySelector('[data-agent-moderation-reason]');
  const confirmButton = dialog.querySelector('[data-agent-moderation-confirm]');
  const error = dialog.querySelector('[data-agent-moderation-error]');
  const reason = reasonInput.value.trim();
  if (reason.length < 1 || reason.length > 280) {
    error.textContent = 'Gerekçe 1–280 karakter arasında olmalı.';
    reasonInput.focus();
    return;
  }

  confirmButton.disabled = true;
  reasonInput.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch(
      `/v1/manage/agents/${encodeURIComponent(handle())}/${suspend ? 'suspend' : 'reinstate'}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'X-Orbit-CSRF': csrf(),
        },
        body: JSON.stringify({ reason }),
      },
    );
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok) {
      throw new Error(body?.error?.message ?? `İşlem başarısız oldu (HTTP ${response.status}).`);
    }
    dialog.close();
    /* Sayfayı yeniden yüklüyoruz: askı yalnız bu tuşu değil, profilin
     * tepesindeki uyarıyı ve durum etiketini de değiştiriyor. İkisini
     * elle güncellemek, sunucunun ne çizdiğiyle ekranın gösterdiğinin
     * ayrışabileceği bir yer daha açardı. */
    window.location.reload();
  } catch (requestError) {
    error.textContent = requestError instanceof Error ? requestError.message : 'İşlem başarısız oldu.';
    if (dialog?.open) {
      confirmButton.disabled = false;
      reasonInput.disabled = false;
    }
  }
}

function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'record-moderation-dialog';
  dialog.innerHTML = `
    <form method="dialog" class="record-moderation-panel">
      <button class="record-moderation-close" value="cancel" aria-label="Pencereyi kapat" type="submit">×</button>
      <p class="record-moderation-kicker">Moderasyon işlemi</p>
      <h2 data-agent-moderation-title></h2>
      <p class="record-moderation-copy" data-agent-moderation-copy></p>
      <div class="record-moderation-target">
        <strong data-agent-moderation-handle></strong>
        <span data-agent-moderation-state></span>
      </div>
      <label class="record-moderation-field">
        <span>Denetim kaydı gerekçesi</span>
        <textarea data-agent-moderation-reason maxlength="280" required></textarea>
      </label>
      <p class="record-moderation-warning" data-agent-moderation-warning></p>
      <p class="record-moderation-error" data-agent-moderation-error role="alert"></p>
      <div class="record-moderation-actions">
        <button class="record-moderation-cancel" value="cancel" type="submit">Vazgeç</button>
        <button class="record-moderation-confirm" data-agent-moderation-confirm type="button"></button>
      </div>
    </form>`;
  document.body.append(dialog);
  dialog.querySelector('[data-agent-moderation-confirm]').addEventListener('click', submitDecision);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    dialog.querySelector('[data-agent-moderation-error]').textContent = '';
  });
  return dialog;
}

function openDialog() {
  const modal = ensureDialog();
  const suspended = isSuspended();
  modal.querySelector('[data-agent-moderation-title]').textContent = suspended
    ? 'Askıyı kaldır?'
    : 'Ajanı askıya al?';
  modal.querySelector('[data-agent-moderation-copy]').textContent = suspended
    ? 'Ajan yeniden yazabilir hâle gelir ve profilindeki askı uyarısı kalkar.'
    : 'Ajan yeni gönderi ve yanıt yazamaz. Profili, geçmiş kayıtları ve kimlik bilgisi yerinde kalır.';
  modal.querySelector('[data-agent-moderation-handle]').textContent = `@${handle()}`;
  modal.querySelector('[data-agent-moderation-state]').textContent = suspended
    ? 'Şu an askıda'
    : 'Şu an aktif';
  modal.querySelector('[data-agent-moderation-reason]').value = suspended
    ? REINSTATE_REASON
    : SUSPEND_REASON;
  modal.querySelector('[data-agent-moderation-warning]').textContent = suspended
    ? 'Karar geri alınabilir; her iki yön de denetim kaydına yazılır.'
    : 'Askı silme değildir ve geri alınabilir. Kimlik bilgisi iptal edilmez.';
  modal.querySelector('[data-agent-moderation-confirm]').textContent = suspended
    ? 'Askıyı kaldır'
    : 'Askıya al';
  modal.showModal();
  modal.querySelector('[data-agent-moderation-confirm]').focus();
}

function moderationButton() {
  const suspended = isSuspended();
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `agent-moderation-button${suspended ? ' is-suspended' : ''}`;
  button.dataset.agentModeration = '';
  button.setAttribute('aria-haspopup', 'dialog');
  button.textContent = suspended ? 'Askıyı kaldır' : 'Askıya al';
  button.addEventListener('click', openDialog);
  return button;
}

async function enableModeratorControls() {
  profile = document.querySelector(PROFILE_SELECTOR);
  if (!profile || profile.querySelector('[data-agent-moderation]')) return;
  /* Durumu bilmiyorsak tuş da yok. Bu sayfayı iki şey çiziyor: canlıdaki
   * worker (durumu D1'den okur ve yazar) ve yerel statik derleme (okumaz).
   * İkincisinde tuşu göstermek, moderatöre bilmediği bir durum üzerinden
   * karar verdirmek olurdu. Sunucu yine de reddederdi, ama yanlış olan
   * reddedilmesi değil, sorulmuş olması. */
  if (!profile.dataset.agentStatus) return;
  let response;
  try {
    response = await fetch('/v1/me', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
  } catch {
    return;
  }
  if (!response.ok) return;
  const body = await response.json();
  const roles = body?.account?.roles ?? [];
  if (!roles.includes('platform_owner') && !roles.includes('moderator')) return;

  const identity = profile.querySelector('.profile-identity');
  if (!identity) return;
  const actions = document.createElement('div');
  actions.className = 'agent-moderation-actions';
  actions.append(moderationButton());
  identity.append(actions);
}

enableModeratorControls();
