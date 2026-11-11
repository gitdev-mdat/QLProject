export type HotLeadCandidate = {
  title: string | null;
  content: string | null;
  summary_vi?: string | null;
  published_at: Date | string | null;
  keywords: string[];
  description?: string | null;
};

export type HotLeadAssessment = {
  hot: boolean;
  reasonVi: string | null;
  evidence: string | null;
  expiresAt: Date | null;
};

const STOP_WORDS = new Set(['cac','nhung','nguoi','muon','can','dang','tim','cho','voi','tai','quan','khu','vuc','mot','va','hoac','duoc','co','la','de','sua','mua','ban','sang','sap','toi','minh','nay','nay','giup','xin']);
const INTENT = [
  /\b(?:dang )?(?:can tim|tim mua|tim don vi|tim nha cung cap|tim nha thau|tim dich vu|tim phan mem|can phan mem|can tu van|xin tu van|nho tu van|xin gioi thieu|ai biet don vi|ai cung cap|muon mua|can mua|can thue|can dich vu)\b/,
];

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLocaleLowerCase('vi');
}

function tokens(value: string): string[] {
  return [...new Set(normalize(value).match(/[a-z0-9]{3,}/g) ?? [])].filter(token => !STOP_WORDS.has(token));
}

function evidencePhrase(text: string): string | null {
  const normalized = normalize(text);
  for (const pattern of INTENT) {
    const match = normalized.match(pattern);
    if (match?.index === undefined) continue;
    const grounded = normalized.slice(match.index, match.index + match[0].length).trim();
    return grounded.length >= 8 ? grounded : null;
  }
  return null;
}

/** Conservative profile scoped rule: verified post time <= 2h, a direct intent phrase, and meaningful profile match. */
export function assessHotLead(candidate: HotLeadCandidate, at = new Date()): HotLeadAssessment {
  const publishedAt = candidate.published_at ? new Date(candidate.published_at) : null;
  if (!publishedAt || !Number.isFinite(publishedAt.getTime()) || publishedAt > at || at.getTime() - publishedAt.getTime() > 2 * 60 * 60_000) {
    return { hot: false, reasonVi: null, evidence: null, expiresAt: null };
  }
  const sourceText = `${candidate.title ?? ''} ${candidate.content ?? ''}`.trim();
  const evidence = evidencePhrase(sourceText);
  if (!evidence) return { hot: false, reasonVi: null, evidence: null, expiresAt: null };
  const textTerms = new Set(tokens(sourceText));
  const configured = [...candidate.keywords, ...(candidate.description ? [candidate.description] : [])];
  const matchingPhrase = candidate.keywords.map(value => value.trim()).filter(value => value.length >= 4)
    .find(value => normalize(sourceText).includes(normalize(value)));
  const profileTerms = [...new Set(configured.flatMap(tokens))];
  const overlap = profileTerms.filter(term => textTerms.has(term));
  const relevant = matchingPhrase !== undefined || (overlap.length >= 2 && overlap.length / Math.min(profileTerms.length, 8) >= 0.25);
  if (!relevant) return { hot: false, reasonVi: null, evidence: null, expiresAt: null };
  const relevanceEvidence = matchingPhrase ?? overlap.slice(0, 3).join(', ');
  return {
    hot: true,
    reasonVi: `Bài đăng còn mới, nêu nhu cầu “${evidence}” và khớp hồ sơ tìm kiếm (${relevanceEvidence}).`,
    evidence,
    expiresAt: new Date(publishedAt.getTime() + 2 * 60 * 60_000),
  };
}
