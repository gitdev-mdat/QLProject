/**
 * Landing "Thử tìm khách hàng" search: picks at most two real, stored posts that fit a visitor's own words.
 *
 * Pure and deterministic (no I/O), so the API, the unit tests and the report all use the same rules:
 *
 * - The visitor's text is read with the same planner the product uses for saved searches (planFromDescription):
 *   business types, stage signals (sắp khai trương, tuyển người, mở chi nhánh…) and any place the visitor named.
 * - Each candidate post is read the same way. A post qualifies only when it shares what the visitor asked for:
 *   the business type when one was named, otherwise the signal; a named place must match the post's place.
 * - Only posts with Vietnamese text QLead can show qualify (a Vietnamese summary or Vietnamese post text), only
 *   recent ones (30 days), and near-duplicates of the same business are collapsed. Fewer than two good matches
 *   means fewer than two results: nothing is padded.
 * - The public preview carries the Facebook post link (the owner chose to let visitors open it) but never the
 *   poster's name or contact details: phone numbers, emails and other links in the excerpt are masked on the server.
 */
import { planFromDescription } from '../../src/search-plan';
import { isSupportedFacebookPostUrl } from '../../src/lead-eligibility';
import { looksEnglish } from './lead-text';

export const LANDING_MAX_RESULTS = 2;
export const LANDING_QUERY_MAX = 300;
export const LANDING_QUERY_MIN = 4;
/** Posts older than this are not shown: an old opening is no longer a sales opportunity. */
export const LANDING_MAX_AGE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const EXCERPT_MAX = 180;

export type LandingCandidate = {
  id: string;
  normalized_url: string;
  /** The Facebook permalink as collected; shown publicly only when it is a recognised post URL. */
  original_url?: string | null;
  title: string | null;
  content: string | null;
  summary_vi: string | null;
  published_at: string | null;
  discovered_at: string | null;
};

/** What the browser receives for an anonymous visitor. No URL, author, contact, or internal id. */
export type LandingPreviewLead = {
  /** Position in this preview (1 or 2); the unlock endpoint maps it back to the stored post. */
  key: string;
  signals: string[];
  excerpt: string;
  /** True when the text shown is QLead's Vietnamese summary rather than the poster's own words. */
  summarized: boolean;
  area: string | null;
  /** Real publication time from Facebook; null when QLead does not know it (never replaced by discovery time). */
  publishedAt: string | null;
  source: string;
  hasContact: boolean;
  /** Link to the Facebook post (open to everyone); null when QLead has no valid post URL. */
  url: string | null;
  /** Why this post was picked, in the visitor's terms ("Quán cà phê · sắp khai trương · TP.HCM"). */
  match: string;
};

export type LandingMatch = { candidate: LandingCandidate; score: number; preview: LandingPreviewLead };

// ---------------------------------------------------------------------------------------------------------------
// Text helpers

const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const clean = (value: string) => value.normalize('NFC').replace(/\s+/g, ' ').trim();

/** Normalises a visitor query for caching: same words, same case and spacing → same key. */
export function normalizeLandingQuery(value: string): string {
  return clean(value).toLocaleLowerCase('vi').slice(0, LANDING_QUERY_MAX);
}

const PHONE = /(?:\+?84|0)(?:[\s.\-()]*\d){8,10}/g;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|vn|net|me|ly|link)(?:\/\S*)?/gi;
const ZALO_HANDLE = /(?:zalo|sđt|sdt|hotline|liên hệ|lh|inbox|ib)\s*[:：-]?\s*(?=\S*\d)\S+/giu;

/** Removes contact details from public text. Masked rather than deleted, so the sentence still reads naturally. */
export function maskContacts(text: string): string {
  return text.replace(EMAIL, '[email ẩn]').replace(LINK, '[liên kết ẩn]').replace(PHONE, 'SĐT ẩn')
    .replace(ZALO_HANDLE, match => (/ẩn/.test(match) ? match : `${match.split(/[:：\s-]/)[0]} [ẩn]`));
}

export function hasContactDetails(text: string): boolean {
  PHONE.lastIndex = 0; EMAIL.lastIndex = 0;
  const found = PHONE.test(text) || EMAIL.test(text);
  PHONE.lastIndex = 0; EMAIL.lastIndex = 0;
  return found;
}

function clip(text: string, max = EXCERPT_MAX): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The Vietnamese text QLead can show for a post: its Vietnamese summary first, else the post text when it is
 * Vietnamese. English collector descriptions are never shown on the landing page (same rule as lead-text.ts).
 */
