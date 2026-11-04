'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * QLead goat mascot: "Goat looping animation" by Shutter Natr (LottieFiles, Lottie Simple License).
 * A static SVG of frame 0 renders first (and stays for reduced motion); the Lottie loop loads lazily on top.
 */
const CROP = '121 113 440 440';

export function GoatMascot({ size = 'md', animate = true, label }: { size?: 'xs' | 'sm' | 'md' | 'lg'; animate?: boolean; label?: string }) {
  const host = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!animate || !host.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let cancelled = false;
    let destroy = () => {};
    Promise.all([
      import('lottie-web/build/player/lottie_light'),
      fetch('/brand/qlead-goat.json').then(response => response.json()),
    ]).then(([{ default: lottie }, animationData]) => {
      if (cancelled || !host.current) return;
      const anim = lottie.loadAnimation({ container: host.current, renderer: 'svg', loop: true, autoplay: true, animationData, rendererSettings: { viewBoxOnly: true } });
      anim.addEventListener('DOMLoaded', () => {
        host.current?.querySelector('svg')?.setAttribute('viewBox', CROP);
        setPlaying(true);
      });
      destroy = () => anim.destroy();
    }).catch(() => { /* keep the static goat */ });
    return () => { cancelled = true; destroy(); };
  }, [animate]);

  return <span className={`goat-mascot goat-${size} ${playing ? 'is-playing' : ''}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img className="goat-static" src="/brand/qlead-goat-full.svg" alt=""/>
    <span className="goat-anim" ref={host}/>
  </span>;
}
