/**
 * Turns a customer's own description ("Các quán F&B sắp khai trương hoặc đang tuyển nhân viên") into the Facebook
 * search phrases a worker runs, a readable profile name and any place the customer explicitly named. Pure and
 * deterministic: the same description always yields the same phrases, so the web form can preview exactly what the
 * server will store. It recognises a fixed catalogue only; anything else falls back to the description's main idea
 * and says so, rather than pretending to understand it.
 *
 * The phrases describe what a post might say (business type + stage signal). They never imply that the author asked
 * for the customer's product: that interpretation stays with the salesperson reading the post.
 */

// Vietnamese letters with diacritics are not \w, so `\b` misses "Đà Nẵng". Match on Unicode letter boundaries instead.
const word = (source: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, 'iu');

type Category = { id: string; label: string; phrases: string[]; pattern: RegExp };
type Signal = { id: string; label: string; pattern: RegExp };

/** Broad F&B wording gets a bounded spread of representative subtypes; the worker can still interpret it semantically. */
const FNB_GENERIC = word('f\\s*&\\s*b|fnb|ẩm thực|am thuc|ăn uống|an uong|hàng quán|hang quan');
const FNB_PHRASES = ['quán ăn uống', 'quán cà phê', 'quán chè', 'quán trà sữa', 'tiệm bánh', 'quán nước ép'];

const CATEGORIES: Category[] = [
  { id: 'cafe', label: 'Quán cà phê', phrases: ['quán cà phê'], pattern: word('cà phê|ca phe|cafe|café|coffee') },
  { id: 'milk_tea', label: 'Quán trà sữa', phrases: ['quán trà sữa'], pattern: word('trà sữa|tra sua|milk tea') },
  { id: 'restaurant', label: 'Nhà hàng', phrases: ['nhà hàng'], pattern: word('nhà hàng|nha hang|restaurant') },
  { id: 'food_shop', label: 'Quán ăn', phrases: ['quán ăn'], pattern: word('quán ăn(?!\\s+uống)|quan an|quán bún|quán phở|quán cơm|tiệm ăn') },
  { id: 'dessert_shop', label: 'Quán chè, tráng miệng', phrases: ['quán chè', 'tiệm tráng miệng'], pattern: word('chè|tráng miệng|trang mieng|dessert|sweet soup') },
  { id: 'bakery', label: 'Tiệm bánh', phrases: ['tiệm bánh'], pattern: word('tiệm bánh|tiem banh|bakery') },
  { id: 'bar', label: 'Quán nhậu, bar', phrases: ['quán nhậu', 'quán bar'], pattern: word('quán nhậu|quan nhau|bar|pub|beer club') },
  { id: 'hotel', label: 'Khách sạn', phrases: ['khách sạn'], pattern: word('khách sạn|khach san|hotel|nhà nghỉ') },
  { id: 'homestay', label: 'Homestay', phrases: ['homestay'], pattern: word('homestay|home stay|villa du lịch') },
  { id: 'spa', label: 'Spa', phrases: ['spa'], pattern: word('spa|thẩm mỹ viện|tham my vien') },
  { id: 'salon', label: 'Salon tóc, nail', phrases: ['salon tóc', 'tiệm nail'], pattern: word('salon|tiệm tóc|tiem toc|cắt tóc|nail|tiệm móng') },
  { id: 'gym', label: 'Phòng gym', phrases: ['phòng gym'], pattern: word('gym|fitness|phòng tập|yoga') },
  { id: 'pharmacy', label: 'Nhà thuốc', phrases: ['nhà thuốc'], pattern: word('nhà thuốc|nha thuoc|hiệu thuốc|quầy thuốc') },
  { id: 'clinic', label: 'Phòng khám', phrases: ['phòng khám'], pattern: word('phòng khám|phong kham|nha khoa') },
  { id: 'grocery', label: 'Cửa hàng tạp hóa', phrases: ['cửa hàng tạp hóa', 'siêu thị mini'], pattern: word('tạp hóa|tap hoa|minimart|mini mart|siêu thị mini|cửa hàng tiện lợi') },
  { id: 'fashion', label: 'Shop thời trang', phrases: ['shop thời trang'], pattern: word('thời trang|thoi trang|quần áo|quan ao') },
  { id: 'education', label: 'Trung tâm đào tạo', phrases: ['trung tâm tiếng anh', 'trung tâm đào tạo'], pattern: word('trung tâm (?:tiếng anh|ngoại ngữ|đào tạo|giáo dục|dạy)|tiếng anh|ngoại ngữ|lớp học') },
  { id: 'karaoke', label: 'Karaoke', phrases: ['karaoke'], pattern: word('karaoke') },
  { id: 'store', label: 'Cửa hàng', phrases: ['cửa hàng'], pattern: word('cửa hàng|cua hang|shop') },
];

