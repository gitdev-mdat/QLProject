'use client';

import { useSyncExternalStore } from 'react';

/**
 * Chromium fires `beforeinstallprompt` once per page load, often before the component that wants it has mounted, so
 * it is caught here when this module first loads (the /app frame imports it) and kept for a deliberate tap later.
 * Nothing calls prompt() unless the person presses "Cài QLead".
 */
type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

type State = { deferred: BeforeInstallPromptEvent | null; installed: boolean };
let state: State = { deferred: null, installed: false };
const listeners = new Set<() => void>();
const emit = (next: Partial<State>) => { state = { ...state, ...next }; listeners.forEach(listener => listener()); };

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', event => {
    // Keep the browser's mini-infobar from appearing on its own; the prompt is shown only from our button.
    event.preventDefault();
    emit({ deferred: event as BeforeInstallPromptEvent });
  });
  window.addEventListener('appinstalled', () => emit({ deferred: null, installed: true }));
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => state;
const serverSnapshot: State = { deferred: null, installed: false };

export function useInstallPrompt() {
  return useSyncExternalStore(subscribe, snapshot, () => serverSnapshot);
}

/** Opens the browser's own install dialog. Must be called from a click. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = state.deferred;
  if (!event) return 'unavailable';
  // A prompt event can be used once; the browser fires a fresh one later if the person dismissed it.
  emit({ deferred: null });
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === 'accepted') emit({ installed: true });
  return outcome;
}
