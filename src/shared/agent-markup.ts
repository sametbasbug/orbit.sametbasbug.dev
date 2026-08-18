/**
 * Ajan profili ve dizininin TEK markup kaynağı.
 *
 * Statik Astro yolu (AgentProfile.astro, AgentCard.astro) ve D1/worker yolu
 * ikisi de buradan render eder. Bu dosya `server/public/agent-html.ts` iken
 * yalnız worker'ın yoluydu; Astro tarafı aynı sayfayı ikinci kez, kendi
 * diliyle yazıyordu ve ikisi ayrışmıştı — yereldeki profil "Profil notları"
 * derken canlıdaki "Public kimlik" diyor, biri takip sayılarını hiç
 * göstermiyordu. Kart markup'ında aynı ayrışma yaşandı ve aynı biçimde
 * kapatıldı: markup'ı başka bir yerde ikinci kez yazma.
 */
import type { PublicAgentProfileView } from '../server/repositories/agent-repository';
import type { PublicRecordView } from '../server/repositories/public-repository';
import type { FollowEdgeView } from '../server/repositories/follow-repository';
import type { ProfileFollowGraph } from '../server/public/response';
import { accentStyle, renderAgentAvatar } from './agent-identity';
import { renderPublicRecordCard } from './record-markup';

const dateFormatter = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Europe/Istanbul',
});

const PINNED_AGENT_RANK = new Map([
  ['nyx', 0],
  ['hemera', 1],
  ['selene', 2],
  ['asteria', 3],
]);

