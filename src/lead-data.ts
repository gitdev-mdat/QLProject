import { isSupportedFacebookPostUrl } from './lead-eligibility.js';

export interface SearchConfigSummary {
  version: number;
  enabled: boolean;
  keywords: string[];
  location: string;
  sources: string[];
  frequency_minutes: number;
}

export interface StoredFacebookPost {
  id: string;
  author?: string | null;
  title?: string | null;
  content?: string | null;
  summary_vi?: string | null;
  published_at?: string | Date | null;
  original_url?: string | null;
  normalized_url?: string | null;
  discovered_at?: string | Date | null;
  delivered_at?: string | Date | null;
  first_seen_at?: string | Date | null;
  source_type?: string | null;
  collected_via?: string | null;
  platform?: string | null;
  agent_name?: string | null;
  search_configurations?: SearchConfigSummary[] | null;
}

export interface ExtractedContact {
  number: string;
  normalized: string;
  evidence: string;
}

export interface ExtractedLocation {
  location: string | null;
  evidence: string | null;
  ambiguous: boolean;
}

export interface LeadRecord {
  id: string;
  author: string | null;
  title: string | null;
  summary_vi: string | null;
  content: string;
  need: string | null;
  contact: ExtractedContact | null;
  area: ExtractedLocation;
  published_at: string | null;
  discovered_at: string | null;
  original_url: string | null;
  source_type: string | null;
  collected_via: string | null;
  platform: string | null;
  agent_name: string | null;
  search_configurations: SearchConfigSummary[];
  /** Raw source metadata, with missing extraction represented as null for the API/UI handoff. */
  sourceMetadata: {
    status: 'complete' | 'incomplete';
    author: string | null;
    title: string | null;
    content: string | null;
    publishedAt: string | null;
    missingFields: Array<'author' | 'title' | 'content' | 'publishedAt'>;
  };
}

const phonePattern = /(?:số\s*điện\s*thoại|điện\s*thoại|sđt|sdt|liên\s*hệ|liên\s*lạc|hotline|zalo|gọi|call|phone)\s*(?:là|:|：|-)?\s*((?:\+?84|0)?(?:[\s().-]*\d){8,11})/iu;
const locationPatterns: Array<[RegExp, string]> = [
  [/\b(?:tp\.?\s*hồ chí minh|tp\.?\s*hcm|hồ chí minh|ho chi minh|sài gòn|sai gon)\b/i, 'TP.HCM'],
  [/\b(?:thủ đức|thu duc)\b/i, 'Thủ Đức'],
  [/\b(?:bình thạnh|binh thanh)\b/i, 'Bình Thạnh'],
  [/\b(?:bình dương|binh duong)\b/i, 'Bình Dương'],
  [/\b(?:đồng nai|dong nai)\b/i, 'Đồng Nai'],
  [/\b(?:cần thơ|can tho)\b/i, 'Cần Thơ'],
  [/\b(?:hà nội|ha noi|hanoi)\b/i, 'Hà Nội'],
  [/\b(?:đà nẵng|da nang)\b/i, 'Đà Nẵng'],
  [/\b(?:huế|hue)\b/i, 'Huế'],
  [/\b(?:hải phòng|hai phong)\b/i, 'Hải Phòng'],
  [/\b(?:quảng ninh|quang ninh)\b/i, 'Quảng Ninh'],
];

