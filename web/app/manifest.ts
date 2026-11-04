import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'QLead',
    short_name: 'QLead',
    description: 'Khách hàng tiềm năng từ Facebook cho đội sales.',
    lang: 'vi',
    start_url: '/',
    display: 'standalone',
    background_color: '#FAFBF8',
    theme_color: '#FAFBF8',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
