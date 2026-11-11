'use client';

export const FIRST_TOUCH_KEY = 'qlead.firstTouchAttribution';
export const BLOG_ATTRIBUTION_KEY = 'qlead.blogAttribution';

export type AttributionSource = 'organic' | 'blog' | 'campaign' | 'referral' | 'direct' | 'unknown';
export type Attribution = { source: AttributionSource; campaign: string | null; content: string | null };

const slugPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const contentPattern = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const searchHosts = new Set(['bing.com', 'search.yahoo.com', 'duckduckgo.com', 'search.brave.com', 'ecosia.org']);

function safeCampaign(value: string | null | undefined): string | null {
  return value && slugPattern.test(value) ? value : null;
}

function safeContent(value: string | null | undefined): string | null {
  return value && contentPattern.test(value) ? value : null;
}

function stored(key: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function fromCurrentVisit(): Attribution | null {
  const params = new URLSearchParams(window.location.search);
  const utmSource = params.get('utm_source');
  const campaign = safeCampaign(params.get('utm_campaign'));
  const content = safeContent(params.get('utm_content'));
  if (utmSource === 'qlead-blog') return { source: 'blog', campaign, content };
  if (utmSource) return { source: 'campaign', campaign, content };

  const blog = stored(BLOG_ATTRIBUTION_KEY);
  const blogSlug = blog && typeof blog.slug === 'string' ? safeCampaign(blog.slug) : null;
  if (blog && blogSlug) {
    return { source: 'blog', campaign: blogSlug, content: safeContent(typeof blog.position === 'string' ? blog.position : null) };
  }
  try {
    const host = new URL(document.referrer).hostname.toLowerCase().replace(/^www\./, '');
    if (host.startsWith('google.') || [...searchHosts].some(searchHost => host === searchHost || host.endsWith(`.${searchHost}`))) return { source: 'organic', campaign: null, content: null };
    if (host && host !== window.location.hostname.toLowerCase()) return { source: 'referral', campaign: null, content: null };
  } catch { /* Direct visit or unavailable referrer. */ }
  return { source: 'direct', campaign: null, content: null };
}

export function currentAttribution(): Attribution {
  const current = fromCurrentVisit();
  if (current && current.source !== 'direct') return current;
  const first = stored(FIRST_TOUCH_KEY);
  if (first && ['organic', 'blog', 'campaign', 'referral', 'direct', 'unknown'].includes(String(first.source))) {
    return { source: first.source as AttributionSource, campaign: safeCampaign(typeof first.campaign === 'string' ? first.campaign : null), content: safeContent(typeof first.content === 'string' ? first.content : null) };
  }
  return current ?? { source: 'unknown', campaign: null, content: null };
}

/** Save the first observed channel once; never persist search text, referrer URL, or query parameters. */
export function captureFirstTouch(): Attribution {
  const existing = stored(FIRST_TOUCH_KEY);
  if (existing && ['organic', 'blog', 'campaign', 'referral', 'direct', 'unknown'].includes(String(existing.source))) {
    return { source: existing.source as AttributionSource, campaign: safeCampaign(typeof existing.campaign === 'string' ? existing.campaign : null), content: safeContent(typeof existing.content === 'string' ? existing.content : null) };
  }
  const attribution = fromCurrentVisit() ?? { source: 'unknown' as const, campaign: null, content: null };
  try { window.localStorage.setItem(FIRST_TOUCH_KEY, JSON.stringify(attribution)); } catch { /* Storage can be disabled. */ }
  return attribution;
}