const SIGNALS: Signal[] = [
  { id: 'opening_soon', label: 'sắp khai trương', pattern: word('(?:sắp|sap|chuẩn bị|chuan bi|dự kiến|du kien|sắp sửa)\\s+(?:mở|mo|khai trương|khai truong|open)(?!\\s+(?:thêm|chi nhánh|rộng|cơ sở))(?:\\s+cửa)?|opening soon|soft opening|grand opening') },
  { id: 'new_premises', label: 'mới thuê mặt bằng', pattern: word('(?:mới|vừa|moi|vua)\\s+(?:thuê|thue|nhận|nhan)\\s+mặt bằng|(?:thuê|thue)\\s+mặt bằng\\s+mới|newly leased (?:premises|space)') },
  { id: 'recently_opened', label: 'mới khai trương', pattern: word('(?:mới|moi|vừa|vua)\\s+(?:mở|mo|khai trương|khai truong|open)|recently opened|new opening') },
  { id: 'recruiting', label: 'đang tuyển người', pattern: word('tuyển|tuyen|tìm người|tim nguoi|cần người|can nguoi|hiring') },
  { id: 'new_branch', label: 'mở chi nhánh', pattern: word('chi nhánh|chi nhanh|cơ sở mới|co so moi|mở rộng|mo rong') },
  { id: 'transfer', label: 'sang nhượng', pattern: word('sang nhượng|sang nhuong|sang lại|sang quán|sang tiệm|nhượng lại') },
];

const STAGE_PHRASE: Record<string, string> = {
  opening_soon: 'sắp khai trương',
  new_premises: 'mới thuê mặt bằng',
  recently_opened: 'mới khai trương',
  new_branch: 'mở chi nhánh mới',
  transfer: 'sang nhượng',
};

/** Explicitly named places only. No match means no geographic restriction, never a default region. */
const PLACES: Array<[RegExp, string]> = [
  [word('miền nam|mien nam|nam bộ|southern vietnam'), 'Miền Nam'],
  [word('miền bắc|mien bac|bắc bộ|northern vietnam'), 'Miền Bắc'],
  [word('miền trung|mien trung|central vietnam'), 'Miền Trung'],
  [word('tp\\.?\\s*hcm|hcm|hồ chí minh|ho chi minh|sài gòn|sai gon|saigon'), 'TP.HCM'],
  [word('hà nội|ha noi|hanoi'), 'Hà Nội'],
  [word('đà nẵng|da nang'), 'Đà Nẵng'],
  [word('cần thơ|can tho'), 'Cần Thơ'],
  [word('hải phòng|hai phong'), 'Hải Phòng'],
  [word('bình dương|binh duong'), 'Bình Dương'],
  [word('đồng nai|dong nai|biên hòa'), 'Đồng Nai'],
  [word('đà lạt|da lat|lâm đồng'), 'Đà Lạt'],
  [word('nha trang|khánh hòa'), 'Nha Trang'],
  [word('vũng tàu|vung tau'), 'Vũng Tàu'],
  [word('huế|hue'), 'Huế'],
];

export const MAX_SEARCH_PHRASES = 6;

export type DescriptionPlan = {
  /** Executable search phrases, most specific first. Never empty for a non-empty description. */
  queries: string[];
  /** Places the customer named, joined for display; null when the description sets no geographic limit. */
  location: string | null;
  name: string;
  /** True when at least a business type or a stage signal was recognised. */
  recognized: boolean;
  categories: string[];
  signals: string[];
  /** Customer-facing notes about what QLead could not pin down. */
  notes: string[];
};

const clean = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim();
const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase('vi') + text.slice(1);

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = value.toLocaleLowerCase('vi');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The description's main idea, for wording the catalogue does not cover: drop filler, keep the first clause. */
function mainIdea(text: string): string {
  const first = text.split(/[.;:!?\n]/)[0] ?? text;
  const stripped = first.toLocaleLowerCase('vi')
    .replace(/^(?:tôi|mình|em|chúng tôi)?\s*(?:muốn|cần|đang)?\s*(?:tìm(?: kiếm)?|kiếm)?\s*(?:khách hàng|khách)?\s*(?:là)?\s*/u, '')
    .replace(/^(?:các|những|mấy)\s+/u, '');
  return stripped.split(' ').filter(Boolean).slice(0, 8).join(' ') || clean(first).toLocaleLowerCase('vi');
}

