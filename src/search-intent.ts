import { z } from 'zod';

const tagList = z.array(z.string().trim().min(1).max(160)).max(40);

const searchIntentBaseSchema = z.object({
  user_request: z.string().trim().max(1000),
  industries: tagList,
  business_types: tagList,
  intent_signals: tagList,
  included_locations: tagList,
  excluded_conditions: tagList,
  search_keywords: tagList,
  search_source: z.array(z.string().trim().min(1).max(100)).max(20),
  frequency_minutes: z.number().int().min(1).max(10080),
  enabled: z.boolean(),
}).strict();

export type SearchIntent = z.infer<typeof searchIntentBaseSchema>;
export type NormalizedSearchIntent = SearchIntent;
export const searchIntentSchema = searchIntentBaseSchema.transform(normalizeSearchIntent);

export const defaultSearchIntent = (): SearchIntent => ({
  user_request: '',
  industries: [],
  business_types: [],
  intent_signals: [],
  included_locations: [],
  excluded_conditions: [],
  search_keywords: [],
  search_source: ['social.search'],
  frequency_minutes: 30,
  enabled: true,
});

function uniqueClean(values: string[]): string[] {
  const seen = new Set<string>();
  return values.map(value => value.trim().replace(/\s+/g, ' ')).filter(value => {
    const key = value.toLocaleLowerCase('vi');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSearchIntent(intent: SearchIntent): NormalizedSearchIntent {
  return {
    ...intent,
    user_request: intent.user_request.trim().replace(/\s+/g, ' '),
    industries: uniqueClean(intent.industries),
    business_types: uniqueClean(intent.business_types),
    intent_signals: uniqueClean(intent.intent_signals),
    included_locations: uniqueClean(intent.included_locations),
    excluded_conditions: uniqueClean(intent.excluded_conditions),
    search_keywords: uniqueClean(intent.search_keywords),
    search_source: uniqueClean(intent.search_source),
  };
}

const businessTypeCatalog = [
  { id: 'cafe', label: 'Quán cà phê', matches: /(?:^|[^a-z0-9])(?:cafe|café|cà phê|quan ca phe)(?=$|[^a-z0-9])/i },
  { id: 'restaurant', label: 'Nhà hàng', matches: /(?:^|[^a-z0-9])(?:nhà hàng|nha hang|restaurant)(?=$|[^a-z0-9])/i },
  { id: 'food_shop', label: 'Quán ăn', matches: /(?:^|[^a-z0-9])(?:quán ăn|quan an|quán f&b|quan f&b)(?=$|[^a-z0-9])/i },
  { id: 'milk_tea', label: 'Quán trà sữa', matches: /(?:^|[^a-z0-9])(?:trà sữa|tra sua|milk tea)(?=$|[^a-z0-9])/i },
  { id: 'bakery', label: 'Tiệm bánh', matches: /(?:^|[^a-z0-9])(?:tiệm bánh|tiem banh|bakery)(?=$|[^a-z0-9])/i },
] as const;

const fnbTypes = ['cafe', 'restaurant', 'milk_tea', 'bakery', 'food_shop'];
const openingSoon = /(?:sắp|chuẩn bị|dự kiến|soon to|preparing to)\s*(?:mở|khai trương|open)|opening soon/i;
const recentlyOpened = /(?:mới|vừa|đã)\s*(?:mở|khai trương|opened)|recently opened/i;

export interface IntentInterpretation {
  intent: NormalizedSearchIntent;
  warnings: string[];
  ambiguous: boolean;
}

function includesAny(text: string, expressions: RegExp[]): boolean {
  return expressions.some(expression => expression.test(text));
}

export function interpretSearchRequest(request: string): IntentInterpretation {
  const text = request.trim().replace(/\s+/g, ' ');
  const lower = text.toLocaleLowerCase('vi');
  const intent = defaultSearchIntent();
  intent.user_request = text;
  const warnings: string[] = [];

  const isFnb = /\b(?:f\s*&\s*b|food\s*(?:and|&)\s*beverage|ẩm thực|am thuc|ăn uống|an uong|ngành ăn uống)\b/i.test(text);
  if (isFnb) {
    intent.industries = ['food_and_beverage'];
    intent.business_types = [...fnbTypes];
  } else {
    const matchedTypes = businessTypeCatalog.filter(item => item.matches.test(text)).map(item => item.id);
    intent.business_types = matchedTypes;
    if (matchedTypes.length) intent.industries = ['food_and_beverage'];
  }

  const stageSignals: string[] = [];
  if (openingSoon.test(lower)) stageSignals.push('opening_soon');
  if (recentlyOpened.test(lower)) stageSignals.push('recently_opened');
  intent.intent_signals = stageSignals;
  if (stageSignals.length > 1) warnings.push('Yêu cầu vừa nói sắp mở vừa nói đã mở. Hãy chọn một giai đoạn.');

  const locationMatches: Array<[RegExp, string]> = [
    [/\b(?:miền nam|mien nam|southern vietnam|south vietnam)\b/i, 'southern_vietnam'],
    [/\b(?:miền bắc|mien bac|northern vietnam|north vietnam)\b/i, 'northern_vietnam'],
    [/\b(?:miền trung|mien trung|central vietnam)\b/i, 'central_vietnam'],
    [/\b(?:tp\.?\s*hcm|hồ chí minh|ho chi minh|sài gòn|sai gon)\b/i, 'ho_chi_minh_city'],
    [/\b(?:hà nội|ha noi|hanoi)\b/i, 'hanoi'],
    [/\b(?:đà nẵng|da nang)\b/i, 'da_nang'],
  ];
  intent.included_locations = locationMatches.filter(([pattern]) => pattern.test(text)).map(([, location]) => location);
  if (intent.included_locations.length > 1) warnings.push('Có nhiều khu vực trong cùng yêu cầu. Hãy xác nhận phạm vi muốn tìm.');

  const exclusion = text.match(/(?:không gồm|không tìm|loại trừ|trừ)\s+([^,.;]+)/i);
  if (exclusion?.[1]) intent.excluded_conditions = [exclusion[1].trim()];

  const parsed = searchIntentSchema.safeParse(intent);
  if (!parsed.success) throw new Error('Could not normalize interpreted search intent.');
  const ambiguous = !text || (parsed.data.industries.length === 0 && parsed.data.business_types.length === 0 && parsed.data.intent_signals.length === 0);
  if (!text) warnings.push('Hãy mô tả khách hàng hoặc cơ hội bạn muốn tìm.');
  else if (ambiguous) warnings.push('QLead chưa nhận ra điều kiện cụ thể. Hãy thử thêm ngành hàng, dấu hiệu nhu cầu hoặc khu vực.');
  return { intent: parsed.data, warnings, ambiguous };
}

export interface SearchPlan {
  queries: string[];
  geographic_scope: string[];
  budget: number;
}

const typePhrases: Record<string, string[]> = {
  cafe: ['quán cà phê'],
  restaurant: ['nhà hàng'],
  food_shop: ['quán ăn'],
  milk_tea: ['quán trà sữa'],
  bakery: ['tiệm bánh'],
};
const stagePhrases: Record<string, string[]> = {
  opening_soon: ['sắp khai trương', 'chuẩn bị khai trương', 'sắp mở cửa'],
  recently_opened: ['mới khai trương', 'vừa khai trương'],
};
const locationLabels: Record<string, string> = {
  southern_vietnam: 'Miền Nam',
  northern_vietnam: 'Miền Bắc',
  central_vietnam: 'Miền Trung',
  ho_chi_minh_city: 'TP.HCM',
  hanoi: 'Hà Nội',
  da_nang: 'Đà Nẵng',
};

export function planSearchQueries(intent: NormalizedSearchIntent, requestedBudget = 5): SearchPlan {
  const budget = Math.max(1, Math.min(10, Math.floor(requestedBudget)));
  const locations = intent.included_locations.map(location => locationLabels[location] ?? location);
  const scope = locations;
  const types = intent.business_types.flatMap(type => typePhrases[type] ?? [type]).slice(0, 10);
  const stages = intent.intent_signals.flatMap(stage => stagePhrases[stage] ?? [stage]).slice(0, 10);
  const queries: string[] = [];

  if (types.length && stages.length) {
    for (const type of types) {
      const stage = stages[0];
      if (stage) queries.push([type, stage, ...scope].join(' '));
    }
    if (stages.length > 1 && types[0]) queries.push([types[0], stages[1], ...scope].join(' '));
  } else if (intent.search_keywords.length) {
    for (const keyword of intent.search_keywords) queries.push([keyword, ...scope].join(' '));
  } else if (intent.user_request) {
    queries.push([intent.user_request, ...scope].join(' '));
  }

  const normalized = uniqueClean(queries).slice(0, budget);
  return { queries: normalized, geographic_scope: scope, budget };
}

export interface LegacyScanConfig {
  enabled: boolean;
  keywords: string[];
  location: string;
  sources: string[];
  frequency_minutes: number;
}

/** Projects structured intent into the unchanged Muse agent config contract. */
export function toLegacyScanConfig(intent: NormalizedSearchIntent): LegacyScanConfig {
  const plan = planSearchQueries(intent);
  const keywords = intent.search_keywords.length ? intent.search_keywords : plan.queries;
  if (!keywords.length) throw new Error('Add a search condition before creating a scan config.');
  if (!intent.included_locations.length) throw new Error('Choose a location before creating a scan config.');
  return {
    enabled: intent.enabled,
    keywords,
    location: plan.geographic_scope.join(', '),
    sources: intent.search_source.length ? intent.search_source : ['social.search'],
    frequency_minutes: intent.frequency_minutes,
  };
}

export type RelevanceDecision = 'include' | 'review' | 'exclude';

export function deduplicateSearchResults<T extends { normalized_url?: string | null; url?: string | null }>(posts: T[]): T[] {
  const seen = new Set<string>();
  return posts.filter(post => {
    const key = (post.normalized_url ?? post.url ?? '').trim().replace(/\/$/, '').toLocaleLowerCase('en');
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function evaluatePostAgainstIntent(intent: NormalizedSearchIntent, postText: string): { decision: RelevanceDecision; reasons: string[] } {
  const text = postText.toLocaleLowerCase('vi');
  const excluded = intent.excluded_conditions.find(condition => text.includes(condition.toLocaleLowerCase('vi')));
  if (excluded) return { decision: 'exclude', reasons: [`Nội dung khớp điều kiện loại trừ: ${excluded}`] };

  const reasons: string[] = [];
  if (intent.industries.includes('food_and_beverage')) {
    const industryEvidence = /cà phê|cafe|nhà hàng|quán ăn|trà sữa|tiệm bánh|ẩm thực|ăn uống/i.test(text);
    if (!industryEvidence) reasons.push('Chưa đủ dữ liệu để xác nhận ngành hàng.');
    else reasons.push('Có dấu hiệu thuộc nhóm ăn uống.');
  }
  if (intent.intent_signals.includes('opening_soon')) {
    const stageEvidence = /sắp khai trương|chuẩn bị khai trương|sắp mở cửa|chuẩn bị mở/i.test(text);
    if (!stageEvidence) reasons.push('Chưa thấy bằng chứng rõ về thời điểm khai trương.');
    else reasons.push('Có dấu hiệu sắp khai trương.');
  }
  if (intent.included_locations.length) {
    const southEvidence = /miền nam|tp\.?\s*hcm|hồ chí minh|sài gòn|cần thơ|bình dương|đồng nai/i.test(text);
    const northEvidence = /miền bắc|hà nội|hải phòng/i.test(text);
    const centralEvidence = /miền trung|đà nẵng|huế|quảng nam/i.test(text);
    const hasLocationEvidence = southEvidence || northEvidence || centralEvidence;
    const targetLabels = intent.included_locations;
    const matches = targetLabels.some(location => location === 'southern_vietnam' ? southEvidence : location === 'northern_vietnam' ? northEvidence : location === 'central_vietnam' ? centralEvidence : text.includes((locationLabels[location] ?? location).toLocaleLowerCase('vi')));
    if (matches) reasons.push('Có bằng chứng phù hợp với khu vực đã chọn.');
    else if (!hasLocationEvidence) reasons.push('Chưa rõ khu vực trong bài viết; cần xem lại thủ công.');
    else return { decision: 'exclude', reasons: ['Bài viết nêu khu vực ngoài phạm vi đã chọn.'] };
  }

  if (reasons.some(reason => reason.startsWith('Chưa'))) return { decision: 'review', reasons };
  return { decision: reasons.length ? 'include' : 'review', reasons: reasons.length ? reasons : ['Chưa có điều kiện đủ cụ thể để đánh giá.'] };
}
