import { getPushConfig } from '@/lib/server/push-api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = (request: Request) => getPushConfig(request);