export function displayableText(post: Pick<LandingCandidate, 'summary_vi' | 'content' | 'title'>): { text: string; summarized: boolean } | null {
  const summary = post.summary_vi?.trim();
  if (summary) return { text: clean(summary), summarized: true };
  const content = post.content?.trim();
  if (content && isVietnamese(content)) return { text: clean(content), summarized: false };
  return null;
}

const VIETNAMESE_LETTER = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/iu;
const ENGLISH_HINT = /\b(?:on|at|in|the|of|for|and|with|from|is|are|its|their|opening|announces?|grand|post|shop|serving|located)\b/gi;

/**
 * Stricter than lead-text's interim gate: most words must look Vietnamese (carry Vietnamese letters) and English
 * function words must be rare, so a mostly-English collector note with one Vietnamese shop name is not shown.
 */
export function isVietnamese(text: string): boolean {
  if (looksEnglish(text)) return false;
  const list = text.match(/[\p{L}]+/gu) ?? [];
  if (list.length < 4) return false;
  const marked = list.filter(word => VIETNAMESE_LETTER.test(word)).length;
  const english = text.match(ENGLISH_HINT)?.length ?? 0;
  return marked / list.length >= 0.25 && english / list.length < 0.12;
}

// ---------------------------------------------------------------------------------------------------------------
// Places: a wider list than the saved-search planner, because here a place the visitor named must be checked
// against the post. Old province names are kept since posts still use them.

type Region = 'Miền Bắc' | 'Miền Trung' | 'Miền Nam';
const PLACES: Array<{ label: string; region: Region; names: string[] }> = [
  { label: 'TP.HCM', region: 'Miền Nam', names: ['tp hcm', 'tphcm', 'tp.hcm', 'hcm', 'ho chi minh', 'sai gon', 'saigon', 'thu duc', 'go vap', 'binh thanh', 'tan binh', 'phu nhuan', 'quan 1', 'quan 3', 'quan 7', 'binh tan', 'tan phu'] },
  { label: 'Hà Nội', region: 'Miền Bắc', names: ['ha noi', 'hanoi', 'cau giay', 'dong da', 'hoan kiem', 'thanh xuan', 'long bien', 'ha dong'] },
  { label: 'Đà Nẵng', region: 'Miền Trung', names: ['da nang'] },
  { label: 'Hải Phòng', region: 'Miền Bắc', names: ['hai phong'] },
  { label: 'Cần Thơ', region: 'Miền Nam', names: ['can tho'] },
  { label: 'Bình Dương', region: 'Miền Nam', names: ['binh duong', 'thu dau mot', 'di an', 'thuan an'] },
  { label: 'Đồng Nai', region: 'Miền Nam', names: ['dong nai', 'bien hoa', 'dinh quan', 'long khanh'] },
  { label: 'Bà Rịa - Vũng Tàu', region: 'Miền Nam', names: ['vung tau', 'ba ria'] },
  { label: 'Long An', region: 'Miền Nam', names: ['long an'] },
  { label: 'Tây Ninh', region: 'Miền Nam', names: ['tay ninh'] },
  { label: 'Tiền Giang', region: 'Miền Nam', names: ['tien giang', 'my tho'] },
  { label: 'An Giang', region: 'Miền Nam', names: ['an giang', 'long xuyen', 'chau doc'] },
  { label: 'Kiên Giang', region: 'Miền Nam', names: ['kien giang', 'rach gia', 'phu quoc', 'ha tien'] },
  { label: 'Vĩnh Long', region: 'Miền Nam', names: ['vinh long', 'ben tre', 'tra vinh'] },
  { label: 'Cà Mau', region: 'Miền Nam', names: ['ca mau', 'bac lieu'] },
  { label: 'Sóc Trăng', region: 'Miền Nam', names: ['soc trang', 'hau giang'] },
  { label: 'Đồng Tháp', region: 'Miền Nam', names: ['dong thap', 'cao lanh', 'sa dec'] },
  { label: 'Bình Phước', region: 'Miền Nam', names: ['binh phuoc', 'dong xoai'] },
  { label: 'Lâm Đồng', region: 'Miền Nam', names: ['lam dong', 'da lat', 'bao loc'] },
  { label: 'Khánh Hòa', region: 'Miền Trung', names: ['khanh hoa', 'nha trang', 'cam ranh'] },
  { label: 'Huế', region: 'Miền Trung', names: ['hue', 'thua thien'] },
  { label: 'Quảng Nam', region: 'Miền Trung', names: ['quang nam', 'hoi an', 'tam ky'] },
  { label: 'Quảng Ngãi', region: 'Miền Trung', names: ['quang ngai', 'kon tum'] },
  { label: 'Bình Định', region: 'Miền Trung', names: ['binh dinh', 'quy nhon'] },
  { label: 'Phú Yên', region: 'Miền Trung', names: ['phu yen', 'tuy hoa'] },
  { label: 'Gia Lai', region: 'Miền Trung', names: ['gia lai', 'pleiku'] },
  { label: 'Đắk Lắk', region: 'Miền Trung', names: ['dak lak', 'dac lac', 'buon ma thuot', 'buon me thuot'] },
  { label: 'Nghệ An', region: 'Miền Trung', names: ['nghe an', 'vinh city', 'tp vinh'] },
  { label: 'Thanh Hóa', region: 'Miền Trung', names: ['thanh hoa'] },
  { label: 'Hà Tĩnh', region: 'Miền Trung', names: ['ha tinh'] },
  { label: 'Quảng Bình', region: 'Miền Trung', names: ['quang binh', 'dong hoi', 'quang tri'] },
  { label: 'Ninh Thuận', region: 'Miền Trung', names: ['ninh thuan', 'phan rang', 'binh thuan', 'phan thiet', 'mui ne'] },
  { label: 'Quảng Ninh', region: 'Miền Bắc', names: ['quang ninh', 'ha long', 'cam pha', 'mong cai'] },
  { label: 'Bắc Ninh', region: 'Miền Bắc', names: ['bac ninh', 'bac giang'] },
  { label: 'Hưng Yên', region: 'Miền Bắc', names: ['hung yen', 'thai binh'] },
  { label: 'Hải Dương', region: 'Miền Bắc', names: ['hai duong'] },
  { label: 'Ninh Bình', region: 'Miền Bắc', names: ['ninh binh', 'nam dinh', 'ha nam'] },
  { label: 'Thái Nguyên', region: 'Miền Bắc', names: ['thai nguyen', 'bac kan'] },
  { label: 'Phú Thọ', region: 'Miền Bắc', names: ['phu tho', 'viet tri', 'vinh phuc', 'hoa binh'] },
  { label: 'Lào Cai', region: 'Miền Bắc', names: ['lao cai', 'sa pa', 'sapa', 'yen bai'] },
  { label: 'Lạng Sơn', region: 'Miền Bắc', names: ['lang son'] },
];
const REGIONS: Array<{ label: Region; names: string[] }> = [
  { label: 'Miền Nam', names: ['mien nam', 'nam bo', 'mien tay', 'dong nam bo'] },
  { label: 'Miền Bắc', names: ['mien bac', 'bac bo'] },
  { label: 'Miền Trung', names: ['mien trung', 'trung bo', 'tay nguyen'] },
];

