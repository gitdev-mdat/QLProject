import Link from 'next/link';
import type { BlogPostMeta } from '@/lib/blog/types';
import { BLOG_EDITOR } from '@/lib/blog/site';
import { IllustrativePost, Note, Summary, TableFrame, TryQLead } from '@/components/blog/article-parts';

const slug = 'tim-quan-cafe-sap-khai-truong';

export const meta: BlogPostMeta = {
  slug,
  status: 'draft',
  topic: 'theo-nganh',
  title: 'Cách tìm quán cafe sắp khai trương trên Facebook để chào hàng sớm',
  h1: 'Cách tìm quán cafe sắp khai trương trên Facebook',
  description: 'Quán cafe thường để lộ dấu hiệu sắp mở trên Facebook trước ngày khai trương. Cách nhận ra, cụm từ nên tìm, cách loại bài lạc đề và nhắn tin không bị coi là spam.',
  primaryKeyword: 'tìm quán cafe sắp khai trương',
  secondaryKeywords: ['quán cafe sắp khai trương', 'tìm quán mới mở để chào hàng', 'khách hàng cho phần mềm quản lý quán cafe'],
  publishedAt: null,
  updatedAt: '2026-11-09',
  author: BLOG_EDITOR,
  reviewedBy: null,
  readingMinutes: 9,
  toc: [
    { id: 'vi-sao-truoc-khai-truong', title: 'Vì sao nên liên hệ trước ngày khai trương' },
    { id: 'dau-hieu', title: 'Năm dấu hiệu quán sắp mở trên Facebook' },
    { id: 'tu-tim', title: 'Tự tìm trên Facebook, từng bước' },
    { id: 'doc-bai', title: 'Lead thật hay bài lạc đề?' },
    { id: 'nhan-tin', title: 'Nhắn tin lần đầu cho chủ quán' },
    { id: 'uu-nhuoc', title: 'Ưu và nhược điểm của cách tự tìm' },
    { id: 'cong-cu', title: 'Khi nào nên dùng công cụ theo dõi' },
  ],
  related: ['tim-khach-hang-tiem-nang-tren-facebook'],
  sources: [
    { label: 'Sapo: Lập kế hoạch khai trương quán cafe chi tiết và hiệu quả', url: 'https://www.sapo.vn/blog/khai-truong-quan-cafe', note: 'Đặt việc mua phần mềm quản lý quán và đào tạo nhân viên vào kế hoạch trước ngày khai trương.' },
    { label: 'Toast: Opening a Coffee Shop Checklist', url: 'https://pos.toasttab.com/vi-us/resources/opening-a-coffee-shop-checklist', note: 'Checklist mở quán có mốc 9, 6 và 3 tháng trước khai trương và mục chọn hệ thống POS (tiếng Anh).' },
    { label: 'Bộ tín hiệu và cách xếp hạng bài đăng QLead đang dùng', note: 'Mô tả trong bài dựa trên mã nguồn sản phẩm tại thời điểm cập nhật.' },
  ],
};

/** Order in which signals usually appear for one shop. Relative only: real timelines vary and no durations are claimed. */
function SignalTimeline() {
  const steps = [
    { label: 'Nhận mặt bằng', who: 'Thi công, nội thất, thiết bị' },
    { label: 'Thi công, sửa sang', who: 'Thiết bị, biển hiệu, phần mềm' },
    { label: 'Tuyển nhân viên', who: 'Phần mềm, đồng phục, đào tạo' },
    { label: 'Thông báo khai trương', who: 'Nguyên liệu, in ấn, quảng bá' },
  ];
  return <figure className="blog-figure">
    <ol className="blog-timeline">{steps.map((step, index) => <li key={step.label}>
      <span className="blog-timeline-dot" aria-hidden="true">{index + 1}</span>
      <span className="blog-timeline-label">{step.label}</span>
      <span className="blog-timeline-who">{step.who}</span>
    </li>)}</ol>
    <figcaption>Thứ tự dấu hiệu thường gặp ở một quán sắp mở, và nhóm người bán hợp với từng giai đoạn. Không phải quán nào cũng đăng đủ bốn bước, và khoảng cách giữa các bước khác nhau tùy quán.</figcaption>
  </figure>;
}

