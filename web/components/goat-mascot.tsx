'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * QLead goat mascot: "Goat looping animation" by Shutter Natr (LottieFiles, Lottie Simple License).
 *
 * The static SVG (frame 0 of the loop) is always in the DOM and is the visible goat unless a Lottie loop has
 * actually drawn its own SVG into this mascot *right now*. `playing` is tied to the lifetime of one animation
 * instance: it turns on when that instance has rendered and turns off in the same cleanup that destroys it, so the
 * static goat can never be hidden while no animation is on screen (the old bug: `animate` flipped to false, the
 * loop was destroyed, `playing` stayed true and the mascot became an empty circle).
 */
const CROP = '121 113 440 440';

type LottieModule = typeof import('lottie-web/build/player/lottie_light');
let assets: Promise<[LottieModule, unknown]> | null = null;

/** The player and the goat JSON are fetched once per page and shared by every mascot; a failure can be retried later. */
function loadAssets() {
  assets ??= Promise.all([
    import('lottie-web/build/player/lottie_light'),
    fetch('/brand/qlead-goat.json').then(response => {
      if (!response.ok) throw new Error(`goat animation ${response.status}`);
      return response.json() as Promise<unknown>;
    }),
  ]).catch(error => { assets = null; throw error; });
  return assets;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(true); // server + first paint: static goat, no loop
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function GoatMascot({ size = 'md', animate = true, label }: { size?: 'xs' | 'sm' | 'md' | 'lg'; animate?: boolean; label?: string }) {
  const host = useRef<HTMLSpanElement>(null);
  const [playing, setPlaying] = useState(false);
  const reduced = useReducedMotion();
  const active = animate && !reduced;

  useEffect(() => {
    const container = host.current;
    if (!active || !container) return;
    let cancelled = false;
    let anim: { destroy(): void } | null = null;
    loadAssets().then(([{ default: lottie }, animationData]) => {
      if (cancelled) return;
      const instance = lottie.loadAnimation({ container, renderer: 'svg', loop: true, autoplay: true, animationData: structuredClone(animationData), rendererSettings: { viewBoxOnly: true } });
      anim = instance;
      const fail = () => { if (anim === instance) { instance.destroy(); anim = null; setPlaying(false); } };
      instance.addEventListener('data_failed', fail);
      instance.addEventListener('error', fail);
      instance.addEventListener('DOMLoaded', () => {
        const svg = container.querySelector('svg');
        if (cancelled || anim !== instance || !svg) return;
        svg.setAttribute('viewBox', CROP);
        setPlaying(true);
      });
    }).catch(() => { /* network or parse failure: the static goat stays visible */ });
    return () => {
      cancelled = true;
      anim?.destroy();
      anim = null;
      container.replaceChildren(); // never leave a half-built player behind
      setPlaying(false);
    };
  }, [active]);

  return <span className={`goat-mascot goat-${size} ${playing && active ? 'is-playing' : ''}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img className="goat-static" src="/brand/qlead-goat-full.svg" alt="" width={140} height={140} decoding="async"/>
    <span className="goat-anim" ref={host}/>
  </span>;
}
