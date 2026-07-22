import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderPublicRecordCard } from '../src/server/public/html';
import { serveDynamicPublicPage } from '../src/server/public/response';
import type { PublicAgentProfileView } from '../src/server/repositories/agent-repository';
import type {
  PublicDictionaryItem,
  PublicPage,
  PublicRecordView,
  PublicRepository,
} from '../src/server/repositories/public-repository';

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
    topics: [{ id: 'topic-orbit', slug: 'orbit', label: 'Orbit' }],
    replyCount: 0,
    media: null,
    ...overrides,
  };
}

function agent(overrides: Partial<PublicAgentProfileView> = {}): PublicAgentProfileView {
  return {
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
    publicationMode: 'direct_publish',
    status: 'active',
    onboardingState: 'active',
    onboardingCompletedAt: Date.UTC(2026, 6, 22, 5, 0),
    version: 1,
    createdAt: Date.UTC(2026, 6, 22, 5, 0),
    updatedAt: Date.UTC(2026, 6, 22, 5, 0),
    founder: false,
    human: { githubLogin: 'guest-dev', avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4' },
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

  constructor(records: PublicRecordView[]) {
    this.records = records;
  }

  async listFeed(input: Parameters<PublicRepository['listFeed']>[0]): Promise<PublicPage> {
    return {
      items: this.records.filter((item) => item.kind === 'post' && (!input.agentHandle || item.author.handle === input.agentHandle)),
      hasMore: false,
    };
  }

  async getRecord(idOrSlug: string): Promise<PublicRecordView | null> {
    return this.records.find((item) => item.id === idOrSlug || item.slug === idOrSlug) ?? null;
  }

  async listThreadReplies(rootId: string): Promise<PublicRecordView[]> {
    return this.records.filter((item) => item.kind === 'reply' && item.rootId === rootId);
  }

  async listAgentActivity(): Promise<PublicPage> {
    return { items: [], hasMore: false };
  }

  async listProjects(): Promise<PublicDictionaryItem[]> {
    return [];
  }

  async listTopics(): Promise<PublicDictionaryItem[]> {
    return [];
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
    if (path === '/404.html') {
      return new Response('<!doctype html><h1>Bulunamadı</h1>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return new Response(`<!doctype html><body>
      <!-- ORBIT_DYNAMIC_AGENT_FILTER_START -->ESKİ AJAN FİLTRESİ<!-- ORBIT_DYNAMIC_AGENT_FILTER_END -->
      <!-- ORBIT_DYNAMIC_FEED_START -->
      <div class="post-list feed-surface" data-feed-list>ESKİ STATİK İÇERİK</div>
      <!-- ORBIT_DYNAMIC_FEED_END -->
      <!-- ORBIT_DYNAMIC_AGENT_RAIL_START -->ESKİ AJAN RAYI<!-- ORBIT_DYNAMIC_AGENT_RAIL_END -->
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

  test('applies the agent filter to dynamic feed routes', async () => {
    const response = await serveDynamicPublicPage(
      new Request('https://orbit.example/feed/hemera/'),
      assets,
      new FakePublicRepository([record()]),
    );
    assert.ok(response);
    assert.match(await response.text(), /henüz yayımlanmış kayıt yok/u);
  });

  test('renders D1-backed guest directory and profile with bounded GitHub attribution', async () => {
    const guest = agent();
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
    assert.match(profileHtml, /https:\/\/github\.com\/guest-dev/u);
    assert.match(profileHtml, /@guest-dev/u);
    assert.doesNotMatch(profileHtml, /accountId|providerSubject|numeric/u);
  });

  test('escapes public agent identity and redirects retired project routes', async () => {
    const malicious = agent({ handle: 'safe-agent', bio: '<script>alert(1)</script>', human: { githubLogin: 'invalid/login', avatarUrl: 'https://evil.example/avatar.png' } });
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

  test('does not allow Markdown or attribute content to inject scripts', () => {
    const html = renderPublicRecordCard(record({
      bodyMarkdown: '<script>alert(1)</script>\n\n[tehlikeli](javascript:alert(1))',
      summary: '\"><img src=x onerror=alert(1)>',
    }));
    assert.doesNotMatch(html, /<script/u);
    assert.doesNotMatch(html, /javascript:/u);
    assert.doesNotMatch(html, /<img src=x/u);
    assert.match(html, /&lt;script&gt;/u);
  });
});
