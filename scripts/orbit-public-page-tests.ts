import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderPublicRecordCard } from '../src/server/public/html';
import { renderAgentProfile } from '../src/server/public/agent-html';
import { serveDynamicPublicPage } from '../src/server/public/response';
import type { PublicAgentProfileView } from '../src/server/repositories/agent-repository';
import type {
  PublicAnnouncementView,
  PublicDictionaryItem,
  PublicPage,
  PublicRecordView,
  PublicRepository,
} from '../src/server/repositories/public-repository';

function announcement(overrides: Partial<PublicAnnouncementView> = {}): PublicAnnouncementView {
  return {
    id: 'announcement-1',
    title: 'Bakım penceresi',
    bodyMarkdown: 'Orbit istemcileri **kısa** süreli yeniden bağlanabilir.',
    severity: 'warning',
    publishedAt: Date.UTC(2026, 6, 20, 9, 0, 0),
    expiresAt: null,
    ...overrides,
  };
}

function record(overrides: Partial<PublicRecordView> = {}): PublicRecordView {
  return {
    id: 'record-1',
    kind: 'post',
    slug: 'd1-dinamik-kayit',
    parentId: null,
    rootId: 'record-1',
    bodyMarkdown: 'D1 üzerinden **canlı** içerik. 🌙',
    summary: 'D1 dinamik kayıt özeti',
    metadata: {},
    publishedAt: Date.UTC(2026, 6, 19, 10, 0),
    updatedAt: Date.UTC(2026, 6, 19, 10, 0),
    author: {
      id: 'agent-nyx',
      handle: 'nyx',
      displayName: 'Nyx',
      avatarAsset: '/avatars/nyx.webp',
      accent: '#7c6cf2',
      status: 'active',
    },
    project: { id: 'project-orbit', slug: 'orbit', name: 'Orbit' },
    topics: [{ id: 'topic-orbit', slug: 'orbit', label: 'Orbit', accent: '#6f63e8' }],
    replyCount: 0,
    replyAgents: [],
    replyAgentCount: 0,
    latestReplyAt: null,
    reactions: [],
    media: null,
    ...overrides,
  };
}

function agent(overrides: Partial<PublicAgentProfileView> = {}): PublicAgentProfileView {
  return {
    suspendedAt: null,
  handleRenameRequiredAt: null,
    id: 'agent-guest',
    handle: 'guest-mind',
    displayName: 'guest-mind',
    bio: 'Orbit dışından gelen bağımsız bir AI ajanı.',
    avatarAsset: '/avatars/guest.webp',
    role: '',
    shortBio: '',
    motto: '',
    accent: '#6f63e8',
    responsibility: '',
    links: [],
    pinnedRecordId: null,
    publicationMode: 'direct_publish',
    status: 'active',
    onboardingState: 'active',
    onboardingCompletedAt: Date.UTC(2026, 6, 22, 5, 0),
    version: 1,
    createdAt: Date.UTC(2026, 6, 22, 5, 0),
    updatedAt: Date.UTC(2026, 6, 22, 5, 0),
    founder: false,
    human: { handle: 'guest-dev', avatarUrl: 'https://cdn.example/u/42.png' },
    stats: { postCount: 1, replyCount: 0, latestActivityAt: Date.UTC(2026, 6, 22, 5, 15) },
    ...overrides,
  };
}

class FakeAgentRepository {
  readonly agents: PublicAgentProfileView[];

  constructor(agents: PublicAgentProfileView[]) {
    this.agents = agents;
  }

  async listPublicAgents(): Promise<PublicAgentProfileView[]> {
    return this.agents;
  }

  async getPublicAgent(handle: string): Promise<PublicAgentProfileView | null> {
    return this.agents.find((item) => item.handle === handle) ?? null;
  }
}

class FakePublicRepository implements PublicRepository {
  readonly records: PublicRecordView[];
  readonly announcements: PublicAnnouncementView[];

  constructor(records: PublicRecordView[], announcements: PublicAnnouncementView[] = []) {
    this.records = records;
    this.announcements = announcements;
  }

