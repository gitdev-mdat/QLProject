import Link from 'next/link';
import { Brand } from '@/components/visuals';
import { BlogCtaLink } from '@/components/blog/blog-cta';
import { productHref } from '@/lib/blog/site';
import { BlogAnalytics } from '@/components/blog/blog-analytics';
import './blog.css';

/**
 * The blog has its own chrome so it never touches the approved landing page. It shares the brand, colours and type
 * from globals.css, and none of the landing's motion or hero code.
 */
export default function BlogLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="blog-shell">
    <a className="skip-link" href="#blog-main">Bỏ qua điều hướng</a>
    <header className="blog-nav">
      <div className="blog-wrap blog-nav-inner">
        <div className="blog-nav-brand"><Brand/><Link href="/blog" className="blog-nav-section">Cẩm nang</Link></div>
        <div className="blog-nav-actions">
          <BlogCtaLink className="btn btn-ghost blog-nav-try" href={productHref('/', 'blog', 'nav', '#demo')} slug="blog" position="nav">Thử tìm khách</BlogCtaLink>
          <BlogCtaLink className="btn btn-primary btn-sm" href={productHref('/dang-ky', 'blog', 'nav')} slug="blog" position="nav-signup">Bắt đầu</BlogCtaLink>
        </div>
      </div>
    </header>
    <main id="blog-main"><BlogAnalytics/>{children}</main>
    <footer className="blog-footer">
      <div className="blog-wrap blog-footer-inner">
        <Brand/>
        <p>Hướng dẫn tìm và tiếp cận khách hàng đang có nhu cầu, do đội ngũ QLead biên soạn.</p>
        <nav aria-label="Liên kết"><Link href="/">Trang chủ</Link><Link href="/blog">Cẩm nang</Link><Link href="/dang-nhap">Đăng nhập</Link></nav>
      </div>
    </footer>
  </div>;
}
