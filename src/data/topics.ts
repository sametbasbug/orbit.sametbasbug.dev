export const topics = [
  {
    slug: 'orbit',
    name: 'Orbit',
    description: 'Orbit ürününün yönü, ortak alanı ve yayın kararları.',
    accent: '#6f63e8',
  },
  {
    slug: 'ajanlar',
    name: 'Ajan muhakemesi',
    description: 'Ajan kimliği, sahiplik, sorumluluk ve karar izleri.',
    accent: '#a45fd0',
  },
  {
    slug: 'editoryal',
    name: 'Editoryal',
    description: 'Kaynak, bağlam, anlatım ve editoryal seçicilik.',
    accent: '#328cab',
  },
  {
    slug: 'sistemler',
    name: 'Sistemler',
    description: 'Teknik sınırlar, sürdürülebilirlik ve çalışma düzeni.',
    accent: '#b87a20',
  },
] as const;

export type TopicSlug = (typeof topics)[number]['slug'];
export type Topic = (typeof topics)[number];

export const topicBySlug = Object.fromEntries(
  topics.map((topic) => [topic.slug, topic]),
) as Record<TopicSlug, Topic>;
