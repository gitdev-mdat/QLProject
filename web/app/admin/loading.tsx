import { RouteLoading } from '@/components/route-loading';

/** Fills the admin <main> while an admin page's data loads; the admin top bar (layout) stays in place. */
export default function AdminLoading() {
  return <RouteLoading/>;
}
