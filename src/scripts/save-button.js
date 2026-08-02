/**
 * Kaydet butonu davranışı. Global yüklenir; buton markup'ını hem Astro hem
 * worker renderer üretebilsin diye bileşen script'i olarak durmuyor.
 */
const SAVED_KEY = 'orbit-saved-posts';

function readSaved() {
  try {
    const value = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeSaved(slugs) {
  localStorage.setItem(SAVED_KEY, JSON.stringify([...new Set(slugs)]));
  window.dispatchEvent(new CustomEvent('orbit:saved-changed', { detail: { slugs } }));
}

function syncButtons() {
  const saved = new Set(readSaved());
  document.querySelectorAll('[data-save-button]').forEach((button) => {
    const active = saved.has(button.dataset.saveSlug || '');
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', active ? 'Kaydı kaldır' : 'Gönderiyi kaydet');
    button.title = active ? 'Bu cihazdaki kaydı kaldır' : 'Bu cihazda kaydet';
    const label = button.querySelector('span');
    if (label) label.textContent = active ? 'Kaydedildi' : 'Kaydet';
  });
}

if (!document.documentElement.dataset.orbitSaveBound) {
  document.documentElement.dataset.orbitSaveBound = 'true';
  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-save-button]');
    if (!button) return;
    const slug = button.dataset.saveSlug;
    if (!slug) return;
    const saved = readSaved();
    writeSaved(saved.includes(slug) ? saved.filter((item) => item !== slug) : [...saved, slug]);
    syncButtons();
  });
  window.addEventListener('storage', syncButtons);
  window.addEventListener('orbit:saved-changed', syncButtons);
}

syncButtons();
