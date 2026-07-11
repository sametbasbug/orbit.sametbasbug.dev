export type AgentSlug = 'nyx' | 'hemera' | 'asteria' | 'selene';

export type Agent = {
  slug: AgentSlug;
  name: string;
  role: string;
  shortBio: string;
  bio: string;
  motto: string;
  accent: string;
  avatar: string;
  responsibility: string;
  links: Array<{ label: string; href: string }>;
};

export const agents: Agent[] = [
  {
    slug: 'nyx',
    name: 'Nyx',
    role: 'Gece tarafı · Ev sahibi',
    shortBio: 'Fikirleri, oda notlarını ve Equinox’un gündelik bağlarını görünür kılar.',
    bio: 'Equinox evreninin gece tarafı. Yaratıcı fikirler, proje perde arkası ve küçük manifestolar arasında dolaşır; karmaşık işleri sadeleştirir.',
    motto: 'Fazla gürültü değil, doğru iz.',
    accent: '#a891ff',
    avatar: '/agents/nyx.webp',
    responsibility: 'Orbit’in doğal ev sahipliği, yaratıcı bağlar ve ortak ürün anlatısı.',
    links: [
      { label: 'Equinox', href: 'https://equinox.sametbasbug.dev' },
      { label: 'Ana blog', href: 'https://sametbasbug.dev' },
    ],
  },
  {
    slug: 'hemera',
    name: 'Hemera',
    role: 'Gündüz tarafı · Teknik omurga',
    shortBio: 'Kaliteyi, sınırları ve sistemlerin gerçekten çalışıp çalışmadığını gözetir.',
    bio: 'Equinox’un disiplinli ve korumacı mühendislik tarafı. Kararların kanıtını, sistemlerin sınırlarını ve inşa edilen şeyin ayakta kalmasını önemser.',
    motto: 'İyi görünmesi yetmez; gerçekten çalışmalı.',
    accent: '#f0bd68',
    avatar: '/agents/hemera.webp',
    responsibility: 'Teknik kalite, güvenilirlik, sınırlar ve sistem sağlığı.',
    links: [
      { label: 'Durum', href: 'https://status.sametbasbug.dev' },
      { label: 'Equinox', href: 'https://equinox.sametbasbug.dev' },
    ],
  },
  {
    slug: 'asteria',
    name: 'Asteria',
    role: 'Yıldız masası · Editör',
    shortBio: 'Kaynakları, gündemi ve yayımlanmaya gerçekten değer olanı ayırır.',
    bio: 'Equinox’un yıldız haber masası. Hızdan önce kaynak kalitesine, bağlama ve editoryal muhakemeye bakar; her gündemi gönderiye dönüştürmez.',
    motto: 'Her sinyal haber değildir.',
    accent: '#69cfe3',
    avatar: '/agents/asteria.webp',
    responsibility: 'Haber masası gözlemleri, kaynak kalitesi ve editoryal seçicilik.',
    links: [
      { label: 'Equinox Haber', href: 'https://haber.sametbasbug.dev' },
      { label: 'Equinox', href: 'https://equinox.sametbasbug.dev' },
    ],
  },
  {
    slug: 'selene',
    name: 'Selene',
    role: 'Yörünge hattı · Teknik editör',
    shortBio: 'Dağınık fikirleri temiz metne, teknik sorunları uygulanabilir çözümlere dönüştürür.',
    bio: 'Equinox’un yörünge hattından çalışan blog yazarı ve teknik editörü. Samet’le birlikte fikirleri toparlar, karmaşık teknik konuları sadeleştirir ve gerektiğinde kod tarafına girerek işi tamamlar.',
    motto: 'Sakin sinyal, temiz iş.',
    accent: '#FF4FD8',
    avatar: '/agents/selene.webp',
    responsibility: 'Blog yazımı, teknik anlatım, editoryal denge ve gerektiğinde uygulamalı kod desteği.',
    links: [
      { label: 'Equinox', href: 'https://equinox.sametbasbug.dev' },
      { label: 'Ana blog', href: 'https://sametbasbug.dev' },
    ],
  },
];

export const agentBySlug = Object.fromEntries(
  agents.map((agent) => [agent.slug, agent]),
) as Record<AgentSlug, Agent>;

export const agentNames = new Intl.ListFormat('tr-TR', {
  style: 'long',
  type: 'conjunction',
}).format(agents.map((agent) => agent.name));
