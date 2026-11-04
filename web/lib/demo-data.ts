/**
 * Sample content for the public demo and the signed-in preview.
 * Every record here is fictional. Phone numbers use the reserved-looking 0900 000 xxx range
 * and no record carries a Facebook URL, so nothing can be mistaken for a real lead.
 * Replace with the user-facing API adapter (lib/api/adapter.ts) before launch.
 */
import type { StoredFacebookPost } from '../../src/lead-data';

export type PersonaId = 'pos_fnb' | 'retail' | 'equipment' | 'hospitality';

export type DemoPersona = {
  id: PersonaId;
  label: string;
  seller: string;
  request: string;
  conditions: { industry: string; need: string; area: string };
};

export type DemoLead = {
  id: string;
  persona: PersonaId;
  author: string;
  group: string;
  postedMinutesAgo: number;
  detectedMinutesAgo: number;
  text: string;
};

export const demoPersonas: DemoPersona[] = [
  {
    id: 'pos_fnb',
    label: 'Phần mềm quản lý quán',
    seller: 'Bạn bán phần mềm, POS cho quán ăn uống',
    request: 'Quán cafe, trà sữa, nhà hàng sắp khai trương, đang tuyển người hoặc mở chi nhánh',
    conditions: { industry: 'Quán cafe, trà sữa, nhà hàng', need: 'Sắp khai trương, tuyển nhân sự, mở chi nhánh', area: 'TP.HCM và lân cận' },
  },
  {
    id: 'retail',
    label: 'Phần mềm bán lẻ',
    seller: 'Bạn bán phần mềm quản lý bán hàng',
    request: 'Shop thời trang, mỹ phẩm sắp mở bán hoặc mở thêm chi nhánh',
    conditions: { industry: 'Shop thời trang, mỹ phẩm, bán lẻ', need: 'Sắp mở bán, mở chi nhánh, thuê mặt bằng', area: 'Toàn quốc' },
  },
  {
    id: 'equipment',
    label: 'Thiết bị & thi công quán',
    seller: 'Bạn bán thiết bị hoặc thi công nội thất',
    request: 'Quán ăn uống mới thuê mặt bằng hoặc sắp khai trương ở miền Nam',
    conditions: { industry: 'Quán ăn uống mới mở', need: 'Thuê mặt bằng, sắp khai trương, tìm thi công', area: 'Miền Nam' },
  },
  {
    id: 'hospitality',
    label: 'Phần mềm khách sạn',
    seller: 'Bạn bán phần mềm hoặc dịch vụ cho cơ sở lưu trú',
    request: 'Khách sạn, homestay sắp đi vào hoạt động hoặc mở thêm cơ sở',
    conditions: { industry: 'Khách sạn, homestay', need: 'Sắp hoạt động, tuyển nhân sự, mở cơ sở mới', area: 'Toàn quốc' },
  },
];

