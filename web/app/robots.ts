import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/seo';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: ['/', '/blog'], disallow: ['/app', '/admin', '/api'] },
    sitemap: new URL('/sitemap.xml', SITE_URL).toString(),
  };
}
