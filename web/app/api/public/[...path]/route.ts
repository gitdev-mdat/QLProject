import type { NextRequest } from 'next/server';
import { handleWorkerRoute } from '@/lib/server/worker-routes';

// Public, credential-free wake signals for the Muse Hook (/api/public/worker-wake, /api/public/worker-dispatch).
// Handlers live in ../src/wake-signal.ts; see lib/server/worker-routes.ts.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = (request: NextRequest) => handleWorkerRoute(request);
