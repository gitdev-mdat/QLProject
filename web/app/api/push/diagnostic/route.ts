import { postPushDiagnostic } from '@/lib/server/push-api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const POST = (request: Request) => postPushDiagnostic(request);
