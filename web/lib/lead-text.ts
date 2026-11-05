import type { LeadRecord } from '../../src/lead-data';

/**
 * What a lead shows as its text, kept honest about where each piece of text comes from:
 *
 * - `summary`:  a Vietnamese summary produced by the backend. Shown labelled "QLead tóm tắt", never as a quote.
 * - `original`: the post's own text, in Vietnamese. Shown as the quote from Facebook.
 * - `fallback`: a short Vietnamese line when QLead has no text it can show by default (no extracted content, or
 *               only English / collector-written text without a Vietnamese summary).
 *
 * Anything else the backend stored stays reachable under "Xem nội dung gốc" with a label that says what it is.
 * Nothing here translates, summarises or invents text: the browser only decides which stored text to show.
 */
export type LeadTextKind = 'summary' | 'original' | 'fallback';
export type LeadText = {
  kind: LeadTextKind;
  /** The line shown in lists and at the top of the detail. */
  text: string;
  /** Stored text kept separately (collapsed by default); null when there is none or it is already shown. */
  stored: { text: string; label: string } | null;
  /** Plain-language data status chip, only when something is missing. */
  status: string | null;
  /** Shorter line for list rows, where the status chip already says what is missing. */
  listText: string;
};

export const NO_CONTENT_STATUS = 'Chưa trích xuất nội dung';
export const NO_SUMMARY_STATUS = 'Chưa có tóm tắt tiếng Việt';
export const NO_CONTENT_TEXT = 'Nội dung bài đăng chưa được trích xuất. Bạn có thể xem trực tiếp bài Facebook gốc.';
export const RECORDED_TEXT = 'QLead đã ghi nhận bài đăng này. Mở Facebook để xem nội dung gốc.';

/** Optional presentation fields from the backend contract (absent on older API versions). */
type Presentation = {
  /** Backend contract (migration 016): a Vietnamese description stored apart from the verbatim source content. */
  summary_vi?: string | null;
  /** Reserved shape for a future contract with an explicit language. */
  summary?: { text?: string | null; language?: string | null } | null;
  sourceMetadata?: { content?: string | null; contentKind?: 'original_post' | 'generated_description' | null; contentLanguage?: string | null } | null;
};

/**
 * Interim display gate, used only while the backend does not report `contentLanguage`: text with several common
 * English function words is not shown as Vietnamese post text. It never changes or translates the text.
 */
const ENGLISH_WORDS = /\b(the|of|for|and|with|from|this|that|which|showing|shows|announc(?:es|ing|ed)?|advertisement|photo|image|post(?:ed|s)?|about|offering|featuring|seeking|looking)\b/gi;
export function looksEnglish(text: string): boolean {
  return (text.match(ENGLISH_WORDS)?.length ?? 0) >= 2;
}

export function leadText(lead: Pick<LeadRecord, 'content' | 'title'> & Presentation): LeadText {
  const meta = lead.sourceMetadata ?? null;
  const stored = (meta && 'content' in meta ? meta.content : lead.content)?.trim() || '';
  const summary = lead.summary_vi?.trim()
    || (lead.summary?.text?.trim() && (lead.summary.language ?? 'vi') === 'vi' ? lead.summary.text.trim() : null);
  const kind = meta?.contentKind ?? null;
  const language = meta?.contentLanguage ?? (stored ? (looksEnglish(stored) ? 'en' : 'vi') : null);
  const vietnameseOriginal = Boolean(stored) && kind !== 'generated_description' && language === 'vi';

  const storedLabel = kind === 'generated_description'
    ? (language === 'vi' ? 'Mô tả do QLead ghi nhận từ bài đăng' : 'Mô tả do QLead ghi nhận từ bài đăng (tiếng Anh, chưa dịch)')
    : kind === 'original_post' ? (language === 'vi' ? 'Nội dung gốc trên Facebook' : 'Nội dung gốc trên Facebook (chưa dịch)')
      : (language === 'vi' ? 'Nội dung QLead ghi nhận được' : 'Nội dung QLead ghi nhận được (tiếng Anh, chưa dịch)');

  if (summary) return { kind: 'summary', text: summary, listText: summary, stored: stored ? { text: stored, label: storedLabel } : null, status: null };
  if (vietnameseOriginal) return { kind: 'original', text: stored, listText: stored, stored: null, status: null };
  if (!stored) return { kind: 'fallback', text: NO_CONTENT_TEXT, listText: 'Mở bài Facebook gốc để xem nội dung.', stored: null, status: NO_CONTENT_STATUS };
  return { kind: 'fallback', text: RECORDED_TEXT, listText: RECORDED_TEXT, stored: { text: stored, label: storedLabel }, status: NO_SUMMARY_STATUS };
}

/** Text the lead search looks in: the shown summary/original plus any stored text, so both languages match. */
export function leadSearchText(lead: Pick<LeadRecord, 'content' | 'title'> & Presentation): string {
  const text = leadText(lead);
  return [text.kind === 'fallback' ? '' : text.text, text.stored?.text ?? ''].join(' ');
}
