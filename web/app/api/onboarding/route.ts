import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { isSameOrigin } from '@/lib/server/request-guard';
import { getSession } from '@/lib/server/session';
import { completeOnboarding, profileInput } from '@/lib/server/profiles';

const body = z.object({ profile: profileInput, enabled: z.boolean() }).strict();

/** Saves the signed-in user's first search profile and finishes onboarding. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const result = await completeOnboarding(session.userId, parsed.data.profile, parsed.data.enabled);
  return NextResponse.json({ redirect: '/app/lan-tim-dau', created: result.created });
}
