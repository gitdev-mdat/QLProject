import type { Lead } from './lead-source';

const DAY = 24 * 60 * 60 * 1000;
const STOP_WORDS = new Set(['cac', 'nhung', 'nguoi', 'muon', 'can', 'dang', 'tim', 'cho', 'voi', 'tai', 'quan', 'khu', 'vuc', 'mot', 'va', 'hoac', 'duoc', 'co', 'la', 'de', 'sua', 'mua', 'ban', 'sang', 'sap']);

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLocaleLowerCase('vi');
}

function terms(value: string): string[] {
  return [...new Set(normalize(value).match(/[a-z0-9]{3,}/g) ?? [])].filter(term => !STOP_WORDS.has(term));
}

function freshnessPoints(publishedAt: string | null, now: number): number {
  if (!publishedAt) return -12;
  const published = Date.parse(publishedAt);
  if (!Number.isFinite(published) || published > now) return -12;
  const age = now - published;
  if (age <= DAY) return 50;
  if (age <= 3 * DAY) return 38;
  if (age <= 7 * DAY) return 26;
  return 0;
}

function relevancePoints(lead: Lead): number {
  const text = normalize(`${lead.title ?? ''} ${lead.content}`);
  const keywords = [...new Set(lead.sources.flatMap(source => source.kind === 'profile' ? source.keywords.flatMap(terms) : []))];
  const overlap = keywords.length ? keywords.filter(term => text.includes(term)).length / Math.min(keywords.length, 8) : 0;
  return Math.round(Math.min(18, overlap * 24));
}

function opportunityPoints(lead: Lead, now: number): number {
  const text = normalize(`${lead.title ?? ''} ${lead.content}`);
  const published = lead.published_at ? Date.parse(lead.published_at) : Number.NaN;
  const activeEvidence = /\b(dang tuyen|tuyen gap|tiep tuc tuyen|van dang tuyen|dang hoan thien|dang thi cong|chua khai truong|du kien khai truong ngay)\b/.test(text);
  if (Number.isFinite(published) && now - published > 7 * DAY && !activeEvidence) return 0;
  let points = 0;
  if (/\b(sap|chuan bi|du kien)\s+(khai truong|mo cua|di vao hoat dong)\b/.test(text)) points += 9;
  if (/\b(tuyen dung|dang tuyen|dang tuyen nguoi|tuyen nhan vien|tuyen gap|can nhan vien)\b/.test(text)) points += 6;
  if (/\b(mo(?: them)? chi nhanh|chi nhanh moi|chi nhanh thu)\b/.test(text)) points += 8;
  if (/\b(chuan bi|hoan thien|sua sang|set up|setup)\b/.test(text)) points += 4;
  return Math.min(points, 18);
}

const SOUTHERN = ['tp.hcm', 'tp hcm', 'ho chi minh', 'sai gon', 'binh duong', 'dong nai', 'can tho', 'tay ninh', 'long an', 'ba ria', 'vung tau'];
const CENTRAL = ['da nang', 'hue', 'quang nam', 'quang ngai', 'binh dinh', 'phu yen', 'khanh hoa', 'dak lak', 'lam dong', 'gia lai'];
function sameGeo(area: string, scope: string): boolean {
  const a = normalize(area); const s = normalize(scope);
  if (a.includes(s) || s.includes(a)) return true;
  if (s.includes('mien nam')) return SOUTHERN.some(city => a.includes(city));
  if (s.includes('mien trung')) return CENTRAL.some(city => a.includes(city));
  return false;
}

function geographyPoints(lead: Lead): number {
  const expected = lead.sources.filter(source => source.kind === 'profile').map(source => source.location?.trim()).filter((value): value is string => Boolean(value));
  if (!expected.length || !lead.area.location || lead.area.ambiguous) return 0;
  return expected.some(location => sameGeo(lead.area.location!, location)) ? 7 : -5;
}

/** Explainable ordering score; publication dates never fall back to QLead discovery time. */
export function leadRankScore(lead: Lead, now = Date.now()): number {
  return freshnessPoints(lead.published_at, now)
    + relevancePoints(lead)
    + opportunityPoints(lead, now)
    + geographyPoints(lead)
    + (lead.need ? 4 : 0)
    + (lead.original_url ? 2 : 0)
    + (lead.contact ? 3 : 0);
}

/** Higher score first. Publish time, then discovery time, break ties; unknown dates remain last. */
export function compareLeadRank(a: Lead, b: Lead, now = Date.now()): number {
  const score = leadRankScore(b, now) - leadRankScore(a, now);
  if (score) return score;
  const sortPublished = (value: string | null) => {
    const time = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(time) && time <= now ? time : Number.NEGATIVE_INFINITY;
  };
  const published = sortPublished(b.published_at) - sortPublished(a.published_at);
  if (published) return published;
  const discovered = (Date.parse(b.discovered_at ?? '') || Number.NEGATIVE_INFINITY) - (Date.parse(a.discovered_at ?? '') || Number.NEGATIVE_INFINITY);
  return discovered || a.id.localeCompare(b.id);
}
