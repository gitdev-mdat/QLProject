import { planFromDescription, type DescriptionPlan } from '../../src/search-plan';
import type { SearchProfile } from './profile-state';

/**
 * Editable form state for a search profile, shared by onboarding and the Nhu cầu theo dõi page. The description is
 * the search instruction; the preview below uses the same planner as the server, so what the customer sees is what
 * gets stored.
 */
export const LOCATIONS = ['TP.HCM', 'Hà Nội', 'Đà Nẵng', 'Cần Thơ', 'Hải Phòng', 'Bình Dương', 'Đồng Nai', 'Đà Lạt', 'Nha Trang', 'Vũng Tàu', 'Huế', 'Miền Nam', 'Miền Trung', 'Miền Bắc'];
export const EXAMPLES = [
  'Tôi đang bán phần mềm quản lý, tính tiền và muốn tìm các quán cafe, trà sữa sắp khai trương ở TP.HCM.',
  'Tôi bán chén, đũa và dụng cụ ăn uống, muốn tìm nhà hàng chuẩn bị khai trương hoặc đang tuyển nhân viên.',
  'Tôi cung cấp dịch vụ chụp ảnh, quay phim và muốn tìm khách sạn, homestay mới khai trương ở Đà Lạt.',
];

export type Draft = {
  name: string;
  /** False while the name is the one QLead suggested, so it can follow the description. */
  nameEdited: boolean;
  description: string;
  location: string;
  frequency: number;
  enabled: boolean;
  /** 'manual' only when the customer opened the advanced option and wrote their own phrases. */
  keywordsSource: 'description' | 'manual';
  keywords: string;
};

export const emptyDraft: Draft = { name: '', nameEdited: false, description: '', location: '', frequency: 30, enabled: true, keywordsSource: 'description', keywords: '' };

export function draftFrom(profile: SearchProfile): Draft {
  const suggested = profile.description ? planFromDescription(profile.description).name : '';
  return {
    name: profile.name, nameEdited: profile.name !== suggested, description: profile.description ?? '', location: profile.location,
    frequency: profile.frequencyMinutes, enabled: profile.enabled, keywordsSource: profile.keywordsSource, keywords: profile.keywords.join('\n'),
  };
}

export const planFor = (draft: Draft): DescriptionPlan => planFromDescription(draft.description);

export function draftKeywords(draft: Draft): string[] {
  return draft.keywords.split('\n').map(line => line.trim()).filter(Boolean);
}

/** Phrases the save will store: generated from the description unless the customer maintains their own. */
export function effectiveKeywords(draft: Draft): string[] {
  return draft.keywordsSource === 'manual' ? draftKeywords(draft) : planFor(draft).queries;
}

/** Applies a new description: a suggested name follows it, a name the customer typed is kept. */
export function withDescription(draft: Draft, description: string): Draft {
  const plan = planFromDescription(description);
  return { ...draft, description, name: draft.nameEdited ? draft.name : plan.name };
}

export function draftPayload(draft: Draft) {
  return {
    name: draft.name.trim(), description: draft.description.trim(), location: draft.location, frequency_minutes: draft.frequency,
    keywords_source: draft.keywordsSource, ...(draft.keywordsSource === 'manual' ? { keywords: draftKeywords(draft) } : {}),
  };
}
