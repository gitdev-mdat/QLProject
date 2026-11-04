import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
  // Backend modules in ../src use NodeNext-style './x.js' imports for their .ts siblings.
  experimental: { extensionAlias: { '.js': ['.ts', '.js'] } },
  // Lets a verification build run beside a live `next start` without replacing its .next output.
  ...(process.env.QLEAD_DIST_DIR ? { distDir: process.env.QLEAD_DIST_DIR } : {}),
};

export default nextConfig;
