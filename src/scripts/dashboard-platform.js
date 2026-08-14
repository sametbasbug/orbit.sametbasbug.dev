/*
 * Platform araçları.
 *
 * Bu araçlar bir dönem `/dashboard` içinde, kişisel hesap ayarlarının
 * altında bir akordeonun içindeydi. Dördü ayrı iş: moderasyon, yayın,
 * kota ve yedek. Hiçbiri "hesabım" değil ve hiçbiri bir açılır kutunun
 * içine sığacak kadar küçük değil.
 *
 * Bu sayfa bir güvenlik sınırı DEĞİL. Rolü olmayan biri adresi bilse de
 * hiçbir şey göremez, çünkü uçların hepsi sunucuda ayrıca denetleniyor.
 * Buradaki kontrol yalnız ekranı boş yere çizmemek için.
 */
import {
  actionButton,
  announcementStatusLabel,
  audienceLabel,
  absoluteTime,
  backupKindLabel,
  backupStatusLabel,
  byId,
  csrf,
  escapeHtml,
  flash,
  mutate,
  relativeTime,
  request,
  severityLabel,
} from './dashboard-shared.js';

let me = null;
let activeReview = null;

function showView(id) {
  for (const viewId of ['platform-denied', 'platform']) {
    byId(viewId).classList.toggle('hidden', viewId !== id);
  }
}

async function loadApprovals() {
  const rows = (await request('/v1/approvals')).body.reviews;
  const host = byId('approvals');
  host.replaceChildren();
  if (!rows.length) {
    host.innerHTML = '<div class="dashboard-item"><strong>Bekleyen yayın yok</strong><div class="meta">Onay gerektiren yeni bir içerik geldiğinde burada görünecek.</div></div>';
    return;
  }
  for (const review of rows) {
    const item = document.createElement('div');
    item.className = 'dashboard-item';
    item.innerHTML = `<strong>@${escapeHtml(review.authorHandle)} · ${escapeHtml(review.record.slug)}</strong><div class="meta">Sürüm ${escapeHtml(review.revision.number)} · ${escapeHtml(absoluteTime(review.requestedAt))}</div>`;
    item.append(actionButton('Farkı incele', () => openReview(review.id)));
    host.append(item);
  }
}

async function openReview(id) {
  activeReview = (await request(`/v1/approvals/${encodeURIComponent(id)}`)).body.review;
  byId('review-title').textContent = `@${activeReview.authorHandle} · ${activeReview.record.slug}`;
  byId('review-current').textContent = activeReview.currentRevision?.bodyMarkdown ?? 'İlk yayın — mevcut sürüm yok';
  byId('review-candidate').textContent = activeReview.revision.bodyMarkdown;
  const media = byId('review-media');
  media.replaceChildren();
  if (activeReview.media) {
    const image = document.createElement('img');
    image.className = 'review-media';
    image.src = activeReview.media.url;
    image.alt = activeReview.media.altText;
    media.append(image);
    if (activeReview.media.caption) {
      const caption = document.createElement('p');
      caption.className = 'meta';
      caption.textContent = activeReview.media.caption;
      media.append(caption);
    }
  }
  byId('review-note').value = '';
  byId('review-dialog').showModal();
}

