import type { MetadataRoute } from 'next';

/**
 * Installed QLead opens straight into the app (/app signs the person in first if needed). `id` stays '/' — the value
 * browsers derived from the previous start_url — so a copy installed before this change is still the same app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'QLead',
    short_name: 'QLead',
    description: 'Khách hàng tiềm năng từ Facebook cho đội sales.',
    lang: 'vi',
    dir: 'ltr',
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#FAFBF8',
    theme_color: '#FAFBF8',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    shortcuts: [
      { name: 'Danh sách lead', short_name: 'Lead', url: '/app/bai-viet', icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }] },
    ],
  };
}
