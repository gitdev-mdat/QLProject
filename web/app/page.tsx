import Link from 'next/link';
import { Brand, Icon } from '@/components/visuals';
import { HeroDemo } from '@/components/hero-demo';
import { HeroScene } from '@/components/hero-scene';
import { RevealOnScroll } from '@/components/reveal-on-scroll';
import { AnatomyShowcase, NavScrollState } from '@/components/landing-motion';

/** Verified sources only: social.search returns post and Reel permalinks (both are accepted as leads). */
const sources = ['Bài đăng', 'Reels'];

/**
 * One kind of opportunity (a place about to open) worded three ways. Illustration of how QLead searches: its plan
 * pairs each business type with stage signals (sắp khai trương, mới thuê mặt bằng, tuyển người trước khai trương).
 */
const example = [
  { kind: 'Bài đăng', text: 'Thứ Bảy này khai trương quán chè ở Quận 7, mời cả nhà ghé ủng hộ!', keyword: true, signal: 'Sắp khai trương' },
  { kind: 'Bài đăng', text: 'Tuyển 5 bạn phục vụ cho quán nướng sắp mở ở Gò Vấp.', keyword: false, signal: 'Tuyển người trước khi mở' },
  { kind: 'Reel', text: 'Mới nhận mặt bằng, đang sửa sang tiệm bánh, tháng sau gặp mọi người nha.', keyword: false, signal: 'Mới thuê mặt bằng' },
];

/** How QLead helps, as a three-step flow. Each line is backed by the product: search-plan.ts (signals, posts + Reels),
 * lead-ranking.ts (relevance/freshness order) and Web Push for new leads (opt-in, configured in production). */
const flow = [
  { icon: 'search', title: 'Tìm cơ hội', text: 'Từ mô tả của bạn, QLead tìm trong bài đăng và Reels theo nhiều dấu hiệu, kể cả bài không chứa đúng từ khóa bạn nghĩ tới.' },
  { icon: 'filter', title: 'Lọc và xếp trước', text: 'Bỏ bài không liên quan. Bài mới và sát với mô tả của bạn được đưa lên đầu. Liên hệ ai vẫn do bạn quyết định.' },
  { icon: 'bell', title: 'Báo cho bạn', text: 'Cơ hội mới vào thẳng danh sách, có đánh dấu bài mới. Bật thông báo để được báo trên điện thoại hoặc máy tính.' },
];

const differences = [
  { label: 'Cách tìm', manual: 'Gõ một từ khóa, chỉ ra bài có đúng chữ đó.', qlead: 'Một mô tả được mở rộng thành nhiều hướng tìm theo loại hình và dấu hiệu.' },
  { label: 'Thời điểm', manual: 'Dễ chỉ thấy khi tin khai trương đã đăng.', qlead: 'Có thể thấy từ lúc thuê mặt bằng, tuyển người, trước ngày mở cửa.' },
  { label: 'Theo dõi', manual: 'Phải nhớ quay lại tìm, ngày nào cũng vậy.', qlead: 'Tự kiểm tra lại theo lịch, cả khi bạn đang bận gọi khách.' },
  { label: 'Kết quả', manual: 'Rời rạc, không biết bài nào đã xem.', qlead: 'Bài đăng và Reels về chung một danh sách: mới, đã xem, đã lưu.' },
];

