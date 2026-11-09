import type { ReactNode } from 'react';
import { Icon } from '@/components/visuals';
import { productHref } from '@/lib/blog/site';
import { BlogCtaLink } from './blog-cta';

/** One-paragraph answer at the top of an article: what the reader can do, before any detail. */
export function Summary({ children }: { children: ReactNode }) {
  return <div className="blog-summary"><p className="blog-summary-label">Tóm tắt</p>{children}</div>;
}

export function Note({ title, children }: { title?: string; children: ReactNode }) {
  return <aside className="blog-note">{title && <p className="blog-note-title"><Icon name="info" size={18}/>{title}</p>}{children}</aside>;
}

/**
 * Example text written by the editors to show a pattern. Always labelled, so it is never mistaken for a real post.
 * Real posts only appear with the owner's permission and with names, photos, phone numbers and links removed.
 */
export function IllustrativePost({ text, meta }: { text: string; meta?: string }) {
  return <figure className="blog-post-sample">
    <figcaption><span className="blog-sample-tag">Minh họa</span>{meta && <span>{meta}</span>}</figcaption>
    <blockquote>{text}</blockquote>
  </figure>;
}

/** Wide tables scroll inside their own frame on small screens, never the page. */
export function TableFrame({ caption, children }: { caption: string; children: ReactNode }) {
  return <figure className="blog-table">
    <div className="blog-table-scroll" role="region" aria-label={caption} tabIndex={0}><table>{children}</table></div>
    <figcaption>{caption}</figcaption>
  </figure>;
}

/**
 * The one in-article invitation to try QLead. It links to the existing demo on the landing page (no second search
 * box in the blog) and suggests a request the reader can type or pick there.
 */
export function TryQLead({ slug, position, title, request, hint }: { slug: string; position: string; title: string; request: string; hint?: string }) {
  return <aside className="blog-try" aria-label="Thử QLead">
    <p className="blog-try-title">{title}</p>
    <p className="blog-try-request">“{request}”</p>
    {hint && <p className="blog-try-hint">{hint}</p>}
    <BlogCtaLink className="btn btn-primary" href={productHref('/', slug, position, '#demo')} slug={slug} position={position}>Thử tìm với QLead <Icon name="arrow" size={18}/></BlogCtaLink>
  </aside>;
}
