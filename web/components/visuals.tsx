import Link from 'next/link';

export function Logo() {
  // Goat mark from "Goat looping animation" by Shutter Natr (LottieFiles, Lottie Simple License), cropped onto the brand tile.
  // eslint-disable-next-line @next/next/no-img-element
  return <span className="logo-mark" aria-hidden="true"><img src="/brand/qlead-goat.svg" alt="" width={40} height={40}/></span>;
}

export function Brand({ href = '/' }: { href?: string }) {
  return <Link href={href} className="brand" aria-label="QLead, về trang chủ"><Logo/><span>Q<span className="brand-light">Lead</span></span></Link>;
}


const iconPaths: Record<string, string> = {
  today: 'M4 5h16v15H4zM4 10h16M9 3v4M15 3v4',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 12h.01',
  plug: 'M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0V7ZM12 16v5',
  group: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20a6.5 6.5 0 0 1 13 0M16 4.2a3.5 3.5 0 0 1 0 6.6M18 14a6.5 6.5 0 0 1 3.5 6',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z',
  pin: 'M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11ZM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  radar: 'M12 12 19 5M12 21a9 9 0 1 1 9-9M12 16a4 4 0 1 1 4-4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  check: 'M5 12.5 10 17l9-10',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 6l-6 6 6 6',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01',
  filter: 'M4 5h16l-6 8v5l-4 2v-7z',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
  eyeOff: 'M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.8M6.6 7.6C3.8 9.3 2 12 2 12s3.5 6 10 6a9.6 9.6 0 0 0 4-.9M9.9 10a3 3 0 0 0 4.1 4.1',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
};

export function Icon({ name, size = 18 }: { name: keyof typeof iconPaths | string; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name] ?? iconPaths.info}/></svg>;
}

