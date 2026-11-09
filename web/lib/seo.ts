import type { Metadata } from 'next';

export const SITE_URL = 'https://qlead.vn';
export const SITE_TITLE = 'QLead — Khách hàng tiềm năng từ Facebook cho đội sales';
export const SITE_DESCRIPTION = 'QLead theo dõi bài đăng Facebook theo ngành bạn bán, nhận ra tín hiệu như sắp khai trương, tuyển người, mở chi nhánh và gom thành danh sách cơ hội để bạn liên hệ sớm.';
export const SOCIAL_IMAGE = {
  url: '/images/qlead-social.png',
  width: 1200,
  height: 630,
  alt: 'QLead — tìm khách hàng tiềm năng từ tín hiệu kinh doanh trên Facebook',
} as const;

type PageMetadataInput = {
  title: string;
  description: string;
  path: `/${string}`;
  indexable?: boolean;
};

/** Shared metadata for a public URL; canonical and social URL are always built from the production origin. */
export function pageMetadata({ title, description, path, indexable = true }: PageMetadataInput): Metadata {
  const canonical = new URL(path, SITE_URL).toString();
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      type: 'website',
      locale: 'vi_VN',
      siteName: 'QLead',
      title,
      description,
      url: canonical,
      images: [SOCIAL_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [SOCIAL_IMAGE],
    },
    ...(indexable ? {} : { robots: { index: false, follow: false } }),
  };
}

export function noIndexMetadata(): Metadata {
  return { robots: { index: false, follow: false } };
}
