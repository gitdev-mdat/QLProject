import { getPushPreferences, putPushPreferences } from '@/lib/server/push-api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = (request: Request) => getPushPreferences(request);
export const PUT = (request: Request) => putPushPreferences(request);
