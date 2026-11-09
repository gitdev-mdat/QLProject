import type { LeadRecord } from '../../src/lead-data';

/**
 * Where a lead came from, as recorded in PostgreSQL. `profile`: the post was stored under one of the customer's
 * search profiles, with the configuration version(s) it was found by (facebook_post_search_configs). `legacy`: the
 * post came from an older integration that recorded no search request, so no specific request is claimed.
 */
export type LeadSource =
  | { kind: 'profile'; profileId: string; profileName: string; version: number | null; keywords: string[]; location: string | null; discoveredAt: string | null }
  | { kind: 'legacy'; discoveredAt: string | null };

/** A lead plus every search that found the same Facebook post; the earliest discovery is the lead itself. */
export type Lead = LeadRecord & {
  sources: LeadSource[];
  deliveredAt: string | null;
  eligibility: { basis: 'source_linked_search'; relevance: 'selected_by_search'; independentlyVerified: false };
};

export const LEGACY_SOURCE_LABEL = 'Dữ liệu từ lượt quét trước';
export const LEGACY_FILTER = 'legacy';

export function sourceName(source: LeadSource): string {
  return source.kind === 'profile' ? source.profileName : LEGACY_SOURCE_LABEL;
}

export function matchesSourceFilter(lead: Lead, filter: string): boolean {
  if (filter === 'all') return true;
  if (filter === LEGACY_FILTER) return lead.sources.some(source => source.kind === 'legacy');
  return lead.sources.some(source => source.kind === 'profile' && source.profileId === filter);
}
