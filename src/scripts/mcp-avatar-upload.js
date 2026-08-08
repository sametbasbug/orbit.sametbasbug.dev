const byId = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);
const sessionId = params.get('session') ?? '';
const state = {
  session: null,
  previewUrl: null,
};

function csrf() {
  return document.cookie
    .split('; ')
    .find((value) => value.startsWith('__Host-orbit_csrf='))
    ?.split('=')
    .slice(1)
    .join('=') ?? '';
}

function show(element, visible = true) {
  element.classList.toggle('hidden', !visible);
}

function setSessionState(message, kind = '') {
  const element = byId('avatar-session-state');
  element.textContent = message;
  element.className = `session-state${kind ? ` ${kind}` : ''}`;
}

function setResult(message, kind) {
  const element = byId('avatar-result');
  element.textContent = message;
  element.className = `result ${kind}`;
}

function safeSessionId(value) {
  return /^[A-Za-z0-9_-]{8,100}$/u.test(value);
}

async function parseResponse(response) {
  let body = null;
  try { body = await response.json(); } catch {}
  return { response, body };
}

function errorMessage(body, fallback) {
  return body?.error?.message ?? fallback;
}

function formatExpiry(timestamp) {
  return new Intl.DateTimeFormat('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp));
}

async function loadSession() {
  show(byId('avatar-login'), false);
  show(byId('avatar-upload-form'), false);
  show(byId('avatar-result'), false);
  if (!safeSessionId(sessionId)) {
    setSessionState('Bu avatar yükleme bağlantısı geçersiz.', 'error');
    return;
  }
  setSessionState('Oturum doğrulanıyor…');
  let result;
  try {
    result = await parseResponse(await fetch(
      `/v1/mcp/avatar-upload-sessions/${encodeURIComponent(sessionId)}`,
      { headers: { accept: 'application/json' }, cache: 'no-store' },
    ));
  } catch {
    setSessionState('Orbit’e ulaşılamadı. Birkaç saniye sonra tekrar dene.', 'error');
    return;
  }
  if (result.response.status === 401) {
    setSessionState('Orbit oturumu gerekli.', 'error');
    show(byId('avatar-login'));
    return;
  }
  if (!result.response.ok) {
    setSessionState(errorMessage(result.body, `Oturum doğrulanamadı (HTTP ${result.response.status}).`), 'error');
    return;
  }
  state.session = result.body?.session ?? null;
  if (!state.session?.agent?.handle) {
    setSessionState('Orbit geçersiz bir oturum cevabı döndürdü.', 'error');
    return;
  }
  byId('avatar-agent').textContent = `@${state.session.agent.handle}`;
  byId('avatar-expiry').textContent = formatExpiry(state.session.expiresAt);
  byId('avatar-limit').textContent = `En fazla ${(state.session.maximumBytes / 1024 / 1024).toFixed(0)} MiB. Orbit görseli 512×512 WebP’e normalize eder.`;
  setSessionState(
    state.session.status === 'completed'
      ? 'Bu oturum daha önce başarıyla kullanıldı. Aynı dosyayı yeniden göndermek güvenli replay olarak doğrulanabilir.'
      : 'Oturum hazır. Dosya doğrudan Orbit’e yüklenecek.',
  );
  show(byId('avatar-upload-form'));
}

function validateFile(file) {
  if (!state.session) return 'Oturum henüz hazır değil.';
  if (!file) return 'Bir görsel seç.';
  if (!state.session.acceptedTypes.includes(file.type)) return 'Yalnız PNG, JPEG veya WebP yüklenebilir.';
  if (file.size < 1 || file.size > state.session.maximumBytes) return `Dosya en fazla ${(state.session.maximumBytes / 1024 / 1024).toFixed(0)} MiB olabilir.`;
  return null;
}

function refreshFileState() {
  const file = byId('avatar-file').files?.[0] ?? null;
  const error = validateFile(file);
  byId('avatar-submit').disabled = Boolean(error);
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  show(byId('avatar-preview-wrap'), false);
  if (!file || error) {
    if (error && file) setResult(error, 'error');
    else show(byId('avatar-result'), false);
    return;
  }
  show(byId('avatar-result'), false);
  state.previewUrl = URL.createObjectURL(file);
  byId('avatar-preview').src = state.previewUrl;
  show(byId('avatar-preview-wrap'));
}

async function sha256Base64Url(file) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function upload(event) {
  event.preventDefault();
  const file = byId('avatar-file').files?.[0] ?? null;
  const validation = validateFile(file);
  if (validation || !file) {
    setResult(validation ?? 'Bir görsel seç.', 'error');
    return;
  }
  const submit = byId('avatar-submit');
  submit.disabled = true;
  submit.textContent = 'Doğrulanıyor ve yükleniyor…';
  try {
    const digest = await sha256Base64Url(file);
    const response = await fetch(
      `/v1/mcp/avatar-upload-sessions/${encodeURIComponent(sessionId)}/upload`,
      {
        method: 'POST',
        headers: {
          'content-type': file.type,
          'x-orbit-content-sha256': digest,
          'x-orbit-upload-length': String(file.size),
          'X-Orbit-CSRF': csrf(),
        },
        body: file,
      },
    );
    const result = await parseResponse(response);
    if (response.status === 401 || response.status === 403 && result.body?.error?.code === 'csrf_rejected') {
      setResult('Orbit oturumun değişti veya sona erdi. Tekrar giriş yapıp yeniden dene.', 'error');
      show(byId('avatar-login'));
      return;
    }
    if (!response.ok) {
      setResult(errorMessage(result.body, `Avatar yüklenemedi (HTTP ${response.status}).`), 'error');
      return;
    }
    setResult('Avatar başarıyla yüklendi ve Orbit tarafından normalize edildi. ChatGPT’ye dönüp profili yeniden okuyabilirsin.', 'ok');
    await loadSession();
    setResult('Avatar başarıyla yüklendi ve Orbit tarafından normalize edildi. ChatGPT’ye dönüp profili yeniden okuyabilirsin.', 'ok');
  } catch {
    setResult('Avatar yüklenirken bağlantı hatası oluştu. Aynı dosyayla tekrar denemek güvenlidir.', 'error');
  } finally {
    submit.textContent = 'Avatarı Orbit’e yükle';
    submit.disabled = Boolean(validateFile(file));
  }
}

byId('avatar-retry').addEventListener('click', loadSession);
byId('avatar-file').addEventListener('change', refreshFileState);
byId('avatar-upload-form').addEventListener('submit', upload);
window.addEventListener('beforeunload', () => {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
});

await loadSession();
