import type { BlogTopic } from './types';

/**
 * Canonical origin for blog URLs and structured data. The site-wide `metadataBase`, robots and sitemap belong to the
 * technical SEO work; the blog only sets what its own pages need and reads this one constant.
 */
export const SITE_URL = 'https://qlead.vn';
export const BLOG_PATH = '/blog';

export const BLOG_EDITOR = { name: 'Đội ngũ QLead', kind: 'organization' as const };

export const TOPICS: Record<BlogTopic, { label: string; description: string }> = {
  'tin-hieu': { label: 'Tìm khách theo tín hiệu', description: 'Nhận ra cơ sở kinh doanh đang có nhu cầu và tiếp cận đúng lúc.' },
  'theo-nganh': { label: 'Theo ngành', description: 'Cách tìm khách cho từng nhóm người bán.' },
  'huong-dan': { label: 'Dùng QLead', description: 'Hướng dẫn sử dụng QLead.' },
};

/**
 * Drafts are visible on local builds and Vercel preview deployments, never on Vercel production.
 * `QLEAD_BLOG_PREVIEW=1|0` overrides either way (for example to check the production view locally).
 */
export function blogPreviewEnabled(): boolean {
  const override = process.env.QLEAD_BLOG_PREVIEW;
  if (override === '1') return true;
  if (override === '0') return false;
  return process.env.VERCEL_ENV !== 'production';
}

/** Links from an article back to the product carry where they came from, so the visit can be attributed later. */
export function productHref(path: '/' | '/dang-ky', slug: string, position: string, hash = ''): string {
  const params = new URLSearchParams({ utm_source: 'qlead-blog', utm_medium: 'article', utm_campaign: slug, utm_content: position });
  return `${path}?${params.toString()}${hash}`;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
