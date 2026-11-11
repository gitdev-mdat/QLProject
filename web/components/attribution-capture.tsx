'use client';

import { useEffect } from 'react';
import { captureFirstTouch } from '@/lib/attribution-client';

export function AttributionCapture() {
  useEffect(() => { captureFirstTouch(); }, []);
  return null;
}
