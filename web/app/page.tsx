import Link from 'next/link';
import { Brand, Icon } from '@/components/visuals';
import { HeroDemo } from '@/components/hero-demo';
import { HeroScene } from '@/components/hero-scene';
import { RevealOnScroll } from '@/components/reveal-on-scroll';
import { NavScrollState } from '@/components/landing-motion';
import { pageMetadata, SITE_DESCRIPTION, SITE_TITLE } from '@/lib/seo';
import { hasVisiblePosts } from '@/lib/blog/posts';

export const metadata = pageMetadata({ title: SITE_TITLE, description: SITE_DESCRIPTION, path: '/' });

/**
 * Three things QLead does, each backed by shipped behaviour: signal-based search over posts and Reels
 * (search-plan.ts, lead-eligibility.ts), relevance/freshness ordering (lead-ranking.ts), and new-lead alerts
 * (in-app "mới" marker + opt-in Web Push). Images, comments and non-Reel video are not verified, so not named.
 */
const flow = [
  { icon: 'search', title: 'Tìm khách hàng tiềm năng', text: 'Trong bài đăng và Reels, theo đúng mô tả của bạn.' },
  { icon: 'filter', title: 'Đánh giá', text: 'Bỏ bài lạc đề, đưa bài sát nhu cầu lên trước.' },
  { icon: 'bell', title: 'Thông báo cho bạn', text: 'Có lead mới là báo. Không cần ngồi canh.' },
];

/** Paired lines: the same job done by hand vs. by QLead. Manual search still works; it just costs time. */
const compare = [
  { manual: 'Tự gõ và kiểm tra mỗi ngày', qlead: 'Tự theo dõi theo lịch' },
  { manual: 'Dễ sót bài không có đúng từ khóa', qlead: 'Tìm theo dấu hiệu kinh doanh' },
  { manual: 'Khó nhớ bài nào đã xem', qlead: 'Lead gom về một danh sách' },
  { manual: 'Lặp lại thao tác, tốn thời gian', qlead: 'Báo khi có lead mới' },
];

export default function LandingPage() {
  // "Cẩm nang" only appears once there is an article this deployment can serve; production hides drafts.
  const showGuide = hasVisiblePosts();
  return <>
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@graph': [
            {
              '@type': 'Organization',
              '@id': 'https://qlead.vn/#organization',
              name: 'QLead',
              url: 'https://qlead.vn',
              logo: 'https://qlead.vn/icons/icon-512.png',
            },
            {
              '@type': 'WebSite',
              '@id': 'https://qlead.vn/#website',
              url: 'https://qlead.vn',
              name: 'QLead',
              inLanguage: 'vi-VN',
              publisher: { '@id': 'https://qlead.vn/#organization' },
            },
          ],
        }).replace(/</g, '\\u003c'),
      }}
    />
    <a className="skip-link" href="#main">Bỏ qua điều hướng</a>
    <RevealOnScroll/>
    <NavScrollState/>
    <header className="site-nav">
      <div className="wrap site-nav-inner">
        <Brand/>
        <nav aria-label="Trang giới thiệu"><a href="#demo">Dùng thử</a><a href="#cach-hoat-dong">Cách hoạt động</a><a href="#so-sanh">So sánh</a>{showGuide && <Link href="/blog">Cẩm nang</Link>}</nav>
        <div className="site-nav-actions"><Link className="btn btn-ghost" href="/dang-nhap">Đăng nhập</Link><Link className="btn btn-primary" href="/dang-ky">Bắt đầu ngay</Link></div>
      </div>
    </header>

    <main id="main">
      <section className="hero" aria-labelledby="hero-title">
        <div className="wrap hero-layout">
          <div className="hero-copy">
            <p className="kicker hero-in" style={{ animationDelay: '0s' }}>Công cụ tìm lead cho đội sales</p>
            <h1 id="hero-title">
              <span className="hero-in" style={{ animationDelay: '.08s' }}>Tìm lead tự động</span>{' '}
              <span className="hero-accent hero-in" style={{ animationDelay: '.18s' }}>trên <span className="fb-word">Facebook<svg viewBox="0 0 220 14" preserveAspectRatio="none" aria-hidden="true"><path d="M3 10c50-7 140-9 214-4"/></svg></span></span>
            </h1>
            <p className="hero-lede hero-in" style={{ animationDelay: '.28s' }}>Không chỉ theo từ khóa. QLead theo dõi các dấu hiệu như sắp khai trương, tuyển người, mở chi nhánh và gom lead mới về cho bạn mỗi 30 phút.</p>
            <div className="hero-actions hero-in" style={{ animationDelay: '.38s' }}>
              <Link className="btn btn-primary btn-lg" href="/dang-ky">Bắt đầu ngay <Icon name="arrow" size={18}/></Link>
              <a className="btn btn-outline btn-lg" href="#demo">Thử ngay</a>
            </div>
          </div>
          <div className="hero-art"><HeroScene/></div>
        </div>
      </section>

      <section className="section demo-section" id="demo" aria-labelledby="demo-title">
        <div className="wrap">
          <div className="section-head centered" data-reveal><h2 id="demo-title">Thử tìm khách hàng của bạn</h2><p>Nhập nhu cầu, xem ngay lead thật QLead đã tìm thấy trên Facebook.</p></div>
          <div data-reveal><HeroDemo/></div>
        </div>
      </section>

      <section className="section section-tint" id="cach-hoat-dong" aria-labelledby="flow-title">
        <div className="wrap">
          <div className="section-head centered" data-reveal><h2 id="flow-title">QLead giúp bạn</h2></div>
          <ol className="flow">{flow.map((step, index) => <li key={step.title} data-reveal style={{ transitionDelay: `${index * 90}ms` }}>
            <span className="flow-icon"><Icon name={step.icon} size={22}/></span>
            <h3><span className="flow-num">{index + 1}.</span> {step.title}</h3><p>{step.text}</p>
          </li>)}</ol>
        </div>
      </section>

      <section className="section" id="so-sanh" aria-labelledby="compare-title">
        <div className="wrap">
          <div className="section-head centered" data-reveal><h2 id="compare-title">So với tự tìm trên Facebook</h2></div>
          <div className="duo" data-reveal>
            <div className="duo-col is-manual">
              <h3>Tự tìm trên Facebook</h3>
              <ul>{compare.map(row => <li key={row.manual}><span className="duo-mark" aria-hidden="true"/>{row.manual}</li>)}</ul>
            </div>
            <div className="duo-col is-qlead">
              <h3>Với QLead</h3>
              <ul>{compare.map(row => <li key={row.qlead}><Icon name="check" size={18}/>{row.qlead}</li>)}</ul>
            </div>
          </div>
        </div>
      </section>

      <section className="final-cta">
        <span className="cta-glow" aria-hidden="true"/>
        <div className="wrap final-cta-inner" data-reveal>
          <h2>Bắt đầu nhận lead từ Facebook cho ngành của bạn.</h2>
          <Link className="btn btn-primary btn-lg btn-shine" href="/dang-ky">Bắt đầu ngay <Icon name="arrow" size={18}/></Link>
        </div>
      </section>
    </main>

    <footer className="site-footer"><div className="wrap site-footer-inner"><Brand/><p>Tìm khách hàng tiềm năng từ bài đăng và Reels trên Facebook.</p><nav className="site-footer-links" aria-label="Liên kết">{showGuide && <Link href="/blog">Cẩm nang</Link>}<Link href="/dang-nhap">Đăng nhập</Link><Link href="/dang-ky">Tạo tài khoản</Link></nav><span>© 2026 QLead</span></div></footer>
  </>;
}