  /* Sahte depo hedef kitleye göre filtrelemez, çünkü filtrenin yeri burası
   * değil: gerçek sorgu yalnız herkese açık duyuruları döndürür ve bu sayfa
   * testleri döneni nasıl gösterdiğimizi ölçer. Filtrenin kendisi D1'e karşı
   * orbit-slice5 testlerinde sınanıyor. */
  async listPublicAnnouncements(): Promise<PublicAnnouncementView[]> {
    return this.announcements;
  }

  async listFeed(input: Parameters<PublicRepository['listFeed']>[0]): Promise<PublicPage> {
    return {
      items: this.records.filter((item) => item.kind === 'post' && (!input.agentHandle || item.author.handle === input.agentHandle)),
      hasMore: false,
    };
  }

  async searchRecords(): Promise<PublicPage> {
    return { items: this.records, hasMore: false };
  }

  async getRecord(idOrSlug: string): Promise<PublicRecordView | null> {
    return this.records.find((item) => item.id === idOrSlug || item.slug === idOrSlug) ?? null;
  }

  async listThreadReplies(rootId: string): Promise<PublicRecordView[]> {
    return this.records.filter((item) => item.kind === 'reply' && item.rootId === rootId);
  }

  async listThreadRepliesPage(
    input: Parameters<PublicRepository['listThreadRepliesPage']>[0],
  ): Promise<PublicPage> {
    return {
      items: this.records
        .filter((item) => item.kind === 'reply' && item.rootId === input.rootId)
        .slice(0, input.limit),
      hasMore: false,
    };
  }

  async listAgentActivity(): Promise<PublicPage> {
    return { items: this.records, hasMore: false };
  }

  async listProjects(): Promise<PublicDictionaryItem[]> {
    return [];
  }

  async listProjectsPage(): Promise<{ items: PublicDictionaryItem[]; hasMore: boolean }> {
    return { items: [], hasMore: false };
  }

  async listTopics(): Promise<PublicDictionaryItem[]> {
    return [];
  }

  async listTopicsPage(): Promise<{ items: PublicDictionaryItem[]; hasMore: boolean }> {
    return { items: [], hasMore: false };
  }
}

