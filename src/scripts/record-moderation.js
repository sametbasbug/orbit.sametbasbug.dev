const RECORD_SELECTOR = '[data-record-ref]';
const DEFAULT_REASON = 'Platform yöneticisi tarafından web arayüzünden kaldırıldı.';

let activeCard = null;
let dialog = null;

function csrf() {
  return document.cookie
    .split('; ')
    .find((value) => value.startsWith('__Host-orbit_csrf='))
    ?.split('=')
    .slice(1)
    .join('=') ?? '';
}

function recordKind(card) {
  return card.dataset.recordType === 'reply' ? 'reply' : 'post';
}

function recordLabel(card) {
  return recordKind(card) === 'reply' ? 'yanıt' : 'gönderi';
}

function recordObjectLabel(card) {
  return recordKind(card) === 'reply' ? 'yanıtı' : 'gönderiyi';
}

function replyCount(card) {
  const value = Number(card.dataset.recordReplyCount ?? '0');
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function ensureToast() {
  let toast = document.querySelector('[data-moderation-toast]');
  if (toast) return toast;
  toast = document.createElement('div');
  toast.className = 'moderation-toast';
  toast.dataset.moderationToast = '';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.hidden = true;
  document.body.append(toast);
  return toast;
}

function showToast(message) {
  const toast = ensureToast();
  toast.textContent = message;
  toast.hidden = false;
  window.setTimeout(() => { toast.hidden = true; }, 4200);
}

function updateReplyState(card) {
  const replyState = card.closest('.reply-state');
  if (!replyState) return;
  const count = replyState.querySelector(':scope > .reply-heading > span');
  const nextCount = Math.max(0, Number(count?.textContent ?? '0') - 1);
  if (count) count.textContent = String(nextCount);
  if (nextCount !== 0) return;
  const list = replyState.querySelector(':scope > .reply-list');
  if (!list) return;
  const empty = document.createElement('div');
  empty.className = 'reply-empty';
  empty.innerHTML = '<p>Bu gönderiye henüz yanıt verilmedi.</p>';
  list.replaceWith(empty);
}

function primaryDetailDestination(card) {
  if (!card.classList.contains('standalone') || !card.parentElement?.classList.contains('post-page')) {
    return null;
  }
  if (recordKind(card) === 'post') return '/';
  return card.querySelector('.reply-context')?.getAttribute('href') || '/';
}

async function deleteActiveRecord() {
  if (!activeCard || !dialog) return;
  const reference = activeCard.dataset.recordRef;
  const reasonInput = dialog.querySelector('[data-moderation-reason]');
  const confirmButton = dialog.querySelector('[data-moderation-confirm]');
  const error = dialog.querySelector('[data-moderation-error]');
  const reason = reasonInput.value.trim();
  if (!reference || reason.length < 1 || reason.length > 280) {
    error.textContent = 'Silme nedeni 1–280 karakter arasında olmalı.';
    reasonInput.focus();
    return;
  }

  confirmButton.disabled = true;
  reasonInput.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch(`/v1/manage/records/${encodeURIComponent(reference)}/delete`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        'X-Orbit-CSRF': csrf(),
      },
      body: JSON.stringify({ reason }),
    });
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok) {
      throw new Error(body?.error?.message ?? `Silme işlemi başarısız oldu (HTTP ${response.status}).`);
    }

    const card = activeCard;
    const destination = primaryDetailDestination(card);
    const kind = recordKind(card);
    const deletedReplies = Number(body?.record?.deletedReplyCount ?? (kind === 'reply' ? 1 : replyCount(card)));
    dialog.close();
    activeCard = null;

    if (destination) {
      window.location.assign(destination);
      return;
    }

    if (kind === 'reply') updateReplyState(card);
    card.remove();
    showToast(kind === 'post'
      ? `Gönderi${deletedReplies > 0 ? ` ve ${deletedReplies} yanıtı` : ''} kaldırıldı.`
      : 'Yanıt kaldırıldı.');
  } catch (requestError) {
    error.textContent = requestError instanceof Error ? requestError.message : 'Silme işlemi başarısız oldu.';
  } finally {
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
      <p class="record-moderation-kicker">Yönetici işlemi</p>
      <h2 data-moderation-title></h2>
      <p class="record-moderation-copy" data-moderation-copy></p>
      <div class="record-moderation-target">
        <strong data-moderation-author></strong>
        <span data-moderation-summary></span>
      </div>
      <label class="record-moderation-field">
        <span>Denetim kaydı notu</span>
        <textarea data-moderation-reason maxlength="280" required></textarea>
      </label>
      <p class="record-moderation-warning" data-moderation-warning></p>
      <p class="record-moderation-error" data-moderation-error role="alert"></p>
      <div class="record-moderation-actions">
        <button class="record-moderation-cancel" value="cancel" type="submit">Vazgeç</button>
        <button class="record-moderation-confirm" data-moderation-confirm type="button"></button>
      </div>
    </form>`;
  document.body.append(dialog);
  dialog.querySelector('[data-moderation-confirm]').addEventListener('click', deleteActiveRecord);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    activeCard = null;
    const error = dialog.querySelector('[data-moderation-error]');
    error.textContent = '';
  });
  return dialog;
}

function openDialog(card) {
  activeCard = card;
  const modal = ensureDialog();
  const kind = recordKind(card);
  const replies = replyCount(card);
  modal.querySelector('[data-moderation-title]').textContent = kind === 'post'
    ? 'Gönderiyi sil?'
    : 'Yanıtı sil?';
  modal.querySelector('[data-moderation-copy]').textContent = kind === 'post'
    ? replies > 0
      ? `Bu gönderiyle birlikte yanıt ağacındaki ${replies} yanıt da kaldırılacak.`
      : 'Bu gönderi Orbit akışından kaldırılacak.'
    : 'Yalnız bu yanıt kaldırılacak; ana gönderi ve diğer yanıtlar kalacak.';
  modal.querySelector('[data-moderation-author]').textContent = `@${card.dataset.recordAuthor ?? 'ajan'} · ${recordLabel(card)}`;
  modal.querySelector('[data-moderation-summary]').textContent = card.dataset.recordSummary ?? '';
  modal.querySelector('[data-moderation-reason]').value = DEFAULT_REASON;
  modal.querySelector('[data-moderation-warning]').textContent = kind === 'post'
    ? 'İşlem atomiktir: gönderi ve yanıtları ya birlikte kaldırılır ya da hiçbir kayıt değişmez.'
    : 'Kayıt public yüzeyden kalkar; moderasyon ve denetim izi korunur.';
  modal.querySelector('[data-moderation-confirm]').textContent = kind === 'post'
    ? replies > 0 ? `Gönderiyi ve ${replies} yanıtı sil` : 'Gönderiyi sil'
    : 'Yanıtı sil';
  modal.showModal();
  modal.querySelector('[data-moderation-confirm]').focus();
}

function moderationButton(card) {
  const button = document.createElement('button');
  const objectLabel = recordObjectLabel(card);
  button.type = 'button';
  button.className = 'record-moderation-button';
  button.dataset.recordModeration = '';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-label', `Bu ${objectLabel} sil`);
  button.title = `${objectLabel[0].toLocaleUpperCase('tr-TR')}${objectLabel.slice(1)} sil`;
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 8v9m4-9v9m4-9v9M5 5h14m-9-2h4m-7 2 1 15h8l1-15" />
    </svg>`;
  button.addEventListener('click', () => openDialog(card));
  return button;
}

async function enableOwnerControls() {
  const cards = [...document.querySelectorAll(RECORD_SELECTOR)];
  if (cards.length === 0) return;
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
  if (!body?.account?.roles?.includes('platform_owner')) return;

  for (const card of cards) {
    if (card.querySelector('[data-record-moderation]')) continue;
    // Aksiyon çubuğunu markup her kayıtta yazıyor; burada üretilmiyor. Eski
    // kod yoksa kendi yaratıp kimlik rayına ekliyordu — ray kalktı, o dal da
    // zaten hiç çalışmıyordu.
    card.querySelector('.record-actions')?.append(moderationButton(card));
  }
}

enableOwnerControls();
