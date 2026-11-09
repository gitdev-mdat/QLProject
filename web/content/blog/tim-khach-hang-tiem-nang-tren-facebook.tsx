import Link from 'next/link';
import type { BlogPostMeta } from '@/lib/blog/types';
import { BLOG_EDITOR } from '@/lib/blog/site';
import { IllustrativePost, Note, Summary, TableFrame, TryQLead } from '@/components/blog/article-parts';

const slug = 'tim-khach-hang-tiem-nang-tren-facebook';

export const meta: BlogPostMeta = {
  slug,
  status: 'draft',
  topic: 'tin-hieu',
  title: 'Cách tìm khách hàng tiềm năng trên Facebook qua tín hiệu kinh doanh',
  h1: 'Tìm khách hàng tiềm năng trên Facebook qua tín hiệu kinh doanh',
  description: 'Thay vì chờ khách thấy quảng cáo, hãy tìm những cơ sở đang sắp mở, tuyển người hay mở chi nhánh. Sáu tín hiệu, cách ghép với ngành và khu vực, và cách loại bài lạc đề.',
  primaryKeyword: 'cách tìm khách hàng tiềm năng trên Facebook',
  secondaryKeywords: ['tìm khách hàng trên Facebook', 'tín hiệu mua hàng', 'tìm khách hàng B2B trên Facebook'],
  publishedAt: null,
  updatedAt: '2026-11-09',
  author: BLOG_EDITOR,
  reviewedBy: null,
  readingMinutes: 10,
  toc: [
    { id: 'hai-cach', title: 'Hai cách tìm khách trên Facebook' },
    { id: 'tin-hieu-la-gi', title: 'Tín hiệu kinh doanh là gì' },
    { id: 'sau-tin-hieu', title: 'Sáu tín hiệu đáng theo dõi' },
    { id: 'ghep-nganh', title: 'Ghép tín hiệu với ngành và khu vực' },
    { id: 'tim-o-dau', title: 'Tìm ở đâu trên Facebook' },
    { id: 'do-moi', title: 'Tín hiệu nào còn “nóng”' },
    { id: 'de-nham', title: 'Những bài dễ nhầm là lead' },
    { id: 'quy-trinh', title: 'Quy trình 20 phút mỗi ngày' },
    { id: 'cong-cu', title: 'Khi nào nên dùng công cụ' },
  ],
  related: ['tim-quan-cafe-sap-khai-truong'],
  sources: [
    { label: 'Bộ tín hiệu, danh mục ngành và cách xếp hạng bài đăng QLead đang dùng', note: 'Mô tả trong bài dựa trên mã nguồn sản phẩm tại thời điểm cập nhật.' },
  ],
};

