import type { Metadata, Viewport } from 'next';
import { Be_Vietnam_Pro } from 'next/font/google';
import { SITE_DESCRIPTION, SITE_TITLE, SITE_URL, SOCIAL_IMAGE } from '@/lib/seo';
import { AttributionCapture } from '@/components/attribution-capture';
import './globals.css';

// Be Vietnam Pro is drawn for Vietnamese: stacked diacritics stay legible at small sizes and heavy weights.
const sans = Be_Vietnam_Pro({ subsets: ['latin', 'vietnamese'], weight: ['400', '500', '600', '700'], variable: '--font-sans', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  openGraph: { type: 'website', locale: 'vi_VN', siteName: 'QLead', title: SITE_TITLE, description: SITE_DESCRIPTION, images: [SOCIAL_IMAGE] },
  twitter: { card: 'summary_large_image', title: SITE_TITLE, description: SITE_DESCRIPTION, images: [SOCIAL_IMAGE] },
  applicationName: 'QLead',
  manifest: '/manifest.webmanifest',
  // iOS reads the Home Screen icon and name from these tags, not from the manifest icons.
  icons: { apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }] },
  appleWebApp: { capable: true, title: 'QLead', statusBarStyle: 'default' },
};

// viewport-fit=cover exposes the safe-area insets (notch, home indicator) that globals.css pads for.
export const viewport: Viewport = { themeColor: '#FAFBF8', viewportFit: 'cover' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Browser extensions (e.g. ones adding bis_register / __processed_* attributes) edit <body> before React hydrates.
  return <html lang="vi" className={sans.variable} suppressHydrationWarning><body suppressHydrationWarning><AttributionCapture/>{children}</body></html>;
}
