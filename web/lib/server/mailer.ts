import 'server-only';

/**
 * Transactional email. QLead had no email provider before the forgot-password flow; this uses Resend's HTTP API
 * (https://resend.com/docs/api-reference/emails/send-email) with plain fetch, so no new dependency is needed.
 *
 * Environment (web app):
 *   RESEND_API_KEY  API key from Resend (Vercel: Production environment only).
 *   MAIL_FROM       Sender on a domain verified in Resend, e.g. "QLead <no-reply@qlead.vn>".
 *   RESEND_API_URL  Optional override, used only by the E2E test to point at a local mock.
 *
 * Without RESEND_API_KEY/MAIL_FROM, `next dev` prints the email to the server console (so the flow can be tried
 * locally) and a production build logs an error without the recipient or content and sends nothing.
 */
export type OutgoingEmail = { to: string; subject: string; html: string; text: string };

export function emailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim() && env.MAIL_FROM?.trim());
}

export async function sendEmail(message: OutgoingEmail): Promise<boolean> {
  if (!emailConfigured()) {
    if (process.env.NODE_ENV === 'development') {
      console.info(`[mail:dev] To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}`);
      return true;
    }
    console.error('[mail] Not sent: RESEND_API_KEY and MAIL_FROM are not configured.');
    return false;
  }
  try {
    const response = await fetch(process.env.RESEND_API_URL?.trim() || 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM!.trim(), to: [message.to], subject: message.subject, html: message.html, text: message.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) { console.error(`[mail] Provider rejected the email (HTTP ${response.status}).`); return false; }
    return true;
  } catch (error) {
    console.error(`[mail] Provider unreachable: ${error instanceof Error ? error.name : 'error'}.`);
    return false;
  }
}
