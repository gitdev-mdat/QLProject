import type { MetadataRoute } from 'next';
import { publishedBlogEntries } from '@/lib/blog/posts';
import { SITE_URL } from '@/lib/seo';

/** Only public, canonical, indexable routes belong here. Add published Blog entries through the Blog contract. */
export default function sitemap(): MetadataRoute.Sitemap {
  const entries = publishedBlogEntries();
  return [
    { url: SITE_URL },
    ...(entries.length ? [{ url: new URL('/blog', SITE_URL).toString() }] : []),
    ...entries.map(entry => ({ url: new URL(entry.path, SITE_URL).toString(), lastModified: new Date(entry.lastModified) })),
  ];
}
