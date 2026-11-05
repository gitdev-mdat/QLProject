/**
 * Validates a post-login / notification destination. Only same-origin paths inside the signed-in app are accepted:
 * "/app" or "/app/…", no scheme, no protocol-relative "//", no backslashes or control characters. Anything else is
 * rejected (null) and callers fall back to their normal landing page, so a crafted link can never redirect elsewhere.
 */
export function safeAppPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value, 'https://qlead.invalid'); } catch { return null; }
  if (url.origin !== 'https://qlead.invalid') return null;
  if (url.pathname !== '/app' && !url.pathname.startsWith('/app/')) return null;
  return url.pathname + url.search + url.hash;
}
