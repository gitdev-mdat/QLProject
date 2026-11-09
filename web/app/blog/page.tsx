import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Icon } from '@/components/visuals';
import { BlogCtaLink } from '@/components/blog/blog-cta';
import { visiblePosts } from '@/lib/blog/posts';
import { TOPICS, formatDate, productHref } from '@/lib/blog/site';

const title = 'Blog QLead: tìm khách hàng theo tín hiệu kinh doanh';
const description = 'Hướng dẫn nhận ra cơ sở kinh doanh đang có nhu cầu trên Facebook, từ quán sắp khai trương đến cửa hàng mở chi nhánh, và cách tiếp cận đúng lúc.';

export function generateMetadata(): Metadata {
  const posts = visiblePosts();
  const onlyDrafts = posts.every(post => post.status === 'draft');
  return {
    title, description,
    alternates: { canonical: '/blog' },
    openGraph: { type: 'website', locale: 'vi_VN', siteName: 'QLead', title, description, url: '/blog' },
    // While every listed post is still a draft, the index is a review page and stays out of search.
    robots: onlyDrafts ? { index: false, follow: false } : undefined,
  };
}

export default function BlogIndex() {
  const posts = visiblePosts();
  // Production with nothing published: no empty blog page for Google or visitors.
  if (!posts.length) notFound();

  return <div className="blog-wrap blog-index">
    <header className="blog-index-head">
      <h1>Blog QLead</h1>
      <p>Cách nhận ra cơ sở kinh doanh đang có nhu cầu trên Facebook và tiếp cận họ đúng lúc.</p>
    </header>

    <ul className="blog-cards">{posts.map(post => <li key={post.slug} className="blog-card">
      <p className="blog-card-topic">{TOPICS[post.topic].label}{post.status === 'draft' && <span className="blog-draft-pill">Bản nháp</span>}</p>
      <h2><Link href={`/blog/${post.slug}`}>{post.h1}</Link></h2>
      <p className="blog-card-dek">{post.description}</p>
      <p className="blog-card-meta">{post.publishedAt ? formatDate(post.publishedAt) : `Cập nhật ${formatDate(post.updatedAt)}`} · {post.readingMinutes} phút đọc</p>
    </li>)}</ul>

    <aside className="blog-index-try">
      <div>
        <p className="blog-index-try-title">Muốn xem lead thật cho ngành của bạn?</p>
        <p>Mô tả bạn bán gì và tìm khách ở đâu, QLead cho xem ví dụ đã tìm thấy.</p>
      </div>
      <BlogCtaLink className="btn btn-outline" href={productHref('/', 'blog', 'index', '#demo')} slug="blog" position="index">Thử tìm khách <Icon name="arrow" size={18}/></BlogCtaLink>
    </aside>
  </div>;
}