export default function LandingPage() {
  return <>
    <a className="skip-link" href="#main">Bỏ qua điều hướng</a>
    <RevealOnScroll/>
    <NavScrollState/>
    <header className="site-nav">
      <div className="wrap site-nav-inner">
        <Brand/>
        <nav aria-label="Trang giới thiệu"><a href="#khac-biet">Khác gì tự tìm</a><a href="#cach-hoat-dong">Cách hoạt động</a><a href="#demo">Dùng thử</a><a href="#lead-gom-gi">Mỗi lead có gì</a></nav>
        <div className="site-nav-actions"><Link className="btn btn-ghost" href="/dang-nhap">Đăng nhập</Link><Link className="btn btn-primary" href="/dang-ky">Bắt đầu ngay</Link></div>
      </div>
    </header>

    <main id="main">
      <section className="hero" aria-labelledby="hero-title">
        <div className="wrap hero-layout">
          <div className="hero-copy">
            <p className="kicker hero-in" style={{ animationDelay: '0s' }}>Tìm khách hàng tiềm năng cho đội sales</p>
            <h1 id="hero-title">
              <span className="hero-in" style={{ animationDelay: '.08s' }}>Tìm cơ hội bán hàng trên <span className="fb-word">Facebook<svg viewBox="0 0 220 14" preserveAspectRatio="none" aria-hidden="true"><path d="M3 10c50-7 140-9 214-4"/></svg></span>,</span>{' '}
              <span className="hero-accent hero-in" style={{ animationDelay: '.18s' }}>không chỉ theo từ khóa.</span>
            </h1>
            <p className="hero-lede hero-in" style={{ animationDelay: '.28s' }}>Mô tả khách bạn cần. QLead tìm theo những dấu hiệu như sắp khai trương, thuê mặt bằng, tuyển người, rồi gom cơ hội mới về một danh sách mỗi 30 phút.</p>
            <p className="hero-sources hero-in" style={{ animationDelay: '.34s' }}><span>Nguồn Facebook:</span>{sources.map(label => <b key={label}><Icon name="check" size={14}/>{label}</b>)}</p>
            <div className="hero-actions hero-in" style={{ animationDelay: '.4s' }}>
              <Link className="btn btn-primary btn-lg" href="/dang-ky">Bắt đầu ngay <Icon name="arrow" size={18}/></Link>
              <a className="btn btn-outline btn-lg" href="#demo">Xem thử</a>
            </div>
          </div>
          <div className="hero-art"><HeroScene/></div>
        </div>
      </section>

      <section className="section section-tint vs-section" id="khac-biet" aria-labelledby="compare-title">
        <div className="wrap">
          <div className="section-head centered" data-reveal>
            <h2 id="compare-title">Khác gì tự gõ từ khóa trên Facebook?</h2>
            <p>Một quán sắp mở có thể xuất hiện theo nhiều cách. Gõ một từ khóa dễ bỏ sót, QLead tìm theo dấu hiệu.</p>
          </div>

          <figure className="signal-example" data-reveal aria-labelledby="signal-example-title">
            <figcaption className="signal-example-head">
              <b id="signal-example-title">Cùng là quán sắp mở</b>
              <span className="sample-tag">Ví dụ minh họa</span>
            </figcaption>
            <div className="signal-example-cols" aria-hidden="true"><span/><span>Gõ “khai trương”</span><span>QLead</span></div>
            <ul>{example.map((item, index) => <li key={item.text} style={{ transitionDelay: `${200 + index * 140}ms` }}>
              <div className="signal-example-post">
                <span className={`kind-badge ${item.kind === 'Reel' ? 'is-reel' : ''}`}>{item.kind}</span>
                <p>{item.text}</p>
                <small>Dấu hiệu: {item.signal}</small>
              </div>
              <span className={`signal-mark ${item.keyword ? 'is-hit' : 'is-miss'}`}><span className="signal-mark-label">Gõ “khai trương”:</span>{item.keyword ? <><Icon name="check" size={16}/>Thấy</> : 'Dễ bỏ sót'}</span>
              <span className="signal-mark is-hit is-qlead"><span className="signal-mark-label">QLead:</span><Icon name="check" size={16}/>Có trong hướng tìm</span>
            </li>)}</ul>
            <p className="signal-example-note">Minh họa cách tìm, không phải kết quả thật. Kết quả thực tế tùy vào bài công khai mà Facebook trả về.</p>
          </figure>

          <div className="vs-table" role="table" aria-label="So sánh tự tìm trên Facebook và dùng QLead">
            <div className="vs-row vs-head" role="row"><span role="columnheader" aria-label="Tiêu chí"/><span role="columnheader">Tự tìm trên Facebook</span><span role="columnheader">Với QLead</span></div>
            {differences.map((row, index) => <div className="vs-row" role="row" key={row.label} data-reveal style={{ transitionDelay: `${index * 90}ms` }}>
              <span className="vs-label" role="rowheader">{row.label}</span>
              <p className="vs-manual" role="cell"><span className="vs-who">Tự tìm:</span>{row.manual}</p>
              <p className="vs-qlead" role="cell"><Icon name="check" size={18}/><span><span className="vs-who">Với QLead:</span>{row.qlead}</span></p>
            </div>)}
          </div>
        </div>
      </section>

      <section className="section" id="cach-hoat-dong" aria-labelledby="flow-title">
        <div className="wrap">
          <div className="section-head centered" data-reveal><h2 id="flow-title">QLead giúp bạn</h2><p>Bạn mô tả khách một lần. Phần tìm, lọc và báo tin, QLead làm thay.</p></div>
          <ol className="flow">{flow.map((step, index) => <li key={step.title} data-reveal style={{ transitionDelay: `${index * 110}ms` }}>
            <div className="flow-top"><span className="flow-icon"><Icon name={step.icon} size={22}/></span><span className="flow-step">Bước {index + 1}</span></div>
            <h3>{step.title}</h3><p>{step.text}</p>
          </li>)}</ol>
        </div>
      </section>

      <section className="section demo-section" id="demo" aria-labelledby="demo-title">
        <div className="wrap">
          <div className="section-head centered" data-reveal><h2 id="demo-title">Thử tìm khách hàng của bạn</h2></div>
          <div data-reveal><HeroDemo/></div>
        </div>
      </section>

      <section className="section" id="lead-gom-gi" aria-labelledby="anatomy-title">
        <div className="wrap anatomy">
          <div className="section-head" data-reveal><h2 id="anatomy-title">Mỗi lead có đủ thông tin để liên hệ</h2></div>
          <AnatomyShowcase/>
        </div>
      </section>

      <section className="final-cta">
        <span className="cta-glow" aria-hidden="true"/>
        <div className="wrap final-cta-inner" data-reveal>
          <h2>Bắt đầu nhận cơ hội mới từ Facebook cho ngành của bạn.</h2>
          <Link className="btn btn-primary btn-lg btn-shine" href="/dang-ky">Bắt đầu ngay <Icon name="arrow" size={18}/></Link>
        </div>
      </section>
    </main>

    <footer className="site-footer"><div className="wrap site-footer-inner"><Brand/><p>Tìm khách hàng tiềm năng từ bài đăng và Reels trên Facebook.</p><nav className="site-footer-links" aria-label="Tài khoản"><Link href="/dang-nhap">Đăng nhập</Link><Link href="/dang-ky">Tạo tài khoản</Link></nav><span>© 2026 QLead</span></div></footer>
  </>;
}
