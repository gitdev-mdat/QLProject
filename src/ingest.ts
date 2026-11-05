import type { PoolClient } from 'pg';
import type { ScanPayload } from './validation.js';

/** Post storage shared by the legacy agent endpoint and shared-worker job results. Ownership is always ownerId. */
export type PreparedPost = { normalized: string; original: string; title?: string | null; content?: string | null; summary_vi?: string | null; author?: string | null; published_at?: string | null; source_type?: string | null; collected_via?: string | null; platform?: string | null };

export function normalizeFacebookUrl(raw: string): string {
  const u = new URL(raw);
  if (!['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.watch'].includes(u.hostname.toLowerCase())) throw new Error('Unsupported post URL host');
  u.hostname = u.hostname.toLowerCase().replace(/^(www|m|web)\./, '');
  u.protocol = 'https:'; u.hash = '';
  for (const key of [...u.searchParams.keys()]) if (/^(utm_|ref$|__tn|mibextid|tracking)/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString();
}

/** Throws when any URL is not a supported Facebook host. */
export function preparePosts(posts: ScanPayload['posts']): PreparedPost[] {
  return posts.map(p => ({ normalized: normalizeFacebookUrl(p.url), original: p.url, ...p }));
}

export async function associatePostsWithConfig(client: PoolClient, ownerId: string, version: number, urls: string[]): Promise<void> {
  for (const url of new Set(urls)) {
    await client.query(`INSERT INTO facebook_post_search_configs (agent_connection_id, normalized_url, configuration_version)
      SELECT $1, $2, $3
      WHERE EXISTS (SELECT 1 FROM facebook_posts WHERE agent_connection_id = $1 AND normalized_url = $2)
        AND EXISTS (SELECT 1 FROM scan_configs WHERE agent_connection_id = $1 AND version = $3)
      ON CONFLICT DO NOTHING`, [ownerId, url, version]);
  }
}

/** Inserts new posts, fills only blank metadata on known posts, and links every post to the config version. */
export async function upsertPosts(client: PoolClient, ownerId: string, version: number, posts: PreparedPost[]): Promise<{ inserted: Set<string>; updated: Set<string> }> {
  const inserted = new Set<string>();
  const updated = new Set<string>();
  for (const post of posts) {
    const r = await client.query(`INSERT INTO facebook_posts (agent_connection_id, normalized_url, original_url, title, content, summary_vi, author, published_at, source_type, collected_via, platform)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (agent_connection_id, normalized_url) DO NOTHING RETURNING normalized_url`,
    [ownerId, post.normalized, post.original, post.title ?? null, post.content ?? null, post.summary_vi?.trim() || null, post.author ?? null, post.published_at ?? null, post.source_type ?? null, post.collected_via ?? null, post.platform ?? null]);
    if (r.rowCount) { inserted.add(post.normalized); continue; }
    const enriched = await client.query(`UPDATE facebook_posts SET
        title = CASE WHEN (title IS NULL OR btrim(title) = '') AND NULLIF(btrim($3), '') IS NOT NULL THEN $3 ELSE title END,
        content = CASE WHEN (content IS NULL OR btrim(content) = '') AND NULLIF(btrim($4), '') IS NOT NULL THEN $4 ELSE content END,
        summary_vi = CASE WHEN (summary_vi IS NULL OR btrim(summary_vi) = '') AND NULLIF(btrim($5), '') IS NOT NULL THEN $5 ELSE summary_vi END,
        author = CASE WHEN (author IS NULL OR btrim(author) = '') AND NULLIF(btrim($6), '') IS NOT NULL THEN $6 ELSE author END,
        published_at = CASE WHEN published_at IS NULL AND $7::timestamptz IS NOT NULL THEN $7::timestamptz ELSE published_at END,
        source_type = CASE WHEN (source_type IS NULL OR btrim(source_type) = '') AND NULLIF(btrim($8), '') IS NOT NULL THEN $8 ELSE source_type END,
        collected_via = CASE WHEN (collected_via IS NULL OR btrim(collected_via) = '') AND NULLIF(btrim($9), '') IS NOT NULL THEN $9 ELSE collected_via END,
        platform = CASE WHEN (platform IS NULL OR btrim(platform) = '') AND NULLIF(btrim($10), '') IS NOT NULL THEN $10 ELSE platform END
      WHERE agent_connection_id = $1 AND normalized_url = $2 AND (
        ((title IS NULL OR btrim(title) = '') AND NULLIF(btrim($3), '') IS NOT NULL) OR
        ((content IS NULL OR btrim(content) = '') AND NULLIF(btrim($4), '') IS NOT NULL) OR
        ((summary_vi IS NULL OR btrim(summary_vi) = '') AND NULLIF(btrim($5), '') IS NOT NULL) OR
        ((author IS NULL OR btrim(author) = '') AND NULLIF(btrim($6), '') IS NOT NULL) OR
        (published_at IS NULL AND $7::timestamptz IS NOT NULL) OR
        ((source_type IS NULL OR btrim(source_type) = '') AND NULLIF(btrim($8), '') IS NOT NULL) OR
        ((collected_via IS NULL OR btrim(collected_via) = '') AND NULLIF(btrim($9), '') IS NOT NULL) OR
        ((platform IS NULL OR btrim(platform) = '') AND NULLIF(btrim($10), '') IS NOT NULL)
      ) RETURNING normalized_url`,
    [ownerId, post.normalized, post.title ?? null, post.content ?? null, post.summary_vi?.trim() || null, post.author ?? null, post.published_at ?? null, post.source_type ?? null, post.collected_via ?? null, post.platform ?? null]);
    if (enriched.rowCount) updated.add(post.normalized);
  }
  await associatePostsWithConfig(client, ownerId, version, posts.map(post => post.normalized));
  return { inserted, updated };
}