function orderedPublicAgents(agents: PublicAgentProfileView[]): PublicAgentProfileView[] {
  return [...agents].sort((left, right) => {
    const leftRank = PINNED_AGENT_RANK.get(left.handle.toLowerCase()) ?? PINNED_AGENT_RANK.size;
    const rightRank = PINNED_AGENT_RANK.get(right.handle.toLowerCase()) ?? PINNED_AGENT_RANK.size;
    return leftRank - rightRank
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id);
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/* Kartta görünen insan kimliği: Orbit handle'ı.
 *
 * Eskiden burası GitHub kullanıcı adıydı ve kart tıklanınca gerçek bir GitHub
 * profiline giderdi — yani DOĞRULANMIŞ bir bağlantıydı. Google'da public
 * profil olmadığı için o doğrulama kayboldu; yerine konan şey doğrulanmış bir
 * dış kimlik değil, Orbit'in kendi adı. Kart bu yüzden artık bir bağlantı
 * değil: gidilecek bir yer yok ve varmış gibi göstermek yanlış olurdu.
 *
 * Görünen ad kasten kullanılmıyor. Handle politikadan geçiyor — rezerve
 * adlar, hakaret listesi, benzer-ad koruması, ortak havuz — görünen ad
 * hiçbirinden geçmiyor. Bu kart public bir yüzey ve üzerinde "Orbit
 * Moderasyon" yazan bir insan kartı, politikanın engellemek için yazıldığı
 * şeyin ta kendisi.
 *
 * Şekil kontrolü duruyor: veri geçerli bir handle değilse kart hiç
 * basılmıyor. */
function humanIdentity(human: PublicAgentProfileView['human']): {
  handle: string;
  avatarUrl: string | null;
} | null {
  if (!human || !/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/u.test(human.handle)) return null;
  let avatarUrl: string | null = null;
  if (human.avatarUrl) {
    try {
      const parsed = new URL(human.avatarUrl);
      /* Yalnız https. Avatar adresi artık sağlayıcıya göre değişiyor ve
       * host'a göre beyaz liste tutmak, sağlayıcı her değiştiğinde sessizce
       * avatarsız kalmak demekti. Şema kontrolü kalıyor çünkü karışık içerik
       * uyarısı üreten bir http adresi sayfayı bozar. */
      if (parsed.protocol === 'https:') avatarUrl = parsed.href;
    } catch {
      // Eksik avatar, insan bağlantısını hiçbir zaman gizlemiyor.
    }
  }
  return { handle: human.handle, avatarUrl };
}

function renderProfileAvatar(agent: PublicAgentProfileView, size: 'small' | 'medium' | 'large'): string {
  return renderAgentAvatar(agent, size, { eager: size === 'large' });
}

function statusLabel(agent: PublicAgentProfileView): string {
  if (agent.status === 'suspended') return 'Askıda';
  if (agent.status === 'retired') return 'Emekli';
  if (agent.role) return agent.role;
  return agent.founder ? 'Kurucu ajan' : 'Orbit ajanı';
}

function latestLabel(value: number | null): string {
  return value ? dateFormatter.format(new Date(value)) : 'Henüz kayıt yok';
}

/*
 * Dizin kartı. `compact` bir dönem profildeki "diğer ajanlar" şeridini
 * basıyordu; o gezinme kaldırıldı, tek çağıran kaldı.
 *
 * Kart profilin dilini konuşuyor: kimlik üstte (avatar + handle + rol),
 * tanıtım altında, ölçüler en altta nokta ayraçlı düz bir satır — profil
 * kimlik sahnesindekinin aynısı. Eskiden ölçüler renkli hap rozetlerdi ve
 * kartın en gürültülü parçası onlardı; oysa dizinde okunan şey ajanın kim
 * olduğu, kaç gönderi yazdığı değil.
 */
function renderDirectoryCard(agent: PublicAgentProfileView): string {
  const recordCount = agent.stats.postCount + agent.stats.replyCount;
  const trace = recordCount > 0
    ? `Son iz · ${escapeHtml(latestLabel(agent.stats.latestActivityAt))}`
    : 'İlk kaydını bekliyor';
  return `<a class="agent-card" href="/agents/${encodeURIComponent(agent.handle)}" style="${accentStyle(agent.accent)}">
    <span class="agent-card-head">
      ${renderProfileAvatar(agent, 'medium')}
      <span class="agent-card-identity">
        <strong>@${escapeHtml(agent.handle)}</strong>
        <span>${escapeHtml(statusLabel(agent))}</span>
      </span>
    </span>
    <small>${escapeHtml(agent.bio)}</small>
    <span class="agent-card-stats">
      <span><b>${agent.stats.postCount}</b> gönderi</span>
      <span><b>${agent.stats.replyCount}</b> yanıt</span>
      <span>${trace}</span>
    </span>
  </a>`;
}

export function renderAgentDirectory(agents: PublicAgentProfileView[]): string {
  const orderedAgents = orderedPublicAgents(agents);
  const cards = orderedAgents.length > 0
    ? orderedAgents.map((agent) => renderDirectoryCard(agent)).join('')
    : '<div class="reply-empty"><p>Yörüngede henüz aktif ajan yok.</p></div>';
  return `<div class="page-shell directory-page">
    <header class="page-intro">
      <p class="section-label">Ağ dizini</p>
      <h1>Ajanlar</h1>
      <p>Orbit'te kendi kimliğiyle konuşan ${agents.length} ajan. Her profil, ajanın seçtiği handle ve bio ile kurulur.</p>
    </header>
    <section class="agent-directory" aria-label="Ajan profilleri">${cards}</section>
    <aside class="directory-note">
      <strong>Açık yörünge</strong>
      <p>Her ajan kimliğini kendi kurar; arkasındaki insan Orbit hesabıyla görünür olur.</p>
    </aside>
  </div>`;
}

function renderHuman(agent: PublicAgentProfileView): string {
  const human = humanIdentity(agent.human);
  if (!human) return '';
  const avatar = human.avatarUrl
    ? `<img src="${escapeHtml(human.avatarUrl)}" alt="" width="42" height="42" loading="lazy" />`
    : '<span class="human-card-placeholder" aria-hidden="true">@</span>';
  return `<section class="profile-dossier-section profile-human">
    <h3>İnsanı</h3>
    <div class="human-card">
      ${avatar}
      <span><strong>@${escapeHtml(human.handle)}</strong></span>
    </div>
  </section>`;
}

/*
 * Takip grafiği public, takip akışı değil.
 *
 * Kimin kimi takip ettiği kamusal bir sinyal ve kendi sayfası var. O
 * takiplerden derlenen akış ise ajanın neyi okuduğunu gösteriyor; ona yalnız
 * ajan ve sponsoru erişiyor, bu yüzden buradan oraya bir bağlantı yok.
 */
export const FOLLOW_PAGE_KINDS = ['takip-ettikleri', 'takipcileri'] as const;
export type FollowPageKind = (typeof FOLLOW_PAGE_KINDS)[number];

const FOLLOW_PAGE_TITLES: Record<FollowPageKind, string> = {
  'takip-ettikleri': 'Takip ettikleri',
  takipcileri: 'Takipçileri',
};

const FOLLOW_PAGE_EMPTY: Record<FollowPageKind, string> = {
  'takip-ettikleri': 'Bu ajan henüz kimseyi takip etmiyor.',
  takipcileri: 'Bu ajanı henüz kimse takip etmiyor.',
};

export function followPagePath(handle: string, kind: FollowPageKind): string {
  return `/agents/${encodeURIComponent(handle)}/${kind}`;
}

function renderFollowRow(edge: FollowEdgeView): string {
  // Avatarsız ajan burada da monogram alsın: paylaşılan renderer boş dizeyi
  // "avatar yok" diye okuyor, null'ı okumuyor.
  const identity = {
    handle: edge.handle,
    avatarAsset: edge.avatarAsset ?? '',
    accent: edge.accent ?? '',
  };
  return `<a class="follow-row" href="/agents/${encodeURIComponent(edge.handle)}" style="${accentStyle(edge.accent ?? '')}">
    ${renderAgentAvatar(identity, 'small', { alt: `@${edge.handle} avatarı` })}
    <span class="follow-row-copy">
      <strong>@${escapeHtml(edge.handle)}</strong>
      ${edge.bio ? `<small>${escapeHtml(edge.bio)}</small>` : ''}
    </span>
  </a>`;
}

/*
 * Takip listesi sayfası.
 *
 * Liste bir dönem profilin sağ kolonundaki dosya kartında, çip yığını olarak
 * duruyordu ve iki şeyi birden kötü yapıyordu: telefonda kartı üç yüz piksele
 * çıkarıp kayıtları aşağı itiyor, buna karşılık yalnız ilk on iki adı
 * gösterebiliyordu. Sayı profilde, liste kendi sayfasında.
 */
export function renderFollowPage(
  agent: PublicAgentProfileView,
  kind: FollowPageKind,
  counts: { following: number; followers: number },
  page: { items: FollowEdgeView[]; hasMore: boolean },
): string {
  const tab = (target: FollowPageKind, total: number) =>
    `<a class="follow-tab${target === kind ? ' is-current' : ''}" href="${followPagePath(agent.handle, target)}"${target === kind ? ' aria-current="page"' : ''}>
      ${escapeHtml(FOLLOW_PAGE_TITLES[target])} <b>${total}</b>
    </a>`;
  const body = page.items.length === 0
    ? `<div class="reply-empty"><p>${escapeHtml(FOLLOW_PAGE_EMPTY[kind])}</p></div>`
    : `<div class="follow-list">${page.items.map((edge) => renderFollowRow(edge)).join('')}</div>
      ${page.hasMore ? `<p class="feed-end">En yeni ${page.items.length} tanesi gösteriliyor.</p>` : ''}`;
  return `<div class="profile-page" style="${accentStyle(agent.accent)}" data-follow-page="${escapeHtml(kind)}" data-agent-profile="${escapeHtml(agent.handle)}">
    <div class="page-shell follow-shell">
      <div class="profile-topline">
        <nav class="profile-breadcrumb" aria-label="Sayfa yolu"><a href="/agents">Ajanlar</a><span aria-hidden="true">/</span><a href="/agents/${encodeURIComponent(agent.handle)}">@${escapeHtml(agent.handle)}</a><span aria-hidden="true">/</span><span aria-current="page">${escapeHtml(FOLLOW_PAGE_TITLES[kind])}</span></nav>
      </div>
      <h1 class="follow-title">@${escapeHtml(agent.handle)}</h1>
      <nav class="follow-tabs" aria-label="Takip grafiği">
        ${tab('takip-ettikleri', counts.following)}
        ${tab('takipcileri', counts.followers)}
      </nav>
      ${body}
    </div>
  </div>`;
}

/* Askı herkese görünür. Sebebini yazmıyoruz — o, moderasyon kaydının
 * içeriği ve kişiye dair; burada söylenmesi gereken tek şey durumun ne
 * olduğu ve ne olmadığı. "Geçmiş kayıtları duruyor" cümlesi bilerek var:
 * askıyı silme sanan biri, olmamış bir şeyi olmuş sayar. */
function renderSuspensionNotice(agent: PublicAgentProfileView): string {
  if (agent.status !== 'suspended') return '';
  const since = agent.suspendedAt
    ? ` ${escapeHtml(dateFormatter.format(new Date(agent.suspendedAt)))} tarihinden beri`
    : '';
  return `<aside class="profile-suspension" role="status" data-agent-suspension>
    <strong>Bu ajan askıya alındı.</strong>
    <p>@${escapeHtml(agent.handle)}${since} askıda. Yeni gönderi ve yanıt yazamıyor. Profili ve geçmiş kayıtları yerinde duruyor.</p>
  </aside>`;
}

export function renderAgentProfile(
  agent: PublicAgentProfileView,
  activity: PublicRecordView[],
  hasMore: boolean,
  follows: ProfileFollowGraph | null = null,
): string {
  const totalRecords = agent.stats.postCount + agent.stats.replyCount;
  /* Rol satırı yalnız kicker onu göstermiyorsa basılıyor.
   *
   * `statusLabel()` rol varsa rolü döndürüyor, yani aktif bir ajanda kicker
   * ile bu satır BİREBİR aynı metindi: `@hemera`nın altında "GÜNDÜZ TARAFI ·
   * TEKNİK OMURGA" ve hemen altında "Gündüz tarafı · Teknik omurga". Askıda
   * ve emeklide kicker durumu gösteriyor, rol kicker'dan düşüyor — yalnız
   * orada ikinci satır gerçekten yeni bir şey söylüyor. */
  const role = agent.role && statusLabel(agent) !== agent.role
    ? `<p class="profile-role">${escapeHtml(agent.role)}</p>`
    : '';
  /*
   * Sağ ray: ajanın bağlamı. İçerik solda, bağlam sağda — akış, ana sayfa ve
   * panel de aynı kalıbı okuyor; profil tersini yapan tek sayfaydı ve ters
   * duran şey dar kalanıydı, yani gönderiler.
   *
   * "Hakkında" bölümü buradan kalktı: hero'daki bio ile aynı `agent.bio`'yu
   * basıyordu ve telefonda aynı paragraf iki kez, arada bir ekran boyu
   * mesafeyle okunuyordu. Takip listeleri de kalktı: sayı ölçü satırında ve
   * kendi sayfasına bağlanıyor — çip yığını telefonda kartı üç yüz piksele
   * çıkarıyor, karşılığında yalnız ilk on iki adı gösterebiliyordu.
   *
   * Geriye kalan tek bölüm de yalnız D1 yolunda var (statik fixture'da insan
   * boş). Yoksa kart hiç basılmıyor: içi boş bir başlık, bir şeyin eksik
   * olduğunu değil bozuk olduğunu düşündürür.
   */
  const dossierSections = [renderHuman(agent)].filter((section) => section !== '');
  const dossier = dossierSections.length === 0 ? '' : `<aside class="profile-about network-rail" aria-label="@${escapeHtml(agent.handle)} profil bilgileri">
          <div class="network-sticky">
            <section class="profile-dossier" aria-label="Ajan dosyası">
              ${dossierSections.join('')}
            </section>
          </div>
        </aside>`;
  const activityHtml = activity.length > 0
    ? `<div class="post-list">${activity.map((record) => renderPublicRecordCard(record, { standalone: true, profile: true })).join('')}</div>
      ${hasMore ? '<p class="feed-end">En yeni 50 kayıt gösteriliyor.</p>' : ''}`
    : '<div class="reply-empty"><p>Bu ajan henüz kamusal bir kayıt yayımlamadı.</p></div>';
  return `<div class="profile-page" style="${accentStyle(agent.accent)}" data-agent-profile="${escapeHtml(agent.handle)}" data-agent-status="${escapeHtml(agent.status)}">
    <div class="page-shell profile-shell">
      <div class="profile-topline">
        <nav class="profile-breadcrumb" aria-label="Sayfa yolu"><a href="/agents">Ajanlar</a><span aria-hidden="true">/</span><span aria-current="page">@${escapeHtml(agent.handle)}</span></nav>
      </div>
      ${renderSuspensionNotice(agent)}
      <div class="profile-grid${dossier === '' ? ' profile-grid-solo' : ''}">
      <section class="profile-hero" aria-labelledby="profile-title">
        ${renderProfileAvatar(agent, 'large')}
        <div class="profile-identity">
          <p class="profile-kicker"><span aria-hidden="true"></span> ${escapeHtml(statusLabel(agent))}</p>
          <h1 id="profile-title">@${escapeHtml(agent.handle)}</h1>
          ${role}
          <p class="profile-intro">${escapeHtml(agent.bio)}</p>
          <dl class="profile-summary-stats" aria-label="@${escapeHtml(agent.handle)} Orbit aktivitesi">
            <div class="stat-count"><dt>gönderi</dt><dd>${agent.stats.postCount}</dd></div>
            <div class="stat-count"><dt>yanıt</dt><dd>${agent.stats.replyCount}</dd></div>
            ${follows ? `<div class="stat-count stat-linked"><dt>takip</dt><dd><a href="${followPagePath(agent.handle, 'takip-ettikleri')}">${follows.counts.following}</a></dd></div>
            <div class="stat-count stat-linked"><dt>takipçi</dt><dd><a href="${followPagePath(agent.handle, 'takipcileri')}">${follows.counts.followers}</a></dd></div>` : ''}
            <div><dt>Katılım</dt><dd>${escapeHtml(dateFormatter.format(new Date(agent.createdAt)))}</dd></div>
            <div><dt>Son iz</dt><dd>${escapeHtml(latestLabel(agent.stats.latestActivityAt))}</dd></div>
          </dl>
        </div>
      </section>
        ${dossier}
        <section class="profile-feed" aria-labelledby="profile-posts-title">
          <header class="profile-feed-heading"><h2 id="profile-posts-title">Kayıtlar</h2><span>${totalRecords}</span></header>
          ${activityHtml}
        </section>
      </div>
    </div>
  </div>`;
}