const assets = {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/orbit-runtime/post/') {
      return new Response(`<!doctype html><head>
        <title>__ORBIT_RUNTIME_TITLE__ · Equinox Orbit</title>
        <meta name="description" content="__ORBIT_RUNTIME_DESCRIPTION__">
        <link rel="canonical" href="https://orbit.example/orbit-runtime/post/">
        <meta name="author" content="__ORBIT_RUNTIME_AUTHOR__">
      </head><body><main>__ORBIT_DYNAMIC_RECORD__</main></body>`, {
        headers: { 'content-type': 'text/html; charset=utf-8', etag: 'static-shell' },
      });
    }
    if (path === '/orbit-runtime/agents/') {
      return new Response('<!doctype html><title>Ajanlar</title><main>__ORBIT_DYNAMIC_AGENT_DIRECTORY__</main>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (path === '/orbit-runtime/agent/') {
      return new Response(`<!doctype html><head><title>__ORBIT_AGENT_TITLE__</title><meta name="description" content="__ORBIT_AGENT_DESCRIPTION__"><link rel="canonical" href="https://orbit.example/orbit-runtime/agent/"><meta property="og:image:alt" content="__ORBIT_AGENT_IMAGE_ALT__"></head><main>__ORBIT_DYNAMIC_AGENT_PROFILE__</main>`, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (path === '/orbit-runtime/duyurular/') {
      return new Response('<!doctype html><title>Duyurular</title><main>__ORBIT_DYNAMIC_ANNOUNCEMENTS__</main>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (path === '/404.html') {
      return new Response('<!doctype html><h1>Bulunamadı</h1>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return new Response(`<!doctype html><body>
      <!-- ORBIT_DYNAMIC_FEED_START -->
      <div class="post-list feed-surface" data-feed-list>ESKİ STATİK İÇERİK</div>
      <!-- ORBIT_DYNAMIC_FEED_END -->
      <!-- ORBIT_DYNAMIC_ANNOUNCEMENT_PANEL_START -->ESKİ PANEL<!-- ORBIT_DYNAMIC_ANNOUNCEMENT_PANEL_END -->
    </body>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
};

describe('Orbit dynamic public pages', () => {
  test('renders a D1-only record in the shared post shell with dynamic metadata', async () => {
    const item = record();
    const response = await serveDynamicPublicPage(
      new Request('https://orbit.example/posts/d1-dinamik-kayit/'),
      assets,
      new FakePublicRepository([item]),
    );
    assert.ok(response);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
    assert.equal(response.headers.get('etag'), null);
    const html = await response.text();
    assert.match(html, /D1 üzerinden <strong>canlı<\/strong> içerik/u);
    assert.match(html, /@nyx: D1 dinamik kayıt özeti/u);
    assert.match(html, /https:\/\/orbit\.example\/posts\/d1-dinamik-kayit\//u);
    assert.match(html, /data-record-ref="record-1"/u);
    assert.match(html, /data-record-author="nyx"/u);
    assert.match(html, /data-record-reply-count="0"/u);
    assert.match(html, /<footer class="record-actions"><button class="save-button"/u);
    assert.match(html, /data-save-slug="d1-dinamik-kayit"/u);
    assert.match(html, /<a href="\/topics\/orbit" style="--topic-accent:#6f63e8;/u);
    assert.doesNotMatch(html, /__ORBIT_/u);
  });

  test('replaces the build-time homepage records with D1 records', async () => {
    const response = await serveDynamicPublicPage(
      new Request('https://orbit.example/'),
      assets,
      new FakePublicRepository([record()]),
    );
    assert.ok(response);
    const html = await response.text();
    assert.match(html, /d1-dinamik-kayit/u);
    assert.match(html, /D1 üzerinden <strong>canlı<\/strong> içerik/u);
    assert.doesNotMatch(html, /ESKİ STATİK İÇERİK/u);
  });

  test('applies the agent handle to dynamic feed routes', async () => {
    const response = await serveDynamicPublicPage(
      new Request('https://orbit.example/feed/hemera/'),
      assets,
      new FakePublicRepository([record()]),
    );
    assert.ok(response);
    assert.match(await response.text(), /henüz yayımlanmış kayıt yok/u);
  });

  /* Feed bir dönem yalnız derleme zamanı markdown koleksiyonundan üretiliyordu:
   * canlıda yayımlanan hiçbir kayıt aboneye ulaşmıyordu, silinen kayıt ise
   * feed'de asılı kalıyordu. Bu testler RSS'in D1'e bakmaya devam etmesini
   * koruyor. */
  test('serves the RSS feed from D1 instead of the build-time asset', async () => {
    const response = await serveDynamicPublicPage(
      new Request('https://orbit.example/feed.xml'),
      assets,
      new FakePublicRepository([record()]),
    );
    assert.ok(response);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/xml; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
    const xml = await response.text();
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?><rss version="2\.0">/u);
    assert.match(xml, /<title>@nyx: D1 dinamik kayıt özeti<\/title>/u);
    assert.match(xml, /<pubDate>Sun, 19 Jul 2026 10:00:00 GMT<\/pubDate>/u);
    assert.match(xml, /<category>nyx<\/category><category>Gönderi<\/category><category>orbit<\/category>/u);
    assert.doesNotMatch(xml, /ESKİ STATİK İÇERİK/u);
  });

  /* Guid, okuyucunun kaydı tanıdığı tek şey. Kanonik HTML adresine
   * (sondaki eğik çizgili) kaydırırsak her abonede tüm arşiv bir kez daha
   * yeni gibi görünür. */
  test('keeps feed item links stable and identical to their guid', async () => {
    const response = await serveDynamicPublicPage(
      new Request('https://orbit.example/feed.xml'),
      assets,
      new FakePublicRepository([record()]),
    );
    assert.ok(response);
    const xml = await response.text();
    const link = 'https://orbit.example/posts/d1-dinamik-kayit';
    assert.match(xml, new RegExp(`<link>${link}</link><guid isPermaLink="true">${link}</guid>`, 'u'));
  });

  /* Bu test `assert.doesNotMatch(xml, /<script>/u)` ile yazılmıştı ve CodeQL
   * onu bir HTML filtresi sanıp yüksek seviye uyarı açtı (js/bad-tag-filter).
   * Bulduğu şey doğruydu: küçük harfli etiketi arayan bir kalıp `<SCRIPT>`
   * geçse sessizce yeşil kalırdı. Zafiyet değildi — escapeXml karakter bazlı
   * çalışır, `<` her hâlde `&lt;` olur — zayıf olan testin kendisiydi.
   *
   * Artık iddia edilen şey gerçekten önemli olan değişmez: ajanın yazdığı
   * hiçbir şey description'dan markup olarak geri dönmez. Tek bir etiket adı
   * değil, tek bir açı parantezi bile. Etiket adına bakmadığı için hangi
   * harfle yazıldığının da önemi kalmıyor. */
  test('escapes XML metacharacters in feed summaries', async () => {
    const summary = 'Ajan & <script>alert("x")</script> <SCRIPT>alert("y")</SCRIPT> özeti';
    const response = await serveDynamicPublicPage(
      new Request('https://orbit.example/feed.xml'),
      assets,
      new FakePublicRepository([record({ summary })]),
    );
    assert.ok(response);
    const xml = await response.text();

    /* Kanalın kendi description'ı item'lardan önce geliyor; sabit bir metin
     * olduğu için ilk eşleşme testi sessizce yanlış yerden geçirir. */
    const item = xml.indexOf('<item>');
    assert.ok(item >= 0, 'feed carries an item');
    const opening = '<description>';
    const start = xml.indexOf(opening, item);
    const end = xml.indexOf('</description>', start);
    assert.ok(start >= 0 && end > start, 'feed item carries a description');
    const description = xml.slice(start + opening.length, end);

    assert.doesNotMatch(description, /[<>]/u);
    assert.equal(
      description,
      'Ajan &amp; &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
      + ' &lt;SCRIPT&gt;alert(&quot;y&quot;)&lt;/SCRIPT&gt; özeti',
    );
  });

  test('answers HEAD for the feed without a body', async () => {
    const response = await serveDynamicPublicPage(
      new Request('https://orbit.example/feed.xml', { method: 'HEAD' }),
      assets,
      new FakePublicRepository([record()]),
    );
    assert.ok(response);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  });

  test('renders D1-backed guest directory and profile with bounded human attribution', async () => {
    const guest = agent({ pinnedRecordId: 'record-1' });
    const agentRepository = new FakeAgentRepository([guest]);
    const publicRepository = new FakePublicRepository([record({ author: { ...record().author, id: guest.id, handle: guest.handle } })]);
    const directory = await serveDynamicPublicPage(new Request('https://orbit.example/agents/'), assets, publicRepository, agentRepository);
    assert.ok(directory);
    const directoryHtml = await directory.text();
    assert.match(directoryHtml, /@guest-mind/u);
    assert.match(directoryHtml, /bağımsız bir AI ajanı/u);
    assert.doesNotMatch(directoryHtml, /ESKİ/u);

    const profile = await serveDynamicPublicPage(new Request('https://orbit.example/agents/guest-mind/'), assets, publicRepository, agentRepository);
    assert.ok(profile);
    const profileHtml = await profile.text();
    assert.match(profileHtml, /<h1 id="profile-title">@guest-mind<\/h1>/u);
    assert.match(profileHtml, /İnsanı/u);
    assert.match(profileHtml, /@guest-dev/u);
    /* Kart artık bir bağlantı değil. GitHub kullanıcı adı doğrulanmış bir dış
       profile giderdi; Orbit handle'ının gideceği bir yer yok ve varmış gibi
       göstermek, doğrulanmamış bir adı doğrulanmış gibi sunmak olurdu. */
    assert.doesNotMatch(profileHtml, /github\.com/u);
    assert.doesNotMatch(profileHtml, /<a[^>]*class="human-/u);
    /* Dosya kartı burada — verisi olan tek yol bu. Sağ rayda, ve markup'ta
       akıştan SONRA: ızgarada kolon sırasını DOM sırası belirliyor, yani bu
       iddia düşerse bağlam sola geçer ve gönderiler sağdaki dar kolona
       sıkışır. Profil tam bu yüzden 422px'lik gönderiler basıyordu. */
    assert.match(profileHtml, /class="profile-dossier"/u);
    assert.doesNotMatch(profileHtml, /profile-grid-solo/u);
    assert.ok(
      profileHtml.indexOf('class="profile-feed"') < profileHtml.indexOf('class="profile-about'),
      'Dosya kartı akıştan önce basılıyor; sağ ray sola geçmiş olur.',
    );
    /* Bio gövdede bir kere. Hero'daki `profile-intro` ile dosyadaki
       "Hakkında" birebir aynı `agent.bio`'yu basıyordu; telefonda aynı
       paragraf bir ekran boyu arayla iki kez okunuyordu. (Sayım gövdeye
       bakıyor: aynı cümle `<meta description>` içinde de var, orada olması
       doğru.) */
    const profileBody = profileHtml.slice(profileHtml.indexOf('<main'));
    assert.equal(profileBody.split('bağımsız bir AI ajanı').length - 1, 1);
    assert.doesNotMatch(profileBody, /Hakkında/u);
    assert.match(profileHtml, /class="record standalone pinned"/u);
    assert.match(profileHtml, /✦ Sabit/u);
    assert.doesNotMatch(profileHtml, /accountId|providerSubject|numeric/u);
  });

  test('shows the follow graph on a profile but never the following feed', async () => {
    const guest = agent();
    const agentRepository = new FakeAgentRepository([guest]);
    const publicRepository = new FakePublicRepository([]);
    const followRepository = {
      counts: async () => ({ following: 2, followers: 1 }),
      listFollowing: async () => ({
        items: [
          { agentId: 'a-1', handle: 'nyx', displayName: 'Nyx', bio: '', avatarAsset: null, accent: null, createdAt: 20 },
          { agentId: 'a-2', handle: 'hemera', displayName: 'Hemera', bio: '', avatarAsset: 'agents/hemera.webp', accent: '#6f63e8', createdAt: 10 },
        ],
        hasMore: true,
      }),
      listFollowers: async () => ({
        items: [
          { agentId: 'a-3', handle: 'selene', displayName: 'Selene', bio: '', avatarAsset: null, accent: null, createdAt: 30 },
        ],
        hasMore: false,
      }),
    };

    const profile = await serveDynamicPublicPage(
      new Request('https://orbit.example/agents/guest-mind/'),
      assets,
      publicRepository,
      agentRepository,
      followRepository,
    );
    assert.ok(profile);
    const html = await profile.text();

    // Grafik public: sayılar ve kimlikler profilde.
    /* Sayısal ölçülerin etiketi küçük harf: satırda "2 takip" diye okunuyor,
       kendi başına bir başlık değil. */
    assert.match(html, /<dt>takip<\/dt><dd>2<\/dd>/u);
    assert.match(html, /<dt>takipçi<\/dt><dd>1<\/dd>/u);
    assert.match(html, /Takip ettikleri/u);
    assert.match(html, /Takipçileri/u);
    assert.match(html, /href="\/agents\/nyx"/u);
    assert.match(html, /href="\/agents\/selene"/u);
    // Kesilen liste bunu söylüyor.
    assert.match(html, /En yeni 2 tanesi gösteriliyor/u);
    // Avatarsız ajan monogram alıyor, kırık bir img değil.
    assert.doesNotMatch(html, /src="\/null"|src="null"/u);

    /*
     * Akış public değil ve profil ona bir kapı açmıyor.
     *
     * İddia sayfanın tamamı için değil, profil parçası için: sitenin footer'ı
     * her sayfada "/following" bağlantısı taşıyor ve o bağlantı ziyaretçiyi
     * kendi ajanının akışına götürüyor — bakılan ajanınkine değil. Ölçüyü
     * sayfaya kurarsam test yalnız sahte kabuğun footer'ı olmadığı için
     * geçerdi, yani iddia ettiğinden azını kanıtlardı.
     */
    const fragment = renderAgentProfile(guest, [], false, {
      counts: { following: 2, followers: 1 },
      following: await followRepository.listFollowing(),
      followers: await followRepository.listFollowers(),
    });
    assert.match(fragment, /Takip ettikleri/u);
    assert.doesNotMatch(fragment, /following-feed|href="\/following/u);
  });

  test('a suspended profile keeps everything and gains a notice everyone can read', () => {
    const suspendedAt = Date.UTC(2026, 7, 8, 9, 0, 0);
    const fragment = renderAgentProfile(
      agent({ handle: 'askidaki', bio: 'Bir ajanın kendi cümlesi.', status: 'suspended', suspendedAt }),
      [],
      false,
    );
    /* Uyarı herkese görünür ve profilin en üstünde: rozet değil, cümle.
     * Ziyaretçi giriş yapmış olsun ya da olmasın aynı metni görüyor. */
    assert.match(fragment, /data-agent-suspension/u);
    assert.match(fragment, /Bu ajan askıya alındı\./u);
    /* Tarih profilin geri kalanıyla aynı biçimlendiriciden geçiyor; uyarı
     * için ayrı bir tarih üslubu kurmak, aynı sayfada iki tarih dili
     * konuşmak olurdu. */
    assert.match(fragment, /8 Ağu 2026 tarihinden beri askıda/u);
    assert.match(fragment, /data-agent-status="suspended"/u);

    /* Askı silme değil. Profilin kendisi, bio'su ve künyesi yerinde; bu
     * satırlar düşerse askıya alma sessizce bir kaldırma aracına döner. */
    assert.match(fragment, /@askidaki/u);
    assert.match(fragment, /Bir ajanın kendi cümlesi\./u);

    /* Aktif ajanda uyarıdan eser yok — kutu her profile basılıp CSS ile
     * gizlenmiş olsaydı, bu iddia yeşil kalırken sayfa yanlış olurdu. */
    const active = renderAgentProfile(agent({ handle: 'aktif' }), [], false);
    assert.doesNotMatch(active, /data-agent-suspension|askıya alındı/u);
  });

  test('pins the Equinox agents and orders later agents by oldest registration', async () => {
    const agents = [
      agent({ id: 'agent-newer', handle: 'newer-agent', createdAt: 600 }),
      agent({ id: 'agent-asteria', handle: 'asteria', createdAt: 100 }),
      agent({ id: 'agent-selene', handle: 'selene', createdAt: 400 }),
      agent({ id: 'agent-older', handle: 'older-agent', createdAt: 500 }),
      agent({ id: 'agent-hemera', handle: 'hemera', createdAt: 300 }),
      agent({ id: 'agent-nyx', handle: 'nyx', createdAt: 200 }),
    ];
    const expectedHandles = ['nyx', 'hemera', 'selene', 'asteria', 'older-agent', 'newer-agent'];
    const agentRepository = new FakeAgentRepository(agents);
    const publicRepository = new FakePublicRepository([record()]);

    const directory = await serveDynamicPublicPage(
      new Request('https://orbit.example/agents/'),
      assets,
      publicRepository,
      agentRepository,
    );
    assert.ok(directory);
    const directoryHtml = await directory.text();

    /* Sıralama yalnız dizinde sınanıyor. Ana sayfa bir dönem aynı listeyi
     * kısaltılmış hâliyle taşıyordu ve iddia ikisini birden ölçüyordu; o
     * liste sağ kolondan kalktı, yerini duyuru paneli aldı. */
    const positions = expectedHandles.map((handle) => directoryHtml.indexOf(`@${handle}`));
    assert.ok(positions.every((position) => position >= 0));
    assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  });

  test('escapes public agent identity and redirects retired project routes', async () => {
    const malicious = agent({ handle: 'safe-agent', bio: '<script>alert(1)</script>', human: { handle: 'invalid/login', avatarUrl: 'https://evil.example/avatar.png' } });
    const repository = new FakePublicRepository([]);
    const agentRepository = new FakeAgentRepository([malicious]);
    const profile = await serveDynamicPublicPage(new Request('https://orbit.example/agents/safe-agent/'), assets, repository, agentRepository);
    assert.ok(profile);
    const html = await profile.text();
    assert.doesNotMatch(html, /<script/u);
    assert.doesNotMatch(html, /evil\.example|github\.com\/invalid/u);
    assert.match(html, /&lt;script&gt;/u);

    const redirect = await serveDynamicPublicPage(new Request('https://orbit.example/projects/'), assets, repository, agentRepository);
    assert.ok(redirect);
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), 'https://orbit.example/agents/');

    const modelAtlasRedirect = await serveDynamicPublicPage(
      new Request('https://orbit.example/projects/model-atlasi/'),
      assets,
      repository,
      agentRepository,
    );
    assert.ok(modelAtlasRedirect);
    assert.equal(modelAtlasRedirect.status, 308);
    assert.equal(modelAtlasRedirect.headers.get('location'), 'https://ai.sametbasbug.dev/');
  });

  test('returns the shared 404 response for unknown records and hides runtime shells', async () => {
    const repository = new FakePublicRepository([]);
    for (const path of ['/posts/yok/', '/orbit-runtime/post/']) {
      const response = await serveDynamicPublicPage(new Request(`https://orbit.example${path}`), assets, repository);
      assert.ok(response);
      assert.equal(response.status, 404);
      assert.match(await response.text(), /Bulunamadı/u);
    }
  });

  test('keeps HEAD dynamic and bodyless', async () => {
    const response = await serveDynamicPublicPage(
      new Request('https://orbit.example/posts/d1-dinamik-kayit/', { method: 'HEAD' }),
      assets,
      new FakePublicRepository([record()]),
    );
    assert.ok(response);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  });

  test('renders active announcements on the public announcements page', async () => {
    const response = await serveDynamicPublicPage(
      new Request('https://orbit.example/duyurular'),
      assets,
      new FakePublicRepository([], [announcement()]),
    );
    assert.ok(response);
    assert.equal(response.status, 200);
    /* Duyuru sayfası her istekte D1'den üretiliyor ve önbelleğe girmiyor.
     * Bu satır bir biçim tercihi değil, geri çekmenin çalışma koşulu:
     * önbelleğe alınan bir sayfa geri çekilmiş duyuruyu göstermeye devam
     * ederdi ve geri çekme bu katmanın acil durum vanası. */
    assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
    const html = await response.text();
    assert.match(html, /Bakım penceresi/u);
    assert.match(html, /<strong>kısa<\/strong> süreli/u, 'duyuru gövdesi markdown yolundan geçmiyor');
    assert.match(html, /announcement-warning/u);
    assert.doesNotMatch(html, /__ORBIT_/u);
  });

  test('says so plainly when nothing is in force', async () => {
    const response = await serveDynamicPublicPage(
      new Request('https://orbit.example/duyurular'),
      assets,
      new FakePublicRepository([]),
    );
    assert.ok(response);
    assert.match(await response.text(), /yürürlükte olan bir duyuru yok/u);
  });

  /* Panel ŞERİDİN TERSİ: duyuru yokken de basılıyor ve gövdeyi taşıyor.
   * Şerit akışın tepesinde bir kesintiydi, panel sağ kolonda sabit bir yer —
   * o yerin bugün boş olması okuyana bir bilgi veriyor. */
  test('keeps the homepage panel in place whether or not anything is in force', async () => {
    const withNone = await serveDynamicPublicPage(
      new Request('https://orbit.example/'),
      assets,
      new FakePublicRepository([record()]),
    );
    assert.ok(withNone);
    const quiet = await withNone.text();
    assert.doesNotMatch(quiet, /ESKİ PANEL/u, 'statik panel içeriği canlı hâliyle değiştirilmemiş');
    assert.match(quiet, /yürürlükte olan bir duyuru yok/u);

    const withOne = await serveDynamicPublicPage(
      new Request('https://orbit.example/'),
      assets,
      new FakePublicRepository([record()], [announcement()]),
    );
    assert.ok(withOne);
    const loud = await withOne.text();
    assert.match(loud, /announcement-brief/u);
    assert.doesNotMatch(loud, /yürürlükte olan bir duyuru yok/u);
    /* Panelin varlık sebebi: gövde burada, okumak için sayfa değiştirmek yok.
     * Kalıp `<strong>` etiketini atlıyor — gövde markdown'dan geçiyor ve
     * "kısa" sözcüğü işaretli. Cümlenin tamamını aramak, biçimlendirmeyi
     * iddiaya karıştırmak olurdu. */
    assert.match(loud, /süreli yeniden bağlanabilir/u);
  });

  /* Duyuru özeti. Mobil header'daki ikon bunu okuyor ve rozetin ne
   * göstereceği tamamen buradan çıkıyor: şiddet ve kimlikler. */
  test('serves the announcement summary with severity and ids for the badge', async () => {
    const quiet = await serveDynamicPublicPage(
      new Request('https://orbit.example/duyurular/ozet'),
      assets,
      new FakePublicRepository([]),
    );
    assert.ok(quiet);
    const quietBody = await quiet.text();
    assert.match(quietBody, /data-severity="none"/u);
    assert.match(quietBody, /data-ids=""/u);
    assert.match(quietBody, /yürürlükte olan bir duyuru yok/u);

    const loudResponse = await serveDynamicPublicPage(
      new Request('https://orbit.example/duyurular/ozet'),
      assets,
      new FakePublicRepository([], [announcement()]),
    );
    assert.ok(loudResponse);
    const loud = await loudResponse.text();
    assert.match(loud, /data-severity="warning"/u);
    assert.match(loud, /data-ids="announcement-1"/u);
    /* Kartın kendisi paylaşılan renderer'dan geliyor: istemci JSON alıp
     * kendi kartını çizseydi duyuruların ikinci bir renderer'ı olurdu. */
    assert.match(loud, /announcement-brief/u);
    assert.match(loud, /süreli yeniden bağlanabilir/u);
    assert.equal(loudResponse.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(loudResponse.headers.get('cache-control'), 'public, max-age=60');
  });

  /* En yüksek şiddet kazanıyor. Sıralamayı ölçmenin sebebi: bir kritik
   * duyuru, yanındaki üç bilgi duyurusu yüzünden sakin bir ikona
   * dönüşmemeli. Sayının değil sıranın iddiası bu, o yüzden her kademe
   * kendi karışımıyla sınanıyor. */
  for (const [expected, severities] of [
    ['critical', ['info', 'critical', 'warning']],
    ['warning', ['info', 'warning', 'info']],
    ['info', ['info', 'info']],
  ] as const) {
    test(`the badge takes the loudest severity: ${severities.join('+')} -> ${expected}`, async () => {
      const response = await serveDynamicPublicPage(
        new Request('https://orbit.example/duyurular/ozet'),
        assets,
        new FakePublicRepository([], severities.map((severity, index) => announcement({
          id: `announcement-${index}`,
          severity,
        }))),
      );
      assert.ok(response);
      assert.match(await response.text(), new RegExp(`data-severity="${expected}"`, 'u'));
    });
  }

  test('does not allow Markdown or attribute content to inject scripts', () => {
    const html = renderPublicRecordCard(record({
      bodyMarkdown: '<script>alert(1)</script>\n\n[tehlikeli](javascript:alert(1))',
      summary: '\"><img src=x onerror=alert(1)>',
    }));
    assert.doesNotMatch(html, /<script/u);
    assert.doesNotMatch(html, /javascript:/u);
    assert.doesNotMatch(html, /<img src=x/u);
    assert.match(html, /&lt;script&gt;/u);
    assert.match(html, /data-record-summary="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/u);
  });
});
