import Link from 'next/link';
import { Brand, Icon } from '@/components/visuals';
import { HeroDemo } from '@/components/hero-demo';
import { HeroScene } from '@/components/hero-scene';
import { RevealOnScroll } from '@/components/reveal-on-scroll';
import { AnatomyShowcase, NavScrollState } from '@/components/landing-motion';

const benefits = [
  { icon: 'target', title: 'Đúng ngành bạn bán', text: 'Lọc theo ngành, tín hiệu và khu vực.' },
  { icon: 'radar', title: 'Tự quét mỗi 30 phút', text: 'Thiết lập một lần, QLead lo phần còn lại.' },
  { icon: 'clock', title: 'Biết sớm bài mới', text: 'Bài chưa xem luôn nằm trên cùng.' },
];


export default function LandingPage() {
  return <>
    <a className="skip-link" href="#main">Bỏ qua điều hướng</a>
    <RevealOnScroll/>
    <NavScrollState/>
    <header className="site-nav">
      <div className="wrap site-nav-inner">
        <Brand/>
        <nav aria-label="Trang giới thiệu"><a href="#demo">Dùng thử</a><a href="#theo-doi">Theo dõi tự động</a><a href="#lead-gom-gi">Mỗi lead có gì</a></nav>
        <div className="site-nav-actions"><Link className="btn btn-ghost" href="/dang-nhap">Đăng nhập</Link><Link className="btn btn-primary" href="/dang-ky">Bắt đầu ngay</Link></div>
      </div>
    </header>

    <main id="main">
      <section className="hero" aria-labelledby="hero-title">
        <div className="wrap hero-layout">
          <div className="hero-copy">
            <p className="kicker hero-in" style={{ animationDelay: '0s' }}>Công cụ tìm lead cho đội sales</p>
            <h1 id="hero-title">
              <span className="hero-in" style={{ animationDelay: '.08s' }}>Quét lead từ <span className="fb-word">Facebook<svg viewBox="0 0 220 14" preserveAspectRatio="none" aria-hidden="true"><path d="M3 10c50-7 140-9 214-4"/></svg></span></span>{' '}
              <span className="hero-accent hero-in" style={{ animationDelay: '.18s' }}>nhanh và tự động.</span>
            </h1>
            <p className="hero-lede hero-in" style={{ animationDelay: '.28s' }}>Mô tả khách hàng bạn cần. QLead tự quét Facebook mỗi 30 phút và gom lead mới về cho bạn.</p>
            <div className="hero-actions hero-in" style={{ animationDelay: '.38s' }}>
              <a className="btn btn-primary btn-lg" href="#demo">Khám phá QLead <Icon name="arrow" size={18}/></a>
              <Link className="btn btn-outline btn-lg" href="/dang-ky">Bắt đầu ngay</Link>
            </div>
          </div>
          <div className="hero-art"><HeroScene/></div>
        </div>
      </section>

      <section className="section demo-section" id="demo" aria-labelledby="demo-title">
        <div className="wrap">
          <div className="section-head centered" data-reveal><h2 id="demo-title">Thử tìm khách hàng của bạn</h2></div>
          <div data-reveal><HeroDemo/></div>
        </div>
      </section>

      <section className="section section-tint" id="theo-doi" aria-labelledby="monitor-title">
        <div className="wrap">
          <div className="section-head centered" data-reveal><h2 id="monitor-title">QLead theo dõi giúp bạn</h2></div>
          <ul className="benefits">{benefits.map((item, index) => <li key={item.title} data-reveal style={{ transitionDelay: `${index * 110}ms` }}>
            <span className={`benefit-icon is-${item.icon}`}><Icon name={item.icon} size={22}/></span><h3>{item.title}</h3><p>{item.text}</p>
          </li>)}</ul>
        </div>
      </section>

      <section className="section" id="lead-gom-gi" aria-labelledby="anatomy-title">
        <div className="wrap anatomy">
          <div className="section-head" data-reveal><h2 id="anatomy-title">Mỗi lead có đủ thông tin để liên hệ</h2></div>
          <AnatomyShowcase/>
        </div>
      </section>

      <section className="section section-tint" aria-labelledby="compare-title">
        <div className="wrap">
          <div className="section-head centered" data-reveal><h2 id="compare-title">Bớt giờ lướt nhóm, thêm giờ gọi khách</h2></div>
          <div className="compare">
            <div className="compare-col is-manual" data-reveal><h3>Tự tìm trên Facebook</h3><ul>{["Gõ lại từ khóa trong từng nhóm", "Dễ bỏ sót bài khi bận gọi khách", "Không biết bài nào đã xem"].map((text, index) => <li key={text} style={{ transitionDelay: `${400 + index * 150}ms` }}><span>{text}</span></li>)}</ul></div>
            <div className="compare-col is-qlead" data-reveal style={{ transitionDelay: '120ms' }}><h3>Với QLead</h3><ul>{["Quét tự động theo lịch", "Lead về chung một danh sách", "Đánh dấu mới, đã xem, đã lưu"].map((text, index) => <li key={text} style={{ transitionDelay: `${500 + index * 150}ms` }}><Icon name="check" size={18}/>{text}</li>)}</ul></div>
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

    <footer className="site-footer"><div className="wrap site-footer-inner"><Brand/><p>Tìm khách hàng tiềm năng từ bài đăng Facebook.</p><nav className="site-footer-links" aria-label="Tài khoản"><Link href="/dang-nhap">Đăng nhập</Link><Link href="/dang-ky">Tạo tài khoản</Link></nav><span>© 2026 QLead</span></div></footer>
  </>;
}
