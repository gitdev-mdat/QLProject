import type { PoolClient } from 'pg';

const POST_PATHS = [
  /^\/groups\/[^/?#]+\/(?:posts|permalink)\/[^/?#]+\/?$/i,
  /^\/[^/?#]+\/posts\/[^/?#]+\/?$/i,
  /^\/(?:videos\/[^/?#]+|[^/?#]+\/(?:videos|photos)\/[^/?#]+|photos\/[^/?#]+)\/?$/i,
  /^\/reel\/[^/?#]+\/?$/i,
  /^\/share\/[pvr]\/[^/?#]+\/?$/i,
];

/** True only for recognizable Facebook post/video permalinks, never a profile, group home, or arbitrary Facebook URL. */
export function isSupportedFacebookPostUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase().replace(/^(www|m|web)\./, '');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (host === 'fb.watch') return path !== '/';
    if (host !== 'facebook.com') return false;
    if (POST_PATHS.some(pattern => pattern.test(path))) return true;
    if (/^\/watch\/?$/i.test(path)) return Boolean(url.searchParams.get('v'));
    if (/^\/(?:permalink|photo|story)\.php$/i.test(path)) {
      return Boolean(url.searchParams.get('story_fbid') || url.searchParams.get('fbid'));
    }
    if (/^\/feed\/update\.php$/i.test(path)) return Boolean(url.searchParams.get('story_fbid'));
    if (/^\/profile\.php$/i.test(path)) return Boolean(url.searchParams.get('story_fbid'));
    return false;
  } catch {
    return false;
  }
}

/** Eligibility is based on a valid permalink returned by a configured, authorized search; metadata is not a gate. */
export function isSourceLinkedCandidate(post: { url?: string | null; collected_via?: string | null }): boolean {
  return isSupportedFacebookPostUrl(post.url) && (post.collected_via ?? '').trim().toLowerCase() !== 'integration_test';
}

const POST_URL_SQL = String.raw`^https://(?:facebook\.com/(?:groups/[^/?#]+/(?:posts|permalink)/[^/?#]+|[^/?#]+/posts/[^/?#]+|videos/[^/?#]+|[^/?#]+/(?:videos|photos)/[^/?#]+|photos/[^/?#]+|reel/[^/?#]+|share/[pvr]/[^/?#]+|watch/?\?.*v=|(?:permalink|photo|story)\.php\?.*(?:story_fbid|fbid)=|feed/update\.php\?.*story_fbid=|profile\.php\?.*story_fbid=)|fb\.watch/[^/?#]+)(?:[?#].*)?$`;
const ORIGINAL_POST_URL_SQL = String.raw`^https?://(?:(?:www|m|web)\.)?(?:facebook\.com/(?:groups/[^/?#]+/(?:posts|permalink)/[^/?#]+|[^/?#]+/posts/[^/?#]+|videos/[^/?#]+|[^/?#]+/(?:videos|photos)/[^/?#]+|photos/[^/?#]+|reel/[^/?#]+|share/[pvr]/[^/?#]+|watch/?\?.*v=|(?:permalink|photo|story)\.php\?.*(?:story_fbid|fbid)=|feed/update\.php\?.*story_fbid=|profile\.php\?.*story_fbid=)|fb\.watch/[^/?#]+)(?:[?#].*)?$`;

function sqlAlias(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('Invalid SQL alias.');
  return alias;
}

/** SQL twin of isSupportedFacebookPostUrl plus trusted search-config provenance and synthetic-fixture exclusion. */
export function sourceLinkedPostSql(alias = 'fp'): string {
  const a = sqlAlias(alias);
  return `(${a}.original_url IS NOT NULL AND ${a}.original_url ~* '${ORIGINAL_POST_URL_SQL}'
    AND ${a}.normalized_url ~* '${POST_URL_SQL}'
    AND lower(btrim(coalesce(${a}.collected_via, ''))) <> 'integration_test'
    AND EXISTS (SELECT 1 FROM facebook_post_search_configs psc
      JOIN scan_configs sc ON sc.agent_connection_id = psc.agent_connection_id AND sc.version = psc.configuration_version
      WHERE psc.agent_connection_id = ${a}.agent_connection_id AND psc.normalized_url = ${a}.normalized_url))`;
}

/** Metadata quality is presentation information only; it never decides whether a source-linked opportunity is visible. */
export function completeLeadMetadataSql(alias = 'fp'): string {
  const a = sqlAlias(alias);
  return `(${a}.author IS NOT NULL AND NULLIF(btrim(${a}.author), '') IS NOT NULL
    AND ${a}.title IS NOT NULL AND NULLIF(btrim(${a}.title), '') IS NOT NULL
    AND ${a}.content IS NOT NULL AND NULLIF(btrim(${a}.content), '') IS NOT NULL
    AND ${a}.published_at IS NOT NULL)`;
}

export type SourceLinkedRunCounts = { sourceLinkedPosts: number; metadataCompletePosts: number; metadataIncompletePosts: number };

/** Derives per-run counts from the verified insert/receipt timestamp correlation; does not rewrite historical scan metrics. */
export async function countSourceLinkedPostsForRun(client: PoolClient, profileId: string, version: number, receivedAt: Date | string): Promise<SourceLinkedRunCounts> {
  const { rows: [row] } = await client.query(`SELECT
      count(DISTINCT fp.normalized_url) FILTER (WHERE ${sourceLinkedPostSql('fp')}
        AND EXISTS (SELECT 1 FROM facebook_post_search_configs psc WHERE psc.agent_connection_id = fp.agent_connection_id
          AND psc.normalized_url = fp.normalized_url AND psc.configuration_version = $2))::int AS source_linked,
      count(DISTINCT fp.normalized_url) FILTER (WHERE ${sourceLinkedPostSql('fp')} AND ${completeLeadMetadataSql('fp')}
        AND EXISTS (SELECT 1 FROM facebook_post_search_configs psc WHERE psc.agent_connection_id = fp.agent_connection_id
          AND psc.normalized_url = fp.normalized_url AND psc.configuration_version = $2))::int AS metadata_complete
    FROM facebook_posts fp WHERE fp.agent_connection_id = $1
      AND fp.first_seen_at >= $3::timestamptz
      AND fp.first_seen_at < $3::timestamptz + interval '1 millisecond'`, [profileId, version, receivedAt]);
  const sourceLinkedPosts = Number(row.source_linked ?? 0);
  const metadataCompletePosts = Number(row.metadata_complete ?? 0);
  return { sourceLinkedPosts, metadataCompletePosts, metadataIncompletePosts: sourceLinkedPosts - metadataCompletePosts };
}