export default function Article() {
  return <>
    <Summary>
      <p>Trước ngày khai trương, nhiều chủ quán cafe đăng lên Facebook chuyện nhận mặt bằng, sửa sang, tuyển nhân viên hay đếm ngược ngày mở cửa. Để tìm những quán này, hãy ghép <strong>loại quán + giai đoạn + khu vực</strong> thành cụm tìm kiếm, ưu tiên bài đăng trong khoảng 7 ngày gần nhất, đọc kỹ để loại bài review hay quảng cáo, rồi nhắn một tin ngắn có nhắc đúng lý do bạn liên hệ.</p>
    </Summary>

    <p>Bài này dành cho người bán sản phẩm hoặc dịch vụ cho quán: phần mềm quản lý và máy tính tiền, máy pha, nguyên liệu, nội thất, biển hiệu, đồng phục, dịch vụ tuyển dụng hay quảng bá. Mọi bước dưới đây làm được bằng tài khoản Facebook bình thường, không cần công cụ nào.</p>

    <h2 id="vi-sao-truoc-khai-truong">Vì sao nên liên hệ trước ngày khai trương</h2>
    <p>Nhiều việc mua sắm của một quán mới được chốt trong giai đoạn chuẩn bị. Các bản kế hoạch mở quán phổ biến cũng xếp như vậy: hướng dẫn khai trương quán cafe của Sapo đưa việc mua phần mềm quản lý quán và đào tạo nhân viên vào phần chuẩn bị trước ngày mở cửa, còn checklist mở quán của Toast chia việc theo mốc 9, 6 và 3 tháng trước khai trương và có mục chọn hệ thống bán hàng (POS).</p>
    <p>Sau khi quán đã mở, chủ quán bận vận hành và phần lớn nhà cung cấp đã được chọn. Bạn vẫn có thể chào hàng, nhưng khi đó bạn phải thuyết phục họ đổi sang bạn, thay vì giúp họ chọn từ đầu.</p>

    <h2 id="dau-hieu">Năm dấu hiệu quán sắp mở trên Facebook</h2>
    <p>Chủ quán hiếm khi viết “tôi cần mua phần mềm”. Họ viết về việc họ đang làm. Mỗi việc đó là một <em>tín hiệu</em> cho biết quán đang ở giai đoạn nào.</p>
    <SignalTimeline/>
    <TableFrame caption="Năm dấu hiệu và cách dùng. Câu chữ là ví dụ thường gặp, không phải danh sách đầy đủ.">
      <thead><tr><th scope="col">Dấu hiệu</th><th scope="col">Câu chữ thường gặp</th><th scope="col">Hợp với ai</th><th scope="col">Cần kiểm tra thêm</th></tr></thead>
      <tbody>
        <tr><th scope="row">Mới nhận, mới thuê mặt bằng</th><td>“vừa nhận mặt bằng”, “thuê mặt bằng mới”, “mặt bằng để mở quán”</td><td>Thi công, nội thất, thiết bị</td><td>Người đăng có phải môi giới mặt bằng không</td></tr>
        <tr><th scope="row">Đang thi công, sửa sang</th><td>“đang hoàn thiện”, “đang thi công”, “setup quán”</td><td>Thiết bị, biển hiệu, phần mềm</td><td>Bài của chủ quán hay của đơn vị thi công khoe công trình</td></tr>
        <tr><th scope="row">Tuyển nhân viên cho quán mới</th><td>“tuyển pha chế cho quán sắp khai trương”, “tuyển gấp phục vụ, quán mới”</td><td>Phần mềm, đồng phục, đào tạo</td><td>Quán đã mở lâu cũng tuyển người; cần thấy chữ “sắp khai trương”, “quán mới” hoặc “chi nhánh mới”</td></tr>
        <tr><th scope="row">Thông báo sắp khai trương</th><td>“sắp khai trương”, “soft opening”, “đếm ngược”, “chính thức mở cửa ngày…”</td><td>Nguyên liệu, in ấn, quảng bá, hoa</td><td>Ngày khai trương đã qua chưa</td></tr>
        <tr><th scope="row">Mở thêm chi nhánh</th><td>“chi nhánh 2”, “cơ sở mới”, “mở thêm quán ở…”</td><td>Phần mềm quản lý nhiều cửa hàng, thiết bị</td><td>“Mở rộng” đôi khi chỉ là mở rộng thực đơn hay thêm tầng</td></tr>
      </tbody>
    </TableFrame>
    <p>Một tín hiệu nữa đáng biết là <strong>sang nhượng quán</strong>. Bài sang nhượng cho biết một quán sắp đổi chủ. Người bán phần mềm hay thiết bị thường chưa liên hệ được ngay, nhưng có thể theo dõi để biết ai là chủ mới.</p>

    <h2 id="tu-tim">Tự tìm trên Facebook, từng bước</h2>
    <h3>Bước 1: Viết sẵn cụm tìm kiếm theo công thức</h3>
    <p>Ghép ba phần: <strong>loại quán</strong> (quán cà phê, cafe, coffee), <strong>giai đoạn</strong> (sắp khai trương, mới thuê mặt bằng, tuyển pha chế, chi nhánh mới) và <strong>khu vực</strong> (quận, thành phố). Ví dụ:</p>
    <ul className="blog-list">
      <li>quán cà phê sắp khai trương Thủ Đức</li>
      <li>tuyển pha chế quán mới Đà Nẵng</li>
      <li>nhận mặt bằng mở quán cafe Gò Vấp</li>
      <li>coffee soft opening Hà Đông</li>
    </ul>
    <p>Thử cả cách viết không dấu (“sap khai truong”) và từ tiếng Anh, vì nhiều bài đăng viết như vậy.</p>

    <h3>Bước 2: Lọc kết quả theo bài viết và độ mới</h3>
    <p>Sau khi tìm, chọn mục Bài viết, rồi xem các bài gần đây trước. Tên và vị trí bộ lọc thay đổi theo phiên bản ứng dụng, nên nếu không thấy, hãy kiểm tra cả bản web và bản điện thoại. Xem thêm mục Reels hoặc video, vì nhiều chủ quán quay lại quá trình sửa sang thay vì viết bài.</p>

    <h3>Bước 3: Ưu tiên bài trong khoảng 7 ngày</h3>
    <p>Một bài “sắp khai trương” từ hai tháng trước nhiều khả năng đã lỗi thời. Hãy ưu tiên bài trong vài ngày gần đây. Với bài cũ hơn một tuần, chỉ giữ lại nếu bài cho thấy quán vẫn đang chuẩn bị (đang thi công, chưa khai trương, vẫn đang tuyển). QLead cũng xếp hạng bài theo đúng nguyên tắc này: bài càng mới càng được ưu tiên, bài quá 7 ngày bị hạ xuống trừ khi còn dấu hiệu đang chuẩn bị.</p>

    <h3>Bước 4: Ghi lại vào một bảng</h3>
    <p>Mỗi dòng gồm: link bài, ngày đăng, khu vực, dấu hiệu, ngày bạn liên hệ và kết quả. Bảng này giúp bạn không liên hệ một quán hai lần và biết dấu hiệu nào thường dẫn tới cuộc nói chuyện thật.</p>

    <h3>Bước 5: Lặp lại đều đặn</h3>
    <p>Bài mới xuất hiện mỗi ngày. Một lượt tìm 15–20 phút mỗi buổi sáng thường đủ cho một hai khu vực. Khi số khu vực hoặc số loại quán tăng lên, thời gian này tăng theo.</p>

    <Note title="Chỉ dùng thông tin công khai">
      <p>Chỉ làm việc với bài đăng công khai. Không thu thập hàng loạt số điện thoại, tên hay ảnh từ Facebook để lập danh sách hay bán lại.</p>
    </Note>

    <h2 id="doc-bai">Lead thật hay bài lạc đề?</h2>
    <p>Kết quả tìm kiếm luôn lẫn nhiều bài không phải quán sắp mở. Trước khi lưu một bài, hãy trả lời bốn câu: <strong>Ai đăng</strong> (chủ quán, nhân viên, người review hay đơn vị cung cấp)? <strong>Quán đã mở chưa?</strong> <strong>Bài đăng khi nào?</strong> <strong>Có khu vực không?</strong></p>
    <p>Năm câu dưới đây do đội QLead viết để minh họa những kiểu bài hay gặp, không phải bài đăng thật.</p>
    <IllustrativePost text="Mới nhận mặt bằng ở Quận 7, đang sửa sang tiệm, tháng sau gặp mọi người nha." meta="Kiểu bài: chủ quán kể chuyện chuẩn bị"/>
    <p><strong>Nên lưu.</strong> Chủ quán tự đăng, quán chưa mở, có khu vực. Đây là giai đoạn sớm, hợp với thiết bị, nội thất và phần mềm.</p>
    <IllustrativePost text="Review quán cafe mới mở ở Quận 3, view đẹp, nước ổn, giá hơi cao." meta="Kiểu bài: người đi quán viết review"/>
    <p><strong>Thường bỏ qua.</strong> Người đăng là khách, và quán đã mở. Nhà cung cấp nguyên liệu vẫn có thể quan tâm, nhưng cơ hội giúp quán chọn phần mềm từ đầu đã qua.</p>
    <IllustrativePost text="Cần tuyển 2 bạn pha chế ca tối, quán đã hoạt động 3 năm, môi trường vui vẻ." meta="Kiểu bài: quán đang hoạt động tuyển người"/>
    <p><strong>Không phải quán mới.</strong> Bài tuyển dụng chỉ là tín hiệu mở quán khi có thêm chữ như “sắp khai trương”, “quán mới” hay “chi nhánh mới”.</p>
    <IllustrativePost text="Nhận thi công quán cafe trọn gói, setup từ A đến Z cho quán sắp khai trương, báo giá miễn phí." meta="Kiểu bài: quảng cáo của nhà cung cấp"/>
    <p><strong>Bỏ qua.</strong> Bài chứa đủ từ khóa nhưng người đăng là nhà cung cấp, có khi chính là đối thủ của bạn.</p>
    <IllustrativePost text="Quán mở rộng thêm tầng 2, có chỗ ngồi máy lạnh cho các bạn học bài." meta="Kiểu bài: quán đang hoạt động mở rộng chỗ ngồi"/>
    <p><strong>Tùy bạn bán gì.</strong> Đây không phải chi nhánh mới, nhưng có thể là cơ hội cho nội thất hay máy lạnh. Những bài như thế này dễ bị bộ lọc theo từ khóa bắt nhầm, kể cả bộ lọc của QLead, vì có chữ “mở rộng”. Vì vậy người bán vẫn nên đọc lại bài trước khi liên hệ.</p>

    <h2 id="nhan-tin">Nhắn tin lần đầu cho chủ quán</h2>
    <p>Chủ quán sắp khai trương nhận rất nhiều lời chào hàng. Tin nhắn của bạn nên ngắn, cho thấy bạn đã đọc bài của họ, và đưa một thứ có ích trước khi xin gặp.</p>
    <ul className="blog-list">
      <li><strong>Nhắc đúng bài đăng:</strong> “Mình thấy anh/chị đang hoàn thiện quán ở Quận 7.”</li>
      <li><strong>Một câu về bạn, một câu về lợi ích:</strong> bạn làm gì, giúp được việc gì trong giai đoạn này.</li>
      <li><strong>Một lời mời dễ nhận:</strong> gửi bảng giá, một checklist, hay hẹn ghé qua khi tiện.</li>
      <li><strong>Chấp nhận lời từ chối</strong> và không nhắn dồn dập.</li>
    </ul>
    <IllustrativePost text="Chào anh/chị, em thấy quán mình đang setup ở Quận 7. Em bên [tên đơn vị], làm phần mềm bán hàng cho quán cafe. Nếu anh/chị đang chọn máy tính tiền, em gửi bảng so sánh vài lựa chọn phổ biến để tham khảo, không cần mua bên em ạ." meta="Mẫu tin nhắn, chỉnh theo sản phẩm của bạn"/>
    <p>Không nên bình luận chào hàng ngay dưới bài, không gửi cùng một tin cho hàng loạt quán, và không gọi vào số điện thoại cá nhân nếu chủ quán không đăng số đó để liên hệ công việc.</p>

    <h2 id="uu-nhuoc">Ưu và nhược điểm của cách tự tìm</h2>
    <TableFrame caption="Tự tìm trên Facebook: điểm mạnh và giới hạn.">
      <thead><tr><th scope="col">Ưu điểm</th><th scope="col">Nhược điểm</th></tr></thead>
      <tbody>
        <tr><td>Miễn phí, bắt đầu được ngay</td><td>Tốn thời gian mỗi ngày, tăng theo số khu vực và loại quán</td></tr>
        <tr><td>Bạn đọc từng bài nên tự đánh giá được ngữ cảnh</td><td>Dễ sót bài không dùng đúng cụm bạn tìm</td></tr>
        <tr><td>Hiểu dần cách chủ quán trong khu vực viết bài</td><td>Khó nhớ bài nào đã xem, đã liên hệ nếu không ghi chép</td></tr>
        <tr><td>Không phụ thuộc công cụ</td><td>Kết quả tìm kiếm của Facebook thay đổi theo tài khoản và thời điểm</td></tr>
      </tbody>
    </TableFrame>

    <h2 id="cong-cu">Khi nào nên dùng công cụ theo dõi</h2>
    <p>Nếu bạn chỉ theo dõi một quận và một loại quán, tự tìm là đủ. Khi bạn cần theo dõi nhiều khu vực, nhiều loại cơ sở, hoặc không muốn ngày nào cũng ngồi gõ lại cùng các cụm từ, một công cụ theo dõi giúp tiết kiệm phần lặp lại.</p>
    <p>QLead làm phần việc đó theo cách sau:</p>
    <ul className="blog-list">
      <li>Bạn mô tả nhu cầu bằng một câu, ví dụ ngành bạn bán, loại quán và khu vực.</li>
      <li>QLead tìm trong bài đăng và Reels công khai mà công cụ tìm kiếm của Facebook trả về, theo loại cơ sở và dấu hiệu như sắp khai trương, mới thuê mặt bằng, đang tuyển người, mở chi nhánh.</li>
      <li>QLead kiểm tra lại theo lịch, mặc định khoảng 30 phút một lần, nên đây không phải theo dõi theo thời gian thực.</li>
      <li>Bài mới và sát mô tả được đưa lên trước, gom vào một danh sách. Bạn có thể bật thông báo khi có lead mới.</li>
    </ul>
    <p>QLead không nhắn tin thay bạn, không đọc được mọi nhóm hay mọi bài trên Facebook, có thể bắt nhầm bài lạc đề như ví dụ ở trên, và không bảo đảm người đăng sẽ mua. Bước đọc bài và liên hệ vẫn là của bạn.</p>
    <TryQLead slug={slug} position="cong-cu" title="Xem ví dụ lead thật QLead đã tìm thấy" request="Tôi bán phần mềm quản lý quán cafe, muốn tìm các quán cà phê sắp khai trương ở TP.HCM." hint="Ở phần “Thử tìm khách hàng của bạn”, bấm gợi ý “Phần mềm quán cafe” hoặc tự viết nhu cầu của bạn."/>
    <p>Muốn hiểu cách áp dụng các dấu hiệu này cho ngành khác ngoài quán cafe? Xem <Link href="/blog/tim-khach-hang-tiem-nang-tren-facebook">cách tìm khách hàng tiềm năng trên Facebook qua tín hiệu kinh doanh</Link>.</p>
  </>;
}
