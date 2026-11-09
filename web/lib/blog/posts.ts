import type { BlogPost } from './types';
import { blogPreviewEnabled } from './site';
import CafeBody, { meta as cafeMeta } from '@/content/blog/tim-quan-cafe-sap-khai-truong';
import PillarBody, { meta as pillarMeta } from '@/content/blog/tim-khach-hang-tiem-nang-tren-facebook';

/** Every article, in the order the index lists them. Adding a post means adding a file in content/blog and one line here. */
const ALL_POSTS: BlogPost[] = [
  { ...cafeMeta, Body: CafeBody },
  { ...pillarMeta, Body: PillarBody },
];

/** Posts this deployment may serve: published ones everywhere, drafts only where previews are enabled. */
export function visiblePosts(): BlogPost[] {
  const preview = blogPreviewEnabled();
  return ALL_POSTS.filter(post => post.status === 'published' || preview);
}

/** True when this deployment has at least one article to show, so links to the guide never lead to an empty page or a 404. */
export function hasVisiblePosts(): boolean {
  return visiblePosts().length > 0;
}

export function findPost(slug: string): BlogPost | null {
  return visiblePosts().find(post => post.slug === slug) ?? null;
}

export function relatedPosts(post: BlogPost): BlogPost[] {
  const visible = visiblePosts();
  return post.related.map(slug => visible.find(other => other.slug === slug)).filter((p): p is BlogPost => Boolean(p)).slice(0, 3);
}

/** For the site sitemap (owned by the technical SEO work): only published posts, with their last edit. */
export function publishedBlogEntries(): Array<{ path: string; lastModified: string }> {
  return ALL_POSTS.filter(post => post.status === 'published').map(post => ({ path: `/blog/${post.slug}`, lastModified: post.updatedAt }));
}
