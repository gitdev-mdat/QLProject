import { RouteLoading } from '@/components/route-loading';

/**
 * The list and a lead's detail page share this segment, so the /app boundary above does not re-suspend between them;
 * this one lets list → detail show its outline at once too.
 */
export default function LeadsLoading() {
  return <RouteLoading/>;
}
