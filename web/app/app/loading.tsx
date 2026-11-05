import { RouteLoading } from '@/components/route-loading';

/** Fills <main> inside the persistent app frame while any /app page's data loads (see components/route-loading.tsx). */
export default function AppLoading() {
  return <RouteLoading/>;
}
