import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
  // Backend modules in ../src use NodeNext-style './x.js' imports for their .ts siblings.
  experimental: { extensionAlias: { '.js': ['.ts', '.js'] } },
  // Lets a verification build run beside a live `next start` without replacing its .next output.
  ...(process.env.QLEAD_DIST_DIR ? { distDir: process.env.QLEAD_DIST_DIR } : {}),
  // The push-only service worker must never be served stale from an HTTP cache, or a fix could take a day to reach phones.
  async headers() {
    return [{
      source: '/sw.js',
      headers: [
        { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
        { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'" },
        { key: 'Service-Worker-Allowed', value: '/' },
      ],
    }];
  },
};

export default nextConfig;
