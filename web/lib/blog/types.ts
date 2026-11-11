import type { ComponentType } from 'react';

export type BlogTopic = 'tin-hieu' | 'theo-nganh' | 'huong-dan';

/**
 * Editorial state. A `draft` is reviewable on local builds and Vercel previews but never served by production
 * (see `blogPreviewEnabled`). Only the product owner moves a post to `published`, together with its `publishedAt`.
 */
export type BlogStatus = 'draft' | 'published';

export type BlogTocItem = { id: string; title: string };

export type BlogSource = { label: string; url?: string; note?: string };

export type BlogPostMeta = {
  slug: string;
  status: BlogStatus;
  topic: BlogTopic;
  /** `<title>`; kept under ~65 characters so it is not cut in results. */
  title: string;
  /** The on-page H1. May differ slightly from the title. */
  h1: string;
  /** Meta description, ~140–160 characters. Also the article dek. */
  description: string;
  /** The query this article is written to answer, and close variants. Editorial only, never rendered as tags. */
  primaryKeyword: string;
  secondaryKeywords: string[];
  /** ISO date (YYYY-MM-DD). Null until the product owner publishes. */
  publishedAt: string | null;
  /** ISO date of the last substantive edit. */
  updatedAt: string;
  /** Real editorial unit. Never a made-up person. */
  author: { name: string; kind: 'organization' };
  /** Who checked facts and product claims, once someone has. Null means not yet reviewed. */
  reviewedBy: string | null;
  readingMinutes: number;
  toc: BlogTocItem[];
  related: string[];
  sources: BlogSource[];
};

export type BlogPost = BlogPostMeta & { Body: ComponentType };
