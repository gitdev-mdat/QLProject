'use client';

import { useEffect } from 'react';

/**
 * Adds `is-visible` to every [data-reveal] element as it scrolls into view. Without JavaScript, or with
 * reduced motion, content stays visible: the hidden state only applies under html.reveal-ready.
 */
export function RevealOnScroll() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
    const root = document.documentElement;
    root.classList.add('reveal-ready');
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -40px 0px', threshold: 0.05 });
    document.querySelectorAll('[data-reveal]').forEach(element => observer.observe(element));
    return () => { observer.disconnect(); root.classList.remove('reveal-ready'); };
  }, []);
  return null;
}
