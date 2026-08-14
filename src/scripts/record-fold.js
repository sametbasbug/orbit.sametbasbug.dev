/**
 * Uzun gövdeleri akışta katlar.
 *
 * Akış bir arşiv değil: kayıtlar tam boyuyla akınca geniş ekranda bile aynı
 * anda bir buçuk kayıt görünüyordu, yani akış taranamıyor sadece okunabiliyordu.
 * Katlama tavanı CSS'te (--fold-max); burada yalnız tavanı gerçekten aşan
 * gövdelere dokunuluyor, kısa kayıtlara buton takılmıyor.
 *
 * Katlama CSS'te değil BURADA başlıyor: stil sayfası gövdeyi baştan kapatsaydı
 * script'i çalışmayan ziyaretçide metin kalıcı olarak kesik kalırdı. Bunun
 * bedeli uzun kayıtlarda ilk boyada bir kerelik sıçrama; erişilebilir metin
 * bu sıçramaya değer.
 *
 * Tekil kayıt sayfası (.standalone) katlanmaz — oraya zaten okumaya gelinir.
 */
const FOLD_SELECTOR = '.record:not(.standalone) .record-body';

/** Tavanı bu kadar piksel aşmayan gövde için katlamaya değmez. */
const SLACK = 48;

function foldMaxPx(body) {
  const raw = getComputedStyle(body).getPropertyValue('--fold-max').trim();
  if (raw.endsWith('px')) return Number.parseFloat(raw);
  const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return Number.parseFloat(raw) * rootSize;
}

function toggleButton(body, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'record-fold-toggle';
  button.dataset.recordFold = '';
  button.setAttribute('aria-expanded', 'false');
  if (body.id) button.setAttribute('aria-controls', body.id);
  button.textContent = label;
  button.addEventListener('click', (event) => {
    // Kaydın tıklama yüzeyi butonun altında duruyor; açma eylemi gönderi
    // sayfasına gitmeye dönüşmesin.
    event.preventDefault();
    event.stopPropagation();
    const open = body.dataset.fold === 'open';
    body.dataset.fold = open ? 'closed' : 'open';
    button.setAttribute('aria-expanded', String(!open));
    button.textContent = open ? 'Devamını göster' : 'Daha az göster';
  });
  return button;
}

function foldRecords() {
  for (const body of document.querySelectorAll(FOLD_SELECTOR)) {
    if (body.dataset.fold) continue;
    const max = foldMaxPx(body);
    if (!Number.isFinite(max) || max <= 0) continue;
    if (body.scrollHeight <= max + SLACK) continue;
    body.dataset.fold = 'closed';
    body.after(toggleButton(body, 'Devamını göster'));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', foldRecords, { once: true });
} else {
  foldRecords();
}
