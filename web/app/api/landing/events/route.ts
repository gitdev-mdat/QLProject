import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requestAddress } from '@/lib/auth-rate-limit';
import { allowLandingEvent } from '@/lib/server/landing-guard';
import { CLIENT_EVENTS, recordLandingEvent } from '@/lib/server/landing-search';
import { isSameOrigin } from '@/lib/server/request-guard';
import { getSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const uuid = z.string().uuid();
const body = z.object({
  event: z.enum(CLIENT_EVENTS),
  visitorId: uuid.nullable().optional(),
  previewId: uuid.nullable().optional(),
  trigger: z.enum(['auto', 'user', 'suggestion']).nullable().optional(),
  resultCount: z.number().int().min(0).max(2).nullable().optional(),
  clientMs: z.number().int().min(0).max(600_000).nullable().optional(),
  reason: z.enum(['timeout', 'rate_limited', 'overloaded', 'network', 'server', 'expired']).nullable().optional(),
  attributionSource: z.enum(['organic', 'blog', 'campaign', 'referral', 'direct', 'unknown']).nullable().optional(),
  attributionCampaign: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).nullable().optional(),
  attributionContent: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).nullable().optional(),
  pagePath: z.string().regex(/^\/blog(?:\/[a-z0-9-]+)?$/).nullable().optional(),
}).strict();

/** Conversion funnel counters from the landing search. No query text, IP or User-Agent is stored. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return new NextResponse(null, { status: 403 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!allowLandingEvent(requestAddress(request.headers))) return new NextResponse(null, { status: 429 });
  if (!parsed.success) return new NextResponse(null, { status: 400 });
  const session = await getSession().catch(() => null);
  const data = parsed.data;
  try {
    await recordLandingEvent({ event: data.event, visitorId: data.visitorId ?? null, previewId: data.previewId ?? null, trigger: data.trigger ?? null,
      resultCount: data.resultCount ?? null, clientMs: data.clientMs ?? null, reason: data.reason ?? null,
      attributionSource: data.attributionSource ?? null, attributionCampaign: data.attributionCampaign ?? null,
      attributionContent: data.attributionContent ?? null, pagePath: data.pagePath ?? null }, session?.userId ?? null);
  } catch (error) {
    console.error('landing event not stored', error instanceof Error ? error.message : 'unknown');
  }
  return new NextResponse(null, { status: 204 });
}
