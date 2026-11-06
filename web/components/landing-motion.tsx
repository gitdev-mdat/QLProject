'use client';

import { useEffect } from 'react';

/** Sticky nav gains a border and shadow once the page scrolls. */
export function NavScrollState() {
  useEffect(() => {
    const nav = document.querySelector('.site-nav');
    if (!nav) return;
    const update = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);
  return null;
}
