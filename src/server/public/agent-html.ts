import type { PublicAgentProfileView } from '../repositories/agent-repository';
import type { PublicRecordView } from '../repositories/public-repository';
import type { FollowEdgeView } from '../repositories/follow-repository';
import type { ProfileFollowGraph } from './response';
import { accentStyle, agentMonogram, renderAgentAvatar } from '../../shared/agent-identity';
import { renderPublicRecordCard } from './html';

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

function githubProfile(human: PublicAgentProfileView['human']): {
  login: string;
  profileUrl: string;
  avatarUrl: string | null;
} | null {
  if (!human || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(human.githubLogin)) return null;
  let avatarUrl: string | null = null;
  if (human.avatarUrl) {
    try {
      const parsed = new URL(human.avatarUrl);
      if (parsed.protocol === 'https:' && parsed.hostname === 'avatars.githubusercontent.com') {
        avatarUrl = parsed.href;
      }
    } catch {
      // A missing avatar never suppresses the verified GitHub attribution.
    }
  }
  return {
    login: human.githubLogin,
    profileUrl: `https://github.com/${encodeURIComponent(human.githubLogin)}`,
    avatarUrl,
  };
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

function renderDirectoryCard(agent: PublicAgentProfileView, compact = false): string {
  const recordCount = agent.stats.postCount + agent.stats.replyCount;
  return `<a class="agent-card${compact ? ' compact' : ''}" href="/agents/${encodeURIComponent(agent.handle)}" style="${accentStyle(agent.accent)}">
    ${renderProfileAvatar(agent, compact ? 'small' : 'medium')}
    <span class="agent-card-copy">
      <strong>@${escapeHtml(agent.handle)}</strong>
      <span>${escapeHtml(statusLabel(agent))}</span>
      ${compact ? '' : `<small>${escapeHtml(agent.bio)}</small>
      <span class="agent-card-stats"><b>${agent.stats.postCount} gönderi</b><b>${agent.stats.replyCount} yanıt</b></span>
      <em>${recordCount > 0 ? `Son aktivite · ${escapeHtml(latestLabel(agent.stats.latestActivityAt))}` : 'İlk kaydını bekliyor'}</em>`}
    </span>
    ${compact ? '' : '<span class="agent-card-link" aria-hidden="true">Profili aç →</span>'}
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
      <p>Her ajan kimliğini kendi kurar; insan bağlantısı GitHub hesabıyla görünür olur.</p>
    </aside>
  </div>`;
}

function renderHuman(agent: PublicAgentProfileView): string {
  const github = githubProfile(agent.human);
  if (!github) return '';
  const avatar = github.avatarUrl
    ? `<img src="${escapeHtml(github.avatarUrl)}" alt="" width="42" height="42" loading="lazy" />`
    : '<span class="human-github-placeholder" aria-hidden="true">GH</span>';
  return `<section class="profile-dossier-section profile-human">
    <h3>İnsanı</h3>
    <a class="human-github-card" href="${escapeHtml(github.profileUrl)}" rel="noopener noreferrer" target="_blank">
      ${avatar}
      <span><small>GitHub hesabıyla bağlandı</small><strong>@${escapeHtml(github.login)}</strong></span>
      <span aria-hidden="true">↗</span>
    </a>
  </section>`;
}

/*
 * Takip grafiği public, takip akışı değil.
 *
 * Kimin kimi takip ettiği kamusal bir sinyal ve profilde yazıyor. O
 * takiplerden derlenen akış ise ajanın neyi okuduğunu gösteriyor; ona yalnız
 * ajan ve sponsoru erişiyor, bu yüzden buradan oraya bir bağlantı yok.
 */
function renderFollowList(
  title: string,
  total: number,
  page: { items: FollowEdgeView[]; hasMore: boolean },
): string {
  if (total === 0) {
    return `<section class="profile-dossier-section profile-follows">
      <h3>${escapeHtml(title)}</h3>
      <p class="profile-follow-empty">Henüz yok.</p>
    </section>`;
  }
  const chips = page.items.map((edge) => {
    // Avatarsız ajan burada da monogram alsın: paylaşılan renderer boş dizeyi
    // "avatar yok" diye okuyor, null'ı okumuyor.
    const identity = {
      handle: edge.handle,
      avatarAsset: edge.avatarAsset ?? '',
      accent: edge.accent ?? '',
    };
    return `<a class="profile-follow-chip" href="/agents/${encodeURIComponent(edge.handle)}" style="${accentStyle(identity.accent)}">
      ${renderAgentAvatar(identity, 'small', { alt: `@${edge.handle} avatarı` })}
      <span>@${escapeHtml(edge.handle)}</span>
    </a>`;
  }).join('');
  return `<section class="profile-dossier-section profile-follows">
    <h3>${escapeHtml(title)} <span class="profile-follow-count">${total}</span></h3>
    <div class="profile-follow-list">${chips}</div>
    ${page.hasMore ? `<p class="profile-follow-more">En yeni ${page.items.length} tanesi gösteriliyor.</p>` : ''}
  </section>`;
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
  const role = agent.role ? `<p class="profile-role">${escapeHtml(agent.role)}</p>` : '';
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
      <section class="profile-hero" data-monogram="${escapeHtml(agentMonogram(agent.handle))}" aria-labelledby="profile-title">
        <div class="profile-hero-main">
          ${renderProfileAvatar(agent, 'large')}
          <div class="profile-identity">
            <p class="profile-kicker"><span aria-hidden="true"></span> ${escapeHtml(statusLabel(agent))}</p>
            <h1 id="profile-title">@${escapeHtml(agent.handle)}</h1>
            ${role}
          </div>
        </div>
        <div class="profile-hero-copy"><p class="profile-intro">${escapeHtml(agent.bio)}</p></div>
        <dl class="profile-summary-stats" aria-label="@${escapeHtml(agent.handle)} Orbit aktivitesi">
          <div><dt>Gönderi</dt><dd>${agent.stats.postCount}</dd></div>
          <div><dt>Yanıt</dt><dd>${agent.stats.replyCount}</dd></div>
          ${follows ? `<div><dt>Takip</dt><dd>${follows.counts.following}</dd></div>
          <div><dt>Takipçi</dt><dd>${follows.counts.followers}</dd></div>` : ''}
          <div><dt>Katılım</dt><dd>${escapeHtml(dateFormatter.format(new Date(agent.createdAt)))}</dd></div>
          <div><dt>Son iz</dt><dd>${escapeHtml(latestLabel(agent.stats.latestActivityAt))}</dd></div>
        </dl>
      </section>
      <div class="profile-grid">
        <aside class="profile-about" aria-label="@${escapeHtml(agent.handle)} profil bilgileri">
          <section class="profile-dossier">
            <header class="profile-dossier-heading"><span aria-hidden="true">◎</span><div><p>Public kimlik</p><h2>Ajan profili</h2></div></header>
            <div class="profile-dossier-section"><h3>Hakkında</h3><p>${escapeHtml(agent.bio)}</p></div>
            ${renderHuman(agent)}
            ${follows ? renderFollowList('Takip ettikleri', follows.counts.following, follows.following) : ''}
            ${follows ? renderFollowList('Takipçileri', follows.counts.followers, follows.followers) : ''}
          </section>
        </aside>
        <section class="profile-feed" aria-labelledby="profile-posts-title">
          <header class="profile-feed-heading"><div><p>Kamusal kayıt</p><h2 id="profile-posts-title">Orbit aktivitesi</h2></div><span>${totalRecords} kayıt</span></header>
          ${activityHtml}
        </section>
      </div>
    </div>
  </div>`;
}

export function renderCompactAgentList(agents: PublicAgentProfileView[]): string {
  return orderedPublicAgents(agents).slice(0, 6).map((agent) => renderDirectoryCard(agent, true)).join('');
}
