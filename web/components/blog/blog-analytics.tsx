'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { captureFirstTouch } from '@/lib/attribution-client';
import { trackLanding } from '@/lib/landing-client';

export function BlogAnalytics() {
  const pathname = usePathname();
  useEffect(() => {
    captureFirstTouch();
    trackLanding('blog_view', { pagePath: pathname });
  }, [pathname]);
  return null;
}