export function planFromDescription(description: string): DescriptionPlan {
  const text = clean(description);
  const fnb = FNB_GENERIC.test(text);
  const matched = CATEGORIES.filter(category => category.pattern.test(text));
  // "cửa hàng" is only a fallback type: "cửa hàng tạp hóa" already says which shop.
  const specific = matched.filter(category => category.id !== 'store');
  const categories = specific.length ? specific : matched;
  const typePhrases = unique([...categories.flatMap(category => category.phrases), ...(fnb ? FNB_PHRASES : [])]).slice(0, MAX_SEARCH_PHRASES);
  const signals = SIGNALS.filter(signal => signal.pattern.test(text));
  const ids = new Set(signals.map(signal => signal.id));
  const places = unique(PLACES.filter(([pattern]) => pattern.test(text)).map(([, label]) => label));
  const notes: string[] = [];

  const queries: string[] = [];
  if (typePhrases.length && signals.length) {
    // One phrase per business type and signal, interleaved so every signal is covered within the budget.
    const recruitingSuffix = ids.has('opening_soon') ? ' sắp khai trương' : ids.has('recently_opened') ? ' mới khai trương' : '';
    for (const type of typePhrases) {
      for (const signal of signals) {
        if (signal.id === 'recruiting') queries.push(`tuyển nhân viên ${type}${recruitingSuffix}`);
        else if (!(signal.id === 'recently_opened' && ids.has('opening_soon') && ids.has('recruiting'))) queries.push(`${type} ${STAGE_PHRASE[signal.id]}`);
      }
    }
  } else if (typePhrases.length) {
    queries.push(...typePhrases);
    notes.push('Mô tả chưa nêu dấu hiệu như sắp khai trương, tuyển người hay mở chi nhánh, nên kết quả có thể rộng.');
  } else if (signals.length) {
    queries.push(...signals.map(signal => signal.id === 'recruiting' ? 'tuyển nhân viên' : STAGE_PHRASE[signal.id]!));
    notes.push('Mô tả chưa nêu loại cửa hàng hay doanh nghiệp, nên kết quả có thể rộng.');
  }
  if (!queries.length && text) {
    queries.push(mainIdea(text));
    notes.push('QLead chưa nhận ra loại khách hay dấu hiệu cụ thể, nên sẽ tìm theo ý chính trong mô tả của bạn.');
  }
  if (places.length > 1) notes.push(`Mô tả nhắc nhiều nơi: ${places.join(', ')}.`);

  const typeLabel = fnb ? 'Quán F&B' : categories.length ? categories.slice(0, 2).map((category, index) => index ? category.label.toLocaleLowerCase('vi') : category.label).join(', ') : '';
  const signalLabel = signals.map(signal => signal.label).join(', ');
  const base = typeLabel ? [typeLabel, signalLabel].filter(Boolean).join(' ') : signalLabel ? capitalize(`Khách ${signalLabel}`) : capitalize(mainIdea(text));
  const name = `${base}${places.length ? ` · ${places.join(', ')}` : ''}`.slice(0, 80);

  return {
    queries: unique(queries).slice(0, MAX_SEARCH_PHRASES),
    location: places.length ? places.join(', ') : null,
    name: text ? name : '',
    recognized: Boolean(typePhrases.length || signals.length),
    categories: [...(fnb ? ['food_and_beverage'] : []), ...categories.map(category => category.id)],
    signals: signals.map(signal => signal.id),
    notes,
  };
}

/**
 * Complementary strategies for the single bounded early follow-up. They focus on different evidence
 * signals, not immediate repeats of the first scan's phrases. Only clear, description-derived intent
 * is eligible; an ambiguous or manual-only setup cannot claim unexplored coverage reliably.
 */
export function planEarlyFollowup(description: string, initialQueries: string[]): string[] {
  const plan = planFromDescription(description);
  const text = clean(description);
  const openingRequested = plan.signals.includes('opening_soon');
  if (!text || !openingRequested || !plan.recognized) return [];

  const baseTypes = plan.categories.includes('food_and_beverage')
    ? FNB_PHRASES
    : CATEGORIES.filter(category => plan.categories.includes(category.id)).flatMap(category => category.phrases);
  const types = unique(baseTypes.length ? baseTypes : initialQueries).slice(0, MAX_SEARCH_PHRASES);
  const alternatives = types.flatMap(type => [
    `${type} mới thuê mặt bằng`,
    `tuyển nhân viên ${type} sắp khai trương`,
  ]);
  const seen = new Set(initialQueries.map(query => query.toLocaleLowerCase('vi')));
  return unique(alternatives).filter(query => !seen.has(query.toLocaleLowerCase('vi'))).slice(0, MAX_SEARCH_PHRASES);
}