function evidenceAround(text: string, index: number, length: number, radius = 55): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  return `${start ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

export function extractContactFromPost(content: string | null | undefined): ExtractedContact | null {
  if (!content) return null;
  const match = phonePattern.exec(content);
  const number = match?.[1]?.trim();
  if (!match || !number) return null;
  const digits = number.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 12) return null;
  return {
    number,
    normalized: number.startsWith('+') ? `+${digits}` : digits,
    evidence: evidenceAround(content, match.index, match[0].length),
  };
}

export function extractLocationFromPost(content: string | null | undefined): ExtractedLocation {
  if (!content) return { location: null, evidence: null, ambiguous: false };
  const mentions: Array<{ location: string; index: number; length: number }> = [];
  for (const [pattern, location] of locationPatterns) {
    const match = pattern.exec(content);
    if (match) mentions.push({ location, index: match.index, length: match[0].length });
  }
  const matches = mentions.filter(mention => {
    const before = content.slice(Math.max(0, mention.index - 45), mention.index);
    const directlyQualified = /(?:ở|tại|quanh|khu vực|địa chỉ|gần|thuộc|at|in)\s*$/iu.test(before);
    const districtParent = mention.location === 'TP.HCM' && /(?:thủ đức|thu duc|bình thạnh|binh thanh)\s*,\s*$/iu.test(before);
    const priorLocation = locationPatterns.some(([pattern]) => pattern.test(before));
    const connectedLocation = priorLocation && /(?:,\s*|\s+(?:và|hoặc|and|or)\s+)$/iu.test(before);
    return directlyQualified || districtParent || connectedLocation;
  });
  const unique = [...new Map(matches.map(match => [match.location, match])).values()].sort((a, b) => a.index - b.index);
  if (unique.length === 0) return { location: null, evidence: null, ambiguous: false };
  const evidence = [...new Set(unique.map(match => evidenceAround(content, match.index, match.length)))].join(' · ');
  const names = unique.map(match => match.location);
  const hcmDistricts = names.filter(name => name === 'Thủ Đức' || name === 'Bình Thạnh');
  if (names.includes('TP.HCM') && hcmDistricts.length === 1 && names.length === 2) {
    return { location: `${hcmDistricts[0]}, TP.HCM`, evidence, ambiguous: false };
  }
  if (unique.length > 1) return { location: null, evidence, ambiguous: true };
  return { location: unique[0]?.location ?? null, evidence, ambiguous: false };
}

export function extractNeedFromPost(content: string | null | undefined): string | null {
  if (!content?.trim()) return null;
  const sentences = content.split(/(?<=[.!?。！？])\s+/u).map(sentence => sentence.trim()).filter(Boolean);
  const signal = /(?:đang\s+cần|cần\s+tìm|muốn\s+(?:tìm|đặt|mua|thuê)|đang\s+tìm|tìm\s+(?:giúp|mua|thuê|đơn vị|nguồn|chỗ|thợ|nhà|quán)|cần\s+(?:mua|thuê|đơn vị|nguồn|thợ)|có\s+ai\s+(?:biết|giới\s+thiệu)|ai\s+biết|tư\s+vấn|giới\s+thiệu\s+giúp|looking\s+for|need\s+to\s+find)/iu;
  const sentence = sentences.find(item => signal.test(item));
  if (!sentence) return null;
  return sentence.length > 220 ? `${sentence.slice(0, 217).trimEnd()}…` : sentence;
}

function validTimestamp(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toLeadRecord(post: StoredFacebookPost): LeadRecord {
  const content = post.content ?? '';
  const author = post.author?.trim() || null;
  const title = post.title?.trim() || null;
  const sourceContent = post.content?.trim() || null;
  const publishedAt = validTimestamp(post.published_at);
  const missingFields: LeadRecord['sourceMetadata']['missingFields'] = [];
  if (!author) missingFields.push('author');
  if (!title) missingFields.push('title');
  if (!sourceContent) missingFields.push('content');
  if (!publishedAt) missingFields.push('publishedAt');
  const originalUrl = isSupportedFacebookPostUrl(post.original_url) ? post.original_url! : null;
  return {
    id: post.id,
    author,
    title,
    summary_vi: post.summary_vi?.trim() || null,
    content,
    need: extractNeedFromPost(content),
    contact: extractContactFromPost(content),
    area: extractLocationFromPost(content),
    published_at: publishedAt,
    discovered_at: validTimestamp(post.discovered_at ?? post.first_seen_at),
    original_url: originalUrl,
    source_type: post.source_type ?? null,
    collected_via: post.collected_via ?? null,
    platform: post.platform ?? null,
    agent_name: post.agent_name ?? null,
    search_configurations: post.search_configurations ?? [],
    sourceMetadata: {
      status: missingFields.length ? 'incomplete' : 'complete',
      author, title, content: sourceContent, publishedAt, missingFields,
    },
  };
}