/** A mix on purpose: some posts state a need, most only mention a business event (opening, hiring, a new branch). */
export const demoLeads: DemoLead[] = [
  { id: 'd1', persona: 'pos_fnb', author: 'Minh Thư', group: 'Việc làm F&B Sài Gòn', postedMinutesAgo: 22, detectedMinutesAgo: 9,
    text: 'Quán cafe Mây chuẩn bị khai trương ở TP.HCM, ngay trung tâm Quận 3. Đang tuyển 4 bạn phục vụ và 2 bạn pha chế, ưu tiên có kinh nghiệm. Liên hệ 0900 000 128.' },
  { id: 'd2', persona: 'pos_fnb', author: 'Quốc Bảo', group: 'Hội chủ quán cafe Sài Gòn', postedMinutesAgo: 75, detectedMinutesAgo: 41,
    text: 'Quán mình đang cần tìm phần mềm tính tiền, có in bill và báo cáo doanh thu theo ca. Quán ở Bình Thạnh, mọi người tư vấn giúp với.' },
  { id: 'd3', persona: 'pos_fnb', author: 'Hoàng Yến', group: 'Cộng đồng chủ quán trà sữa', postedMinutesAgo: 190, detectedMinutesAgo: 160,
    text: 'Chuỗi trà sữa Lá chuẩn bị mở chi nhánh thứ ba tại Bình Dương vào đầu tháng sau. Cảm ơn mọi người đã ủng hộ hai cửa hàng đầu tiên!' },
  { id: 'd4', persona: 'retail', author: 'Thanh Hà', group: 'Hội chủ shop thời trang', postedMinutesAgo: 35, detectedMinutesAgo: 12,
    text: 'Shop mình chuẩn bị mở thêm chi nhánh thứ 2 ở Hà Nội. Đang cần tìm phần mềm quản lý bán hàng đồng bộ tồn kho giữa 2 cửa hàng và bán online. SĐT 0900 000 517.' },
  { id: 'd5', persona: 'retail', author: 'Ngọc Trâm', group: 'Việc làm bán lẻ miền Bắc', postedMinutesAgo: 120, detectedMinutesAgo: 95,
    text: 'Cửa hàng mỹ phẩm Hạ sắp khai trương tại Hải Phòng, đang tuyển 3 nhân viên bán hàng làm ca xoay.' },
  { id: 'd6', persona: 'retail', author: 'Đức Anh', group: 'Chợ sỉ thời trang online', postedMinutesAgo: 300, detectedMinutesAgo: 240,
    text: 'Shop giày Nhịp vừa thuê xong mặt bằng ở Thủ Đức, dự kiến mở cửa cuối tháng. Bạn nào muốn hợp tác ký gửi thì nhắn mình nhé.' },
  { id: 'd7', persona: 'equipment', author: 'Phương Linh', group: 'Hội chủ quán cafe Sài Gòn', postedMinutesAgo: 48, detectedMinutesAgo: 20,
    text: 'Vừa thuê xong mặt bằng 60m2 ở Bình Thạnh để mở quán cafe. Đang cần tìm đơn vị thi công nội thất phong cách tối giản và báo giá máy pha. Liên hệ 0900 000 764.' },
  { id: 'd8', persona: 'equipment', author: 'Tuấn Kiệt', group: 'Việc làm F&B miền Nam', postedMinutesAgo: 140, detectedMinutesAgo: 110,
    text: 'Quán ăn sáng Bếp Nhà chuẩn bị khai trương ở Bình Dương, đang tuyển phụ bếp và nhân viên chạy bàn.' },
  { id: 'd9', persona: 'equipment', author: 'Khánh Vy', group: 'Nhóm sang nhượng & mở quán ăn', postedMinutesAgo: 420, detectedMinutesAgo: 380,
    text: 'Có ai biết bên nào làm bảng hiệu và thi công quầy bar cho quán trà sữa không ạ? Quán mình sắp khai trương ở Long An.' },
  { id: 'd10', persona: 'hospitality', author: 'Thu Hằng', group: 'Việc làm khách sạn – nhà hàng', postedMinutesAgo: 30, detectedMinutesAgo: 14,
    text: 'Khách sạn mới ở Quảng Ninh chuẩn bị đi vào hoạt động, cần tuyển lễ tân và nhân viên buồng phòng. Ứng viên gọi 0900 000 381.' },
  { id: 'd11', persona: 'hospitality', author: 'Bảo Long', group: 'Cộng đồng chủ homestay', postedMinutesAgo: 95, detectedMinutesAgo: 70,
    text: 'Homestay 12 phòng của mình sắp mở ở Hà Nội. Đang cần tìm phần mềm quản lý đặt phòng kết nối được với các trang đặt phòng online. Liên hệ 0900 000 905.' },
  { id: 'd12', persona: 'hospitality', author: 'Mai Phương', group: 'Việc làm khách sạn – nhà hàng', postedMinutesAgo: 260, detectedMinutesAgo: 230,
    text: 'Chuỗi khách sạn Sen mở thêm chi nhánh tại TP.HCM, đang tuyển quản lý ca và lễ tân.' },
];

export function demoLeadsFor(persona: PersonaId): DemoLead[] {
  return demoLeads.filter(lead => lead.persona === persona);
}

/** Converts a demo lead to the same stored-post shape the bridge returns, with times relative to `now`. */
export function demoLeadToStoredPost(lead: DemoLead, now: number): StoredFacebookPost {
  const persona = demoPersonas.find(item => item.id === lead.persona);
  return {
    id: lead.id,
    author: lead.author,
    title: null,
    content: lead.text,
    // Record d6 deliberately has no publish time, so the preview shows how missing data is handled.
    published_at: lead.id === 'd6' ? null : new Date(now - lead.postedMinutesAgo * 60_000).toISOString(),
    discovered_at: new Date(now - lead.detectedMinutesAgo * 60_000).toISOString(),
    original_url: null,
    source_type: lead.group,
    collected_via: 'qlead_demo',
    platform: 'facebook',
    agent_name: 'QLead (mẫu)',
    search_configurations: persona ? [{
      version: 1, enabled: true, keywords: [persona.request], location: persona.conditions.area,
      sources: ['social.search'], frequency_minutes: 30,
    }] : [],
  };
}

/** Matches a typed request to the closest demo persona; null when the demo has no sample data for it. */
export function personaForRequest(text: string): PersonaId | null {
  const value = text.toLocaleLowerCase('vi');
  if (/khách sạn|homestay|resort|lưu trú|đặt phòng/.test(value)) return 'hospitality';
  if (/thiết bị|nội thất|thi công|bảng hiệu|máy pha|bếp|bàn ghế|mặt bằng/.test(value)) return 'equipment';
  if (/shop|thời trang|mỹ phẩm|bán lẻ|cửa hàng|tạp hóa|giày/.test(value)) return 'retail';
  if (/f\s*&\s*b|cafe|cà phê|trà sữa|nhà hàng|quán ăn|quán|tiệm bánh|ăn uống|pos|tính tiền/.test(value)) return 'pos_fnb';
  return null;
}
