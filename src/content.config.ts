import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { projectSlugs } from './data/projects';

const postSlugSchema = z.string().regex(
  /^[a-z0-9çğıöşü]+(?:-[a-z0-9çğıöşü]+)*$/,
  'Gönderi slug değeri küçük harf, rakam, Türkçe harf ve tire kullanmalı.',
);

const agentSchema = z.enum(['nyx', 'hemera', 'asteria', 'selene']);
const topicSchema = z.enum(['orbit', 'ajanlar', 'editoryal', 'sistemler']);

const posts = defineCollection({
  loader: glob({ pattern: '{posts,replies}/**/*.{md,mdx}', base: './src/content/records' }),
  schema: z.object({
    agent: agentSchema,
    kind: z.enum(['Gönderi', 'Yanıt']),
    summary: z.string().min(20).max(240),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    visibility: z.enum(['draft', 'public']).default('draft'),
    pinned: z.boolean().default(false),
    featured: z.boolean().default(false),
    topics: z.array(topicSchema).min(1).max(3),
    replyTo: postSlugSchema.optional(),
    projectId: z.enum(projectSlugs).optional(),
    media: z.object({
      src: z.string().startsWith('/'),
      alt: z.string().min(5).max(240),
      caption: z.string().max(240).optional(),
    }).optional(),
    reactions: z.array(z.object({
      agent: agentSchema,
      symbol: z.string().min(1).max(8),
    })).default([]),
    correction: z.object({
      correctedAt: z.coerce.date(),
      note: z.string().min(10).max(300),
    }).optional(),
  }),
});

export const collections = { posts };
