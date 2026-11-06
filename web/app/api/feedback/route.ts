import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/server/request-guard';
import { getSession } from '@/lib/server/session';
import { submitFeedback } from '@/lib/server/feedback';
import { FEEDBACK_LIMITS, hasAnyAnswer, normalizeFeedbackText } from '../../../../src/customer-feedback';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
const stars = z.number().int().min(1).max(5).nullable().optional();
const body = z.object({
  submissionId: z.string().uuid(),
  context: z.enum(['invitation', 'voluntary']),
  easeRating: stars,
  needsRating: stars,
  unmetReason: z.string().max(FEEDBACK_LIMITS.unmetReason * 2).nullable().optional(),
  improvement: z.string().max(FEEDBACK_LIMITS.improvement * 2).nullable().optional(),
}).strict();

/**
 * Saves the customer's own answers. Ratings and text are all optional, but at least one must be given. The browser's
 * submissionId makes retries and double clicks idempotent. Text is never logged.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers });
  const answers = {
    submissionId: parsed.data.submissionId,
    context: parsed.data.context,
    easeRating: parsed.data.easeRating ?? null,
    needsRating: parsed.data.needsRating ?? null,
    unmetReason: normalizeFeedbackText(parsed.data.unmetReason, FEEDBACK_LIMITS.unmetReason),
    improvement: normalizeFeedbackText(parsed.data.improvement, FEEDBACK_LIMITS.improvement),
  };
  if (!hasAnyAnswer(answers)) return NextResponse.json({ error: 'empty' }, { status: 400, headers });
  try {
    const result = await submitFeedback(session.userId, answers);
    if (result.ok) return NextResponse.json({ ok: true }, { headers });
    const status = result.error === 'rate_limited' ? 429 : result.error === 'conflict' ? 409 : 400;
    return NextResponse.json({ error: result.error }, { status, headers });
  } catch (error) {
    // Only the error class: the answers themselves are never written to logs.
    console.error('Feedback submit failed:', error instanceof Error ? error.name : 'unknown');
    return NextResponse.json({ error: 'temporarily_unavailable' }, { status: 503, headers });
  }
}
