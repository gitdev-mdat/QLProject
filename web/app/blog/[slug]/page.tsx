import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Icon } from '@/components/visuals';
import { BlogCtaLink } from '@/components/blog/blog-cta';
import { findPost, relatedPosts, visiblePosts } from '@/lib/blog/posts';
import { SITE_URL, TOPICS, formatDate, productHref } from '@/lib/blog/site';
import type { BlogPost } from '@/lib/blog/types';
import { SOCIAL_IMAGE } from '@/lib/seo';

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return visiblePosts().map(post => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = findPost((await params).slug);
  if (!post) return {};
  const url = `/blog/${post.slug}`;
  return {
    title: post.title,
    description: post.description,
    alternates: { canonical: url },
    openGraph: {
      type: 'article', locale: 'vi_VN', siteName: 'QLead', url, title: post.title, description: post.description,
      ...(post.publishedAt ? { publishedTime: post.publishedAt } : {}), modifiedTime: post.updatedAt,
      images: [SOCIAL_IMAGE],
    },
    twitter: { card: 'summary_large_image', title: post.title, description: post.description, images: [SOCIAL_IMAGE] },
    // A draft is a review copy: never indexed, even if someone shares the preview link.
    robots: post.status === 'draft' ? { index: false, follow: false } : undefined,
  };
}

/** Article + breadcrumb structured data, built only from what the page itself shows. */
function structuredData(post: BlogPost) {
  const url = `${SITE_URL}/blog/${post.slug}`;
  const organization = { '@type': 'Organization', name: 'QLead', url: SITE_URL, logo: `${SITE_URL}/icons/icon-512.png` };
  return [
    {
      '@context': 'https://schema.org', '@type': 'BlogPosting',
      headline: post.h1, description: post.description, inLanguage: 'vi-VN', url, mainEntityOfPage: url,
      ...(post.publishedAt ? { datePublished: post.publishedAt } : {}), dateModified: post.updatedAt,
      author: { '@type': 'Organization', name: post.author.name, url: SITE_URL },
      publisher: organization,
    },
    {
      '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'QLead', item: SITE_URL },
        { '@type': 'ListItem', position: 2, name: 'Cẩm nang', item: `${SITE_URL}/blog` },
        { '@type': 'ListItem', position: 3, name: post.h1, item: url },
      ],
    },
  ];
}

function TocList({ post }: { post: BlogPost }) {
  return <ol>{post.toc.map(item => <li key={item.id}><a href={`#${item.id}`}>{item.title}</a></li>)}</ol>;
}

export default async function BlogArticle({ params }: Props) {
  const post = findPost((await params).slug);
  if (!post) notFound();
  const related = relatedPosts(post);
  const { Body } = post;

  return <article className="blog-article">
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData(post)).replace(/</g, '\\u003c') }}/>
    <div className="blog-wrap blog-article-head">
      {post.status === 'draft' && <p className="blog-draft-banner" role="note"><Icon name="info" size={18}/>Bản nháp chờ duyệt. Trang này không được lập chỉ mục và chưa xuất bản.</p>}
      <nav className="blog-breadcrumb" aria-label="Đường dẫn">
        <ol><li><Link href="/">QLead</Link></li><li><Link href="/blog">Cẩm nang</Link></li><li aria-current="page">{TOPICS[post.topic].label}</li></ol>
      </nav>
      <h1>{post.h1}</h1>
      <p className="blog-dek">{post.description}</p>
      <p className="blog-byline">
        <span>{post.author.name}</span>
        <span>{post.publishedAt ? <>Đăng <time dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time> · </> : null}Cập nhật <time dateTime={post.updatedAt}>{formatDate(post.updatedAt)}</time></span>
        <span>{post.readingMinutes} phút đọc</span>
      </p>
      {post.reviewedBy && <p className="blog-reviewed">Kiểm tra nội dung: {post.reviewedBy}</p>}
    </div>

    <div className="blog-wrap blog-article-layout">
      {post.toc.length >= 4 && <>
        {/* Phones: collapsed so the article starts on the first screen. Wide screens: a sticky list beside the text. */}
        <details className="blog-toc blog-toc-compact">
          <summary>Trong bài này</summary>
          <TocList post={post}/>
        </details>
        <nav className="blog-toc blog-toc-side" aria-label="Trong bài này">
          <p className="blog-toc-title">Trong bài này</p>
          <TocList post={post}/>
        </nav>
      </>}

      <div className="blog-prose">
        <Body/>

        <section className="blog-end" aria-label="Bắt đầu với QLead">
          <p className="blog-end-title">Theo dõi khách hàng theo tín hiệu, không cần tìm tay mỗi ngày</p>
          <p>Tạo tài khoản miễn phí, mô tả khách hàng bạn cần, QLead gom lead mới về một danh sách.</p>
          <div className="blog-end-actions">
            <BlogCtaLink className="btn btn-primary" href={productHref('/dang-ky', post.slug, 'end')} slug={post.slug} position="end">Bắt đầu miễn phí <Icon name="arrow" size={18}/></BlogCtaLink>
            <BlogCtaLink className="text-link" href={productHref('/', post.slug, 'end-try', '#demo')} slug={post.slug} position="end-try">Thử trước, không cần đăng ký</BlogCtaLink>
          </div>
        </section>

        <section className="blog-method" aria-labelledby="phuong-phap">
          <h2 id="phuong-phap">Cách bài này được viết</h2>
          <p>Bài do {post.author.name} biên soạn. Những gì bài nói về QLead được đối chiếu với sản phẩm tại ngày cập nhật. Các ví dụ bài đăng có nhãn “Minh họa” do biên tập viên viết, không phải bài đăng thật của ai.</p>
          {post.sources.length > 0 && <>
            <h3>Nguồn tham khảo</h3>
            <ul>{post.sources.map(source => <li key={source.label}>
              {source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.label}</a> : source.label}
              {source.note && <span className="blog-source-note"> {source.note}</span>}
            </li>)}</ul>
          </>}
        </section>
      </div>
    </div>

    {related.length > 0 && <aside className="blog-wrap blog-related" aria-labelledby="bai-lien-quan">
      <h2 id="bai-lien-quan">Bài liên quan</h2>
      <ul className="blog-cards">{related.map(other => <li key={other.slug} className="blog-card">
        <p className="blog-card-topic">{TOPICS[other.topic].label}</p>
        <h3><Link href={`/blog/${other.slug}`}>{other.h1}</Link></h3>
        <p className="blog-card-dek">{other.description}</p>
      </li>)}</ul>
    </aside>}
  </article>;
}
