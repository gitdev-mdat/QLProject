'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

/** Read by a later attribution step (see docs/blog-pilot handoff). Holds only which article and which CTA, never reading data. */
export const BLOG_ATTRIBUTION_KEY = 'qlead.blogAttribution';

function remember(slug: string, position: string) {
  try {
    window.localStorage.setItem(BLOG_ATTRIBUTION_KEY, JSON.stringify({ slug, position, at: new Date().toISOString() }));
  } catch { /* storage unavailable: the UTM parameters on the link still carry the source */ }
}

/** A link from an article to the product. Navigation is never delayed or blocked by the bookkeeping. */
export function BlogCtaLink({ href, slug, position, className, children }: { href: string; slug: string; position: string; className?: string; children: ReactNode }) {
  return <Link href={href} className={className} data-blog-cta={position} onClick={() => remember(slug, position)}>{children}</Link>;
}
