import type { NextRequest } from 'next/server';
import { handleWorkerRoute } from '@/lib/server/worker-routes';

// Muse worker API (/api/worker/status, /api/worker/jobs/claim, /api/worker/jobs/:jobId/results|failure).
// Handlers live in ../src/worker-api.ts; see lib/server/worker-routes.ts.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

export const GET = (request: NextRequest) => handleWorkerRoute(request);
export const POST = (request: NextRequest) => handleWorkerRoute(request);