const containsName = (folded: string, name: string) => new RegExp(`(?<![a-z0-9])${name.replace(/[.]/g, '\\.?').replace(/ /g, '[\\s.]*')}(?![a-z0-9])`).test(folded);

export type Places = { places: string[]; regions: Region[] };

export function findPlaces(text: string): Places {
  const folded = fold(text);
  const places = PLACES.filter(place => place.names.some(name => containsName(folded, name)));
  const regions = REGIONS.filter(region => region.names.some(name => containsName(folded, name))).map(region => region.label);
  return { places: places.map(place => place.label), regions };
}

const regionOf = (label: string) => PLACES.find(place => place.label === label)?.region ?? null;

/** True when the post is somewhere the visitor asked for. A named place needs a known, matching post place. */
function placeMatches(wanted: Places, post: Places): { ok: boolean; label: string | null } {
  if (!wanted.places.length && !wanted.regions.length) return { ok: true, label: null };
  const exact = post.places.find(place => wanted.places.includes(place));
  if (exact) return { ok: true, label: exact };
  if (wanted.regions.length) {
    const inRegion = post.places.find(place => wanted.regions.includes(regionOf(place)!));
    if (inRegion) return { ok: true, label: inRegion };
    const sameRegion = post.regions.find(region => wanted.regions.includes(region));
    if (sameRegion) return { ok: true, label: sameRegion };
  }
  return { ok: false, label: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Intent

const FNB_TYPES = new Set(['cafe', 'milk_tea', 'restaurant', 'food_shop', 'dessert_shop', 'bakery', 'bar', 'food_and_beverage']);
const CATEGORY_LABELS: Record<string, string> = {
  food_and_beverage: 'Quán F&B', cafe: 'Quán cà phê', milk_tea: 'Quán trà sữa', restaurant: 'Nhà hàng', food_shop: 'Quán ăn',
  dessert_shop: 'Quán chè', bakery: 'Tiệm bánh', bar: 'Quán nhậu, bar', hotel: 'Khách sạn', homestay: 'Homestay', spa: 'Spa',
  salon: 'Salon tóc, nail', gym: 'Phòng gym', pharmacy: 'Nhà thuốc', clinic: 'Phòng khám', grocery: 'Tạp hóa',
  fashion: 'Shop thời trang', education: 'Trung tâm đào tạo', karaoke: 'Karaoke', store: 'Cửa hàng',
};
/** Signal labels shown as chips. Worded as business events the post mentions, never as a purchase. */
export const SIGNAL_LABELS: Record<string, string> = {
  opening_soon: 'Sắp khai trương', new_premises: 'Mới thuê mặt bằng', recently_opened: 'Mới khai trương',
  recruiting: 'Đang tuyển người', new_branch: 'Mở chi nhánh', transfer: 'Sang nhượng',
};
/** Signals that mean nearly the same thing to a seller of opening equipment or software. */
const RELATED_SIGNALS: Record<string, string[]> = {
  opening_soon: ['opening_soon', 'new_premises', 'recently_opened'],
  recently_opened: ['recently_opened', 'opening_soon'],
  new_premises: ['new_premises', 'opening_soon'],
  new_branch: ['new_branch'], recruiting: ['recruiting'], transfer: ['transfer'],
};
/** Wording the saved-search planner does not catalogue but visitors and posts use for the same events. */
const EXTRA_SIGNALS: Array<[RegExp, string]> = [
  [/(?:sắp|chuẩn bị|dự kiến)\s+(?:đi vào|bước vào)\s+hoạt động|sắp mở bán|chuẩn bị mở bán|coming soon|sắp ra mắt|khai trương\s+(?:vào\s+)?(?:ngày\s+)?\d{1,2}\s*[/.-]\s*\d{1,2}|khai trương ngày/iu, 'opening_soon'],
  [/mừng khai trương|grand opening|chào mừng khai trương|vừa khai trương|mới khai trương/iu, 'recently_opened'],
  [/mở\s+(?:thêm\s+)?cơ sở|cơ sở\s+(?:mới|thứ\s+\d+|thứ\s+\p{L}+)|mở\s+thêm\s+(?:cửa hàng|tiệm|quán|điểm)/iu, 'new_branch'],
];
const EXTRA_CATEGORIES: Array<[RegExp, string]> = [
  [/mỹ phẩm|my pham|cosmetic/iu, 'fashion'],
];

function signalsOf(text: string, planned: string[]): string[] {
  const extra = EXTRA_SIGNALS.filter(([pattern]) => pattern.test(text)).map(([, id]) => id);
  return [...new Set([...planned, ...extra])];
}
function categoriesOf(text: string, planned: string[]): string[] {
  const extra = EXTRA_CATEGORIES.filter(([pattern]) => pattern.test(text)).map(([, id]) => id);
  return [...new Set([...planned, ...extra])];
}

/**
 * Words that describe the seller, not the customer ("Tôi bán phần mềm quản lý quán cafe, muốn tìm…"): the part
 * after "tìm" names the customer, so the planner reads that part first.
 */
function customerPart(query: string): string {
  const match = /(?:muốn|cần|đang)?\s*tìm(?:\s+kiếm)?\s+(?:khách\s+hàng\s+(?:là\s+)?)?(.{6,})/iu.exec(query);
  return match?.[1] ?? query;
}

export type LandingIntent = {
  categories: string[];
  signals: string[];
  places: Places;
  /** Two-word phrases from the visitor's text, for the fallback when no business type or signal is recognised. */
  phrases: string[];
  recognized: boolean;
};

const STOP_WORDS = new Set(['tôi', 'mình', 'em', 'bán', 'muốn', 'tìm', 'kiếm', 'khách', 'hàng', 'các', 'những', 'đang', 'cần', 'cho', 'với', 'tại', 'ở', 'một', 'hoặc', 'và', 'là', 'để', 'có', 'người', 'sắp', 'mới', 'khu', 'vực', 'của', 'những', 'nào', 'được', 'chúng', 'ta']);
const words = (text: string) => (clean(text).toLocaleLowerCase('vi').match(/[\p{L}\p{N}]+/gu) ?? []);

export function landingIntent(query: string): LandingIntent {
  const target = customerPart(query);
  const plan = planFromDescription(target);
  // "Tôi bán phần mềm quản lý quán cafe, muốn tìm các quán sắp khai trương": the customer's type is only named in the
  // seller part, so the whole text fills in whatever the customer part leaves out.
  const whole = target === query ? plan : planFromDescription(query);
  const targetCategories = categoriesOf(target, plan.categories);
  const categories = targetCategories.length ? targetCategories : categoriesOf(query, whole.categories);
  const targetSignals = signalsOf(target, plan.signals);
  const signals = targetSignals.length ? targetSignals : signalsOf(query, whole.signals);
  const list = words(target);
  const phrases: string[] = [];
  for (let index = 0; index < list.length - 1; index += 1) {
    const [a, b] = [list[index]!, list[index + 1]!];
    if (STOP_WORDS.has(a) || STOP_WORDS.has(b) || a.length + b.length < 5) continue;
    phrases.push(`${a} ${b}`);
  }
  return { categories, signals, places: findPlaces(query), phrases: [...new Set(phrases)].slice(0, 8), recognized: categories.length > 0 || signals.length > 0 };
}

function categoryOverlap(wanted: string[], post: string[]): string | null {
  if (!wanted.length) return null;
  const direct = post.find(category => wanted.includes(category) && category !== 'store');
  if (direct) return direct;
  // "Quán F&B" covers every food-and-drink type, in both directions.
  if (wanted.includes('food_and_beverage')) return post.find(category => FNB_TYPES.has(category)) ?? null;
  if (post.includes('food_and_beverage') && wanted.some(category => FNB_TYPES.has(category))) return wanted.find(category => FNB_TYPES.has(category)) ?? null;
  if (wanted.includes('store') && post.includes('store')) return 'store';
  return null;
}

function signalOverlap(wanted: string[], post: string[]): string[] {
  const accepted = new Set(wanted.flatMap(signal => RELATED_SIGNALS[signal] ?? [signal]));
  return post.filter(signal => accepted.has(signal));
}

function freshness(publishedAt: string | null, discoveredAt: string | null, now: number): number | null {
  const published = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  if (Number.isFinite(published)) {
    const age = now - published;
    if (age < -DAY) return null;
    if (age > LANDING_MAX_AGE_DAYS * DAY) return null;
    if (age <= DAY) return 30;
    if (age <= 3 * DAY) return 24;
    if (age <= 7 * DAY) return 16;
    return 6;
  }
  // Unknown publish time: only recently found posts, ranked below dated ones.
  const discovered = discoveredAt ? Date.parse(discoveredAt) : Number.NaN;
  return Number.isFinite(discovered) && now - discovered >= 0 && now - discovered <= 7 * DAY ? 2 : null;
}

function sourceOf(url: string): string {
  if (/\/reel\/|\/share\/r\//i.test(url)) return 'Reels Facebook';
  if (/\/groups\//i.test(url)) return 'Nhóm Facebook';
  if (/\/videos\/|fb\.watch|\/watch/i.test(url)) return 'Video Facebook';
  return 'Bài đăng Facebook';
}

/** Three-word sequences: shared ones point at the same specific text, not merely the same kind of business. */
function tokens(text: string): Set<string> {
  const list = fold(text).match(/[a-z0-9]+/g) ?? [];
  const grams = new Set<string>();
  for (let index = 0; index + 2 < list.length; index += 1) grams.add(`${list[index]} ${list[index + 1]} ${list[index + 2]}`);
  return grams;
}

/** Two copies of the same post or announcement share most of their word sequences. */
function similar(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / Math.min(a.size, b.size) >= 0.6;
}

/** Everything the ranking needs from a post, computed once per candidate pool instead of once per query. */
export type AnalyzedCandidate = {
  candidate: LandingCandidate;
  shown: { text: string; summarized: boolean };
  categories: string[];
  signals: string[];
  places: Places;
  lowered: string;
  tokens: Set<string>;
  hasContact: boolean;
  source: string;
};

export function analyzeCandidates(candidates: LandingCandidate[]): AnalyzedCandidate[] {
  const analyzed: AnalyzedCandidate[] = [];
  for (const candidate of candidates) {
    const shown = displayableText(candidate);
    if (!shown) continue;
    const allText = [candidate.summary_vi, candidate.title, candidate.content].filter(Boolean).join(' . ');
    const plan = planFromDescription(allText);
    analyzed.push({
      candidate, shown,
      categories: categoriesOf(allText, plan.categories),
      signals: signalsOf(allText, plan.signals),
      places: findPlaces(allText),
      lowered: ` ${words(allText).join(' ')} `,
      tokens: tokens(shown.text),
      hasContact: hasContactDetails(`${candidate.content ?? ''} ${candidate.summary_vi ?? ''}`),
      source: sourceOf(candidate.normalized_url),
    });
  }
  return analyzed;
}

/**
 * Ranks candidates for one visitor query. Returns at most LANDING_MAX_RESULTS matches, best first, and only
 * matches that clear the relevance rules; an empty array is an honest "nothing fits yet".
 */
export function rankLandingCandidates(query: string, pool: AnalyzedCandidate[] | LandingCandidate[], now = Date.now()): LandingMatch[] {
  const analyzed = (pool.length && !('shown' in pool[0]!)) ? analyzeCandidates(pool as LandingCandidate[]) : pool as AnalyzedCandidate[];
  const intent = landingIntent(query);
  if (!intent.recognized && !intent.phrases.length) return [];
  const scored: Array<{ item: AnalyzedCandidate; score: number; preview: LandingPreviewLead }> = [];
  for (const item of analyzed) {
    const { candidate } = item;
    const fresh = freshness(candidate.published_at, candidate.discovered_at, now);
    if (fresh === null) continue;
    const category = categoryOverlap(intent.categories, item.categories);
    const signals = signalOverlap(intent.signals, item.signals);
    const wantsCategory = intent.categories.length > 0;
    const wantsSignal = intent.signals.length > 0;
    if (wantsCategory && !category) continue;
    if (!wantsCategory && wantsSignal && !signals.length) continue;
    let phraseHits = 0;
    if (!intent.recognized) {
      phraseHits = intent.phrases.filter(phrase => item.lowered.includes(` ${phrase} `)).length;
      if (phraseHits < Math.min(2, intent.phrases.length)) continue;
    }
    const place = placeMatches(intent.places, item.places);
    if (!place.ok) continue;

    // A business-type match without the asked-for stage signal is weak evidence of an opportunity: keep it, but below.
    const anySignal = item.signals.length > 0;
    const score = (category ? 30 : 0) + (signals.length ? 25 : wantsSignal ? -10 : anySignal ? 10 : 0) + (place.label ? 12 : 0)
      + fresh + phraseHits * 15 + (candidate.summary_vi ? 3 : 0) + (item.hasContact ? 2 : 0)
      // The exact event asked for beats a related one, and a post showing several of the asked-for events beats one.
      + Math.min(12, signals.filter(signal => intent.signals.includes(signal)).length * 6);
    if (score < 25) continue;

    const chipIds = (signals.length ? signals : item.signals).slice(0, 2);
    const matchParts = [category ? CATEGORY_LABELS[category] ?? null : null, signals[0] ? SIGNAL_LABELS[signals[0]]!.toLocaleLowerCase('vi') : null, place.label].filter(Boolean);
    scored.push({
      item, score,
      preview: {
        key: '', signals: chipIds.map(id => SIGNAL_LABELS[id]).filter((label): label is string => Boolean(label)),
        excerpt: clip(maskContacts(item.shown.text)), summarized: item.shown.summarized, area: place.label ?? item.places.places[0] ?? null,
        publishedAt: candidate.published_at && Number.isFinite(Date.parse(candidate.published_at)) ? new Date(candidate.published_at).toISOString() : null,
        source: item.source, hasContact: item.hasContact,
        url: isSupportedFacebookPostUrl(candidate.original_url) ? candidate.original_url! : null,
        match: matchParts.length ? matchParts.join(' · ') : 'Có cụm từ trong mô tả của bạn',
      },
    });
  }
  scored.sort((a, b) => b.score - a.score
    || (Date.parse(b.item.candidate.published_at ?? '') || 0) - (Date.parse(a.item.candidate.published_at ?? '') || 0)
    || a.item.candidate.id.localeCompare(b.item.candidate.id));
  const picked: typeof scored = [];
  const urls = new Set<string>();
  for (const match of scored) {
    if (urls.has(match.item.candidate.normalized_url)) continue;
    if (picked.some(other => similar(other.item.tokens, match.item.tokens))) continue;
    urls.add(match.item.candidate.normalized_url);
    picked.push(match);
    if (picked.length === LANDING_MAX_RESULTS) break;
  }
  return picked.map(({ item, score, preview }, index) => ({ candidate: item.candidate, score, preview: { ...preview, key: String(index + 1) } }));
}
