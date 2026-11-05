import { deletePushSubscription, putPushSubscription } from '@/lib/server/push-api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const PUT = (request: Request) => putPushSubscription(request);
export const DELETE = (request: Request) => deletePushSubscription(request);