async function decide(decision) {
  try {
    await request(`/v1/approvals/${encodeURIComponent(activeReview.id)}/${decision}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Orbit-CSRF': csrf(), 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ note: byId('review-note').value || null }),
    });
    byId('review-dialog').close();
    activeReview = null;
    flash(decision === 'approve' ? 'Yayın onaylandı.' : 'Yayın reddedildi.');
    await loadApprovals();
  } catch (error) { flash(error.message, 'error'); }
}

/* Kutunun yanındaki sayı. Postayla duyurmak geri alınamayan bir iş: kuyruğa
   giren satır yayınla aynı batch'te yazılıyor ve gönderilen posta geri
   çağrılamıyor. Kaç kişiye gideceğini işaretlemeden ÖNCE görmek, o kararın
   tek ölçüsü.

   Aynı yer kalan günlük bütçeyi de gösteriyor: alıcı sayısı tavanın altında
   olsa bile o gün bütçe tükenmişse postalar bekler, ve bunu yayına
   bastıktan sonra öğrenmek geç olur. */
async function loadAnnouncementEmailBudget() {
  const host = byId('announcement-email-budget');
  try {
    const budget = (await request('/v1/admin/announcements/email-budget')).body.emailBudget;
    const overCap = budget.recipients > budget.recipientCap;
    host.textContent = overCap
      ? `Duyuru postası şu an ${budget.recipients} kişiye gidecekti; tek duyuru için tavan ${budget.recipientCap} kişi. Postasız yayımlayabilirsin — postayla duyurmak için gönderim planını yükseltmek gerekiyor.`
      : `Postayla duyurursan ${budget.recipients} kişiye gider (tavan ${budget.recipientCap}). Bugün kalan gönderim hakkı: ${budget.remainingToday}/${budget.dailyBudget}.`;
    host.classList.toggle('is-warning', overCap || budget.remainingToday < budget.recipients);
  } catch {
    /* Bütçe okunamadıysa yayın engellenmiyor — bu bir bilgi satırı, bir
       kapı değil. Ama boş bırakmak "gidecek kişi yok" gibi okunurdu. */
    host.textContent = 'Gönderim bütçesi şu an okunamıyor.';
  }
}

async function loadAnnouncements() {
  const rows = (await request('/v1/admin/announcements')).body.announcements;
  const host = byId('announcements');
  host.replaceChildren();
  if (!rows.length) {
    host.innerHTML = '<div class="dashboard-item"><strong>Duyuru yok</strong><div class="meta">Yayımladığın duyurular burada listelenecek.</div></div>';
    return;
  }
  for (const announcement of rows) {
    const item = document.createElement('div');
    item.className = 'dashboard-item';
    item.innerHTML = `<strong>${escapeHtml(announcement.title)}</strong><div class="meta">${escapeHtml(severityLabel(announcement.severity))} · ${escapeHtml(audienceLabel(announcement.audienceType))} · ${escapeHtml(announcementStatusLabel(announcement.status))}</div>`;
    if (announcement.status === 'draft') item.append(actionButton('Yayımla', async () => {
      /* Listeden yayımlarken posta gönderilmiyor. Postalama kararı yazma
         anında verilir; bir taslağı tamamlamak, o kararı yeniden sormadan
         onlarca kişiye posta atmak anlamına gelmemeli. */
      try { await mutate(`/v1/admin/announcements/${encodeURIComponent(announcement.id)}/publish`, 'POST', { sendEmail: false }); await loadAnnouncements(); }
      catch (error) { flash(error.message, 'error'); }
    }));
    /* Geri çekme artık silme. Onay istiyoruz çünkü geri dönüşü yok: duyuru
       metniyle birlikte gidiyor, yönetici panelinde de kalmıyor. */
    if (announcement.status === 'draft' || announcement.status === 'active') item.append(actionButton('Geri çek ve sil', async () => {
      if (!window.confirm(`"${announcement.title}" geri çekilip tamamen silinsin mi? Metni hiçbir yerden okunamaz.`)) return;
      try { await mutate(`/v1/admin/announcements/${encodeURIComponent(announcement.id)}/withdraw`); await loadAnnouncements(); flash('Duyuru geri çekildi ve silindi.'); }
      catch (error) { flash(error.message, 'error'); }
    }, 'danger'));
    host.append(item);
  }
}

/* Yedek durumu bir DURUM, bir günlük değil.
 *
 * Burası bir dönem 34 satırlık bir "daily · succeeded" listesiydi: hepsi
 * aynı görsel ağırlıkta, hepsi İngilizce. İçlerinden biri failed olsa
 * fark etmek için otuz dört satır okumak gerekiyordu.
 *
 * Şimdi önce tek cümlelik durum, sonra YALNIZ başarısızlar. Başarılı
 * çalışmalar sayı olarak duruyor — biri onları tek tek okumak isterse
 * zaten aradığı şey başarısızlıktır. */
async function loadBackups() {
  const rows = (await request('/v1/admin/backups')).body.backups;
  const host = byId('backups');
  host.replaceChildren();
  if (!rows.length) {
    host.innerHTML = '<div class="dashboard-item"><strong>Henüz yedek çalışması yok</strong></div>';
    return;
  }
  const running = rows.filter((run) => run.status === 'running');
  const latest = rows[0];
  const lastSucceeded = rows.find((run) => run.status === 'succeeded');

  /* ÇÖZÜLMEMİŞ başarısızlık: son başarılı çalışmadan SONRA olan.
   *
   * Bir başarısızlığın ardından yedek yeniden çalıştıysa o iş kapanmıştır.
   * Üç hafta önce takılmış bir koşuyu panelde tutmak, kimsenin bir daha
   * yapamayacağı bir şeyi kalıcı olarak kırmızı göstermek olur — ve
   * sürekli duran bir uyarı, bir süre sonra hiç okunmayan bir uyarıdır.
   * Asıl soru "hiç hata oldu mu" değil, "şu an bozuk mu". */
  const unresolved = lastSucceeded
    ? rows.filter((run) => run.status === 'failed' && run.startedAt > lastSucceeded.startedAt)
    : rows.filter((run) => run.status === 'failed');
  const failedTotal = rows.filter((run) => run.status === 'failed').length;

  const summary = document.createElement('div');
  summary.className = `backup-summary${unresolved.length > 0 ? ' is-failing' : ''}`;
  summary.innerHTML = `
    <strong>${unresolved.length > 0
      ? `Son başarılı yedekten beri ${unresolved.length} çalışma başarısız`
      : 'Yedekler çalışıyor'}</strong>
    <div class="meta">Son çalışma: ${escapeHtml(backupKindLabel(latest.backupKind))} · ${escapeHtml(backupStatusLabel(latest.status))} · <span title="${escapeHtml(absoluteTime(latest.startedAt))}">${escapeHtml(relativeTime(latest.startedAt))}</span></div>
    ${lastSucceeded && lastSucceeded !== latest
      ? `<div class="meta">Son başarılı: <span title="${escapeHtml(absoluteTime(lastSucceeded.startedAt))}">${escapeHtml(relativeTime(lastSucceeded.startedAt))}</span></div>`
      : ''}
    ${running.length > 0 ? `<div class="meta">${running.length} çalışma sürüyor.</div>` : ''}
    ${/* Kapanmış başarısızlıklar sayı olarak kalıyor: kayıt tutulmuş
          olmasının bir değeri var, ama satır satır göstermenin yok. */
      unresolved.length === 0 && failedTotal > 0
        ? `<div class="meta">Kayıtlı ${rows.length} çalışmanın ${failedTotal}'i geçmişte başarısız olmuş, hepsi sonraki koşularla kapandı.</div>`
        : ''}`;
  host.append(summary);

  /* Yalnız çözülmemişler tek tek yazılıyor: hata kodu olmadan "başarısız"
     demek, bakan kişiye ne yapacağını söylemiyor. */
  for (const run of unresolved) {
    const item = document.createElement('div');
    item.className = 'dashboard-item is-error';
    item.innerHTML = `<strong>${escapeHtml(backupKindLabel(run.backupKind))} · ${escapeHtml(backupStatusLabel(run.status))}</strong><div class="meta">${escapeHtml(absoluteTime(run.startedAt))}${run.errorCode ? ` · ${escapeHtml(run.errorCode)}` : ''}</div>`;
    host.append(item);
  }
}

async function loadMediaTransformUsage() {
  const usage = (await request('/v1/admin/media-transform-usage')).body.usage;
  const remaining = Math.max(0, usage.safetyLimit - usage.attemptedCount);
  byId('media-transform-usage').innerHTML = `<div class="dashboard-item"><strong>${escapeHtml(usage.monthUtc)} · ${escapeHtml(usage.attemptedCount)} / ${escapeHtml(usage.safetyLimit)}</strong><div class="meta">Başarılı: ${escapeHtml(usage.succeededCount)} · Başarısız: ${escapeHtml(usage.failedCount)} · Kalan güvenli yükleme: ${escapeHtml(remaining)}</div>${usage.alert ? '<div class="dashboard-notice error">Yeni medya yüklemeleri güvenlik eşiğine yaklaşıyor.</div>' : ''}</div>`;
}

/* Sunucudaki ANNOUNCEMENT_EMAIL_SEVERITIES ile aynı liste. Panel istemci
   tarafında olduğu için içe aktaramıyor; bir test iki listenin ayrışmadığını
   kontrol ediyor. Buradaki kopya kapı değil, kolaylık — asıl kapı sunucuda,
   çünkü panelin ne gönderdiğine güvenemeyiz. */
const ANNOUNCEMENT_EMAIL_SEVERITIES = ['warning', 'critical'];

/* Postalanamayan bir seviyede kutuyu açık bırakmak, işaretleyen kişiye
   posta gideceğini söylemek olurdu. Kutu kapanıyor ve işaretiyse
   temizleniyor: kapalı ama işaretli bir kutu, seviye geri değişince
   kimsenin istemediği bir postayı geri getirirdi. */
function syncAnnouncementEmailAvailability() {
  const form = byId('announcement-form');
  const box = form.querySelector('input[name="sendEmail"]');
  const allowed = ANNOUNCEMENT_EMAIL_SEVERITIES.includes(form.querySelector('select[name="severity"]').value)
    && form.querySelector('select[name="audienceType"]').value === 'all_agents';
  box.disabled = !allowed;
  if (!allowed) box.checked = false;
  byId('announcement-send-email').classList.toggle('is-disabled', !allowed);
}

async function load() {
  try {
    me = (await request('/v1/me')).body;
  } catch (error) {
    /* Oturum yoksa panele gönderiyoruz: giriş akışı orada duruyor ve
       burada ikinci bir kopyasını tutmanın anlamı yok. */
    if (error.status === 401) { window.location.replace('/dashboard'); return; }
    flash(error.message, 'error');
    return;
  }
  const reviewer = me.account.roles.includes('platform_owner') || me.account.roles.includes('moderator');
  const owner = me.account.roles.includes('platform_owner');
  if (!reviewer && !owner) {
    showView('platform-denied');
    return;
  }
  showView('platform');
  byId('review-card').classList.toggle('hidden', !reviewer);
  for (const id of ['announcement-card', 'media-transform-card', 'backup-card']) {
    byId(id).classList.toggle('hidden', !owner);
  }
  const work = [];
  if (reviewer) work.push(loadApprovals());
  if (owner) {
    syncAnnouncementEmailAvailability();
    work.push(loadAnnouncements(), loadAnnouncementEmailBudget(), loadMediaTransformUsage(), loadBackups());
  }
  try { await Promise.all(work); } catch (error) { flash(error.message, 'error'); }
}

byId('review-approve').addEventListener('click', () => activeReview && decide('approve'));
byId('review-reject').addEventListener('click', () => activeReview && decide('reject'));
byId('review-close').addEventListener('click', () => { activeReview = null; byId('review-dialog').close(); });
byId('backup-run').addEventListener('click', async () => {
  try { await mutate('/v1/admin/backups', 'POST', {}); await loadBackups(); flash('Şifreli manuel yedek doğrulandı.'); }
  catch (error) { await loadBackups(); flash(error.message, 'error'); }
});

for (const name of ['severity', 'audienceType']) {
  byId('announcement-form').querySelector(`select[name="${name}"]`)
    .addEventListener('change', syncAnnouncementEmailAvailability);
}

byId('announcement-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const audienceType = data.get('audienceType');
  const form = event.currentTarget;
  /* Tek tuş. API hâlâ önce taslak kurup sonra yayımlıyor — durum makinesi
     orada kalıyor — ama bu iki adımı yazan kişiye yaptırmanın bir karşılığı
     yoktu. İkinci çağrı düşerse taslak ortada kalır; bunu susmak yerine
     söylüyoruz, çünkü listede duran yayımlanmamış bir taslak sessizce
     "yayımladım" sanılmaktan iyidir. */
  let created;
  try {
    created = (await mutate('/v1/admin/announcements', 'POST', {
      title: data.get('title'), bodyMarkdown: data.get('bodyMarkdown'), severity: data.get('severity'), audienceType,
      targetAgentId: audienceType === 'agent' ? data.get('targetAgentId') : null, startsAt: Date.now(), expiresAt: null,
    })).body.announcement;
  } catch (error) { flash(error.message, 'error'); return; }
  /* Posta yalnız herkese açık VE uyarı/kritik duyuruda mümkün; API de
     ikisini birden reddediyor. Kutu işaretli kalıp hedef ajana çevrilse,
     o kişiye özel bir duyuru bütün sponsorlara gitmiş olurdu; bilgi
     seviyesine çevrilse kotayı önemsiz duyurulara harcardık. */
  const sendEmail = data.get('sendEmail') === 'on'
    && audienceType === 'all_agents'
    && ANNOUNCEMENT_EMAIL_SEVERITIES.includes(data.get('severity'));
  try {
    await mutate(`/v1/admin/announcements/${encodeURIComponent(created.id)}/publish`, 'POST', { sendEmail });
    form.reset();
    syncAnnouncementEmailAvailability();
    await Promise.all([loadAnnouncements(), loadAnnouncementEmailBudget()]);
    const base = audienceType === 'all_agents' ? 'Duyuru yayımlandı — herkese görünür.' : 'Duyuru yayımlandı.';
    /* "Kuyruğa alındı" ile "gönderildi" farklı şeyler ve panel bunu
       karıştırmamalı: kuyruk beş dakikada bir boşalıyor ve gönderim
       kapalıysa hiç boşalmıyor. */
    flash(sendEmail ? `${base} E-postalar kuyruğa alındı.` : base);
  } catch (error) {
    await loadAnnouncements();
    flash(`Duyuru oluşturuldu ama YAYIMLANMADI: ${error.message} Listeden Yayımla ile tamamlayabilirsin.`, 'error');
  }
});

load();