export default function Article() {
  return <>
    <Summary>
      <p>Nếu bạn bán cho cửa hàng, quán, cơ sở dịch vụ, hãy tìm trên Facebook những bài cho thấy cơ sở đó <strong>sắp thay đổi</strong>: sắp khai trương, mới thuê mặt bằng, mới mở, đang tuyển người, mở chi nhánh hoặc sang nhượng. Ghép tín hiệu với loại cơ sở và khu vực để tìm, ưu tiên bài mới, loại bài của người review và nhà cung cấp, rồi liên hệ khi tín hiệu còn mới.</p>
    </Summary>

    <h2 id="hai-cach">Hai cách tìm khách trên Facebook</h2>
    <p>Phần lớn hướng dẫn “tìm khách trên Facebook” nói về cách để khách tìm đến bạn: chạy quảng cáo, chăm fanpage, đăng bài vào nhóm. Cách đó hợp với bán lẻ cho người tiêu dùng.</p>
    <p>Bài này nói về cách ngược lại: <strong>bạn đi tìm những cơ sở vừa để lộ nhu cầu</strong>, rồi liên hệ trực tiếp. Cách này hợp với người bán cho doanh nghiệp nhỏ và hộ kinh doanh, như phần mềm quản lý, thiết bị, nguyên liệu, nội thất, dịch vụ tuyển dụng, kế toán hay quảng bá. Nếu bạn bán cho người tiêu dùng cá nhân, cách này ít hiệu quả hơn.</p>

    <h2 id="tin-hieu-la-gi">Tín hiệu kinh doanh là gì</h2>
    <p>Tín hiệu kinh doanh là một việc được nói công khai cho thấy một cơ sở sắp cần mua, thuê hoặc tuyển. Chủ cơ sở hiếm khi viết “tôi cần mua phần mềm bán hàng”, nhưng họ thường viết “tuần sau khai trương” hay “cần tuyển 3 bạn phục vụ cho chi nhánh mới”.</p>
    <p>Vì vậy, tìm theo tên sản phẩm bạn bán thường ra rất ít kết quả. Tìm theo việc khách hàng đang làm thì ra nhiều hơn và đúng lúc hơn.</p>

    <h2 id="sau-tin-hieu">Sáu tín hiệu đáng theo dõi</h2>
    <TableFrame caption="Sáu tín hiệu QLead dùng để nhận diện cơ hội. Câu chữ là ví dụ thường gặp.">
      <thead><tr><th scope="col">Tín hiệu</th><th scope="col">Câu chữ thường gặp</th><th scope="col">Cơ sở đang cần gì</th></tr></thead>
      <tbody>
        <tr><th scope="row">Sắp khai trương</th><td>“sắp khai trương”, “chuẩn bị mở cửa”, “soft opening”</td><td>Phần mềm, thiết bị, nguyên liệu, in ấn, quảng bá</td></tr>
        <tr><th scope="row">Mới thuê mặt bằng</th><td>“vừa nhận mặt bằng”, “thuê mặt bằng mới”</td><td>Thi công, nội thất, thiết bị, biển hiệu</td></tr>
        <tr><th scope="row">Mới khai trương</th><td>“mới khai trương”, “vừa mở”</td><td>Nguyên liệu, quảng bá, dịch vụ vận hành</td></tr>
        <tr><th scope="row">Đang tuyển người</th><td>“tuyển gấp”, “cần người”, “tuyển nhân viên”</td><td>Đồng phục, đào tạo, phần mềm chấm công, tuyển dụng</td></tr>
        <tr><th scope="row">Mở chi nhánh</th><td>“chi nhánh mới”, “cơ sở 2”, “mở thêm”</td><td>Phần mềm quản lý nhiều cửa hàng, thiết bị, thi công</td></tr>
        <tr><th scope="row">Sang nhượng</th><td>“sang nhượng”, “sang lại quán”, “nhượng lại tiệm”</td><td>Chủ mới sẽ cần thiết bị, phần mềm, sửa sang</td></tr>
      </tbody>
    </TableFrame>
    <p>Một bài có thể chứa nhiều tín hiệu cùng lúc, ví dụ vừa thông báo sắp khai trương vừa tuyển người. Bài như vậy thường là cơ hội rõ hơn bài chỉ có một tín hiệu.</p>

    <h2 id="ghep-nganh">Ghép tín hiệu với ngành và khu vực</h2>
    <p>Công thức tìm kiếm: <strong>loại cơ sở + tín hiệu + khu vực</strong>. Loại cơ sở là khách hàng của bạn, không phải sản phẩm của bạn.</p>
    <TableFrame caption="Ví dụ cụm tìm kiếm theo người bán.">
      <thead><tr><th scope="col">Bạn bán</th><th scope="col">Cụm tìm kiếm thử</th></tr></thead>
      <tbody>
        <tr><td>Phần mềm quản lý quán</td><td>quán trà sữa sắp khai trương Bình Thạnh</td></tr>
        <tr><td>Thiết bị, mỹ phẩm cho spa</td><td>spa mới thuê mặt bằng Cầu Giấy</td></tr>
        <tr><td>Phần mềm quản lý nhà thuốc</td><td>nhà thuốc mở chi nhánh mới Biên Hòa</td></tr>
        <tr><td>Phần mềm quản lý khách sạn</td><td>homestay sắp đi vào hoạt động Đà Lạt</td></tr>
        <tr><td>Dịch vụ tuyển dụng, đào tạo</td><td>trung tâm tiếng Anh tuyển giáo viên cơ sở mới</td></tr>
      </tbody>
    </TableFrame>
    <p>Với quán cafe, xem hướng dẫn chi tiết hơn tại <Link href="/blog/tim-quan-cafe-sap-khai-truong">cách tìm quán cafe sắp khai trương trên Facebook</Link>.</p>

    <h2 id="tim-o-dau">Tìm ở đâu trên Facebook</h2>
    <ul className="blog-list">
      <li><strong>Ô tìm kiếm, mục Bài viết:</strong> nơi bắt đầu. Xem các bài gần đây trước. Tên bộ lọc thay đổi theo phiên bản ứng dụng.</li>
      <li><strong>Reels và video:</strong> nhiều chủ cơ sở quay quá trình sửa sang hay ngày khai trương thay vì viết bài.</li>
      <li><strong>Nhóm công khai theo khu vực hoặc ngành:</strong> nhóm tuyển dụng, nhóm sang nhượng mặt bằng, nhóm chủ quán. Đọc nội quy nhóm; nhiều nhóm cấm chào hàng.</li>
      <li><strong>Fanpage của cơ sở:</strong> khi đã thấy tín hiệu, xem fanpage để biết quy mô và người phụ trách.</li>
    </ul>
    <Note title="Chỉ dùng thông tin công khai">
      <p>Chỉ làm việc với bài đăng công khai. Không thu thập hàng loạt số điện thoại, tên hay ảnh để lập danh sách hay bán lại.</p>
    </Note>

    <h2 id="do-moi">Tín hiệu nào còn “nóng”</h2>
    <p>Tín hiệu hết giá trị khá nhanh. Một quán đăng tuyển người cho ngày khai trương tuần trước có lẽ đã chọn xong nhà cung cấp. Khi xếp hạng bài đăng, QLead dùng nguyên tắc sau, và bạn có thể áp dụng khi tự tìm:</p>
    <ul className="blog-list">
      <li>Bài trong vòng một ngày được ưu tiên nhất, sau đó đến bài trong 3 ngày và 7 ngày.</li>
      <li>Bài quá 7 ngày bị hạ ưu tiên, trừ khi bài cho thấy cơ sở vẫn đang chuẩn bị: đang thi công, chưa khai trương, vẫn đang tuyển.</li>
      <li>Bài không rõ ngày đăng được xếp sau bài có ngày rõ ràng.</li>
    </ul>

    <h2 id="de-nham">Những bài dễ nhầm là lead</h2>
    <p>Tìm theo từ khóa luôn ra nhiều bài lạc đề. Đây là những kiểu hay gặp, kể cả với bộ lọc của QLead. Các câu dưới đây do đội QLead viết để minh họa, không phải bài đăng thật.</p>
    <IllustrativePost text="Nhận thi công spa trọn gói, setup cho cơ sở sắp khai trương, báo giá miễn phí." meta="Nhà cung cấp quảng cáo"/>
    <p>Có đủ từ khóa nhưng người đăng là nhà cung cấp, có khi là đối thủ của bạn.</p>
    <IllustrativePost text="Review tiệm bánh mới mở gần nhà, bánh ngon, giá mềm." meta="Khách hàng review"/>
    <p>Người đăng là khách, và cơ sở đã hoạt động.</p>
    <IllustrativePost text="Tuyển chọn 10 quán cà phê đẹp nhất Đà Lạt cho chuyến đi cuối tuần." meta="Bài du lịch"/>
    <p>Chữ “tuyển” ở đây là “tuyển chọn”, không phải tuyển người. Bộ lọc theo từ khóa dễ bắt nhầm kiểu bài này.</p>
    <IllustrativePost text="Nhà hàng mở rộng thực đơn với 5 món mới từ tuần này." meta="Cơ sở đang hoạt động"/>
    <p>“Mở rộng” ở đây là thực đơn, không phải chi nhánh mới.</p>
    <p>Cách loại nhanh: hỏi <strong>ai đăng</strong>, <strong>cơ sở đã mở chưa</strong>, <strong>đăng khi nào</strong>, <strong>ở đâu</strong>. Nếu không trả lời được ít nhất ba câu, bỏ qua bài đó.</p>

    <h2 id="quy-trinh">Quy trình 20 phút mỗi ngày</h2>
    <ol className="blog-steps">
      <li><strong>Chuẩn bị một lần:</strong> 5–10 cụm tìm kiếm theo công thức ở trên, cho một hai khu vực bạn phục vụ.</li>
      <li><strong>Mỗi sáng:</strong> chạy lại các cụm, chỉ xem bài gần đây.</li>
      <li><strong>Lọc:</strong> bỏ bài của người review, nhà cung cấp, bài quá cũ.</li>
      <li><strong>Ghi lại:</strong> link, ngày đăng, khu vực, tín hiệu, ngày liên hệ, kết quả.</li>
      <li><strong>Liên hệ trong ngày:</strong> tin nhắn ngắn nhắc đúng bài đăng và đưa một thứ có ích. Xem <Link href="/blog/tim-quan-cafe-sap-khai-truong#nhan-tin">mẫu tin nhắn cho chủ quán sắp mở</Link>.</li>
      <li><strong>Mỗi tuần:</strong> xem lại bảng để biết tín hiệu và cụm tìm nào hay dẫn tới cuộc nói chuyện thật, rồi bỏ những cụm không ra kết quả.</li>
    </ol>

    <h2 id="cong-cu">Khi nào nên dùng công cụ</h2>
    <p>Tự làm là đủ khi bạn theo dõi ít khu vực và ít loại cơ sở. Một công cụ theo dõi đáng cân nhắc khi bạn cần chạy lại cùng các cụm tìm kiếm cho nhiều khu vực mỗi ngày, hoặc hay bỏ lỡ bài vì không kịp xem.</p>
    <p>Khi chọn công cụ, hãy hỏi: công cụ này <strong>tìm và lọc</strong> bài đăng, hay <strong>đăng bài và nhắn tin hàng loạt</strong>? Loại thứ hai dễ khiến tài khoản bị hạn chế và làm phiền người nhận.</p>
    <p>QLead thuộc loại tìm và lọc. Bạn mô tả nhu cầu bằng một câu; QLead tìm trong bài đăng và Reels công khai mà công cụ tìm kiếm của Facebook trả về, theo loại cơ sở và sáu tín hiệu ở trên, kiểm tra lại theo lịch (mặc định khoảng 30 phút một lần), đưa bài mới và sát nhu cầu lên trước, và có thể báo khi có lead mới. QLead không nhắn tin thay bạn, không đọc được mọi bài hay mọi nhóm, có thể bắt nhầm như các ví dụ ở trên, và không bảo đảm người đăng sẽ mua.</p>
    <TryQLead slug={slug} position="cong-cu" title="Thử mô tả khách hàng của bạn" request="Tôi bán thiết bị và thi công quán, muốn tìm quán ăn, nhà hàng sắp khai trương hoặc mới thuê mặt bằng ở miền Nam." hint="Viết theo công thức: bạn bán gì, cho loại cơ sở nào, ở giai đoạn nào, ở đâu."/>
  </>;
}
