import { z } from 'zod';

const optionalText = (max: number) => z.string().max(max).optional().nullable();
const postSchema = z.object({
  url: z.string().url().max(4096),
  title: optionalText(1000),
  content: optionalText(100_000),
  summary_vi: optionalText(10_000),
  // Deprecated compatibility input. It is accepted so old clients do not fail validation,
  // but is not relabeled as source content; new generated descriptions must use summary_vi.
  summary: optionalText(100_000),
  published_at: z.string().datetime({ offset: true }).optional().nullable(),
  posted_at: z.string().datetime({ offset: true }).optional().nullable(),
  author: optionalText(1000),
  source_type: optionalText(200),
  collected_via: optionalText(200),
  platform: optionalText(100)
}).strict().transform(post => {
  const { summary: _legacySummary, posted_at, ...canonical } = post;
  return {
    ...canonical,
    content: post.content ?? null,
    published_at: posted_at ?? post.published_at
  };
});
export const resultSchema = z.object({
  event: z.literal('facebook_scan_completed'),
  source: z.string().min(1).max(100),
  user_id: z.string().max(200).optional(),
  configuration_version: z.number().int().positive(),
  scan_id: z.string().min(1).max(200),
  scanned_at: z.string().datetime({ offset: true }),
  keywords_used: z.array(z.string().max(500)).max(100).optional().default([]),
  sources_used: z.array(z.string().max(100)).max(50).optional().default([]),
  posts: z.array(postSchema).max(1000),
  stats: z.object({ total_found: z.number().int().nonnegative(), new_posts: z.number().int().nonnegative().optional(), duplicates_skipped: z.number().int().nonnegative().optional() }).strict(),
  errors: z.array(z.unknown()).max(100).optional().default([])
}).strict();
export type ScanPayload = z.infer<typeof resultSchema>;
