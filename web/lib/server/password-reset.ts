import 'server-only';
import { z } from 'zod';
import { consumePasswordReset, createPasswordReset, isPasswordResetUsable, RESET_RULES } from '../../../src/password-reset';
import { SITE_URL } from '../seo';
import { hashPassword } from './accounts';
import { db } from './db';
import { sendEmail } from './mailer';

export const forgotPasswordInput = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict();
export const resetPasswordInput = z.object({ token: z.string().min(1).max(100), password: z.string().min(8).max(200) }).strict();

export const RESET_PATH = '/dat-lai-mat-khau';

/**
 * Where links in emails point. Never derived from the request's Host header in production (a forged Host would
 * otherwise put an attacker's domain in a real QLead email). QLEAD_PUBLIC_URL overrides; `next dev` uses its own origin.
 */
export function publicBaseUrl(requestOrigin: string): string {
  const configured = process.env.QLEAD_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return process.env.NODE_ENV === 'development' ? requestOrigin : SITE_URL;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function passwordResetEmail(name: string, link: string) {
  const minutes = RESET_RULES.linkMinutes;
  const subject = 'Đặt lại mật khẩu QLead';
  const text = [
    `Chào ${name},`,
    '',
    'QLead nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn. Mở link dưới đây để đặt mật khẩu mới:',
    link,
    '',
    `Link dùng được một lần và hết hạn sau ${minutes} phút.`,
    'Nếu bạn không yêu cầu, hãy bỏ qua email này. Mật khẩu hiện tại của bạn vẫn giữ nguyên.',
    '',
    'QLead',
  ].join('\n');
  const html = `<!doctype html><html lang="vi"><body style="margin:0;padding:24px;background:#F4F7F5;font-family:Arial,Helvetica,sans-serif;color:#13231B">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;border:1px solid #E1E8E4">
<tr><td style="padding:28px 28px 8px"><div style="font-size:22px;font-weight:700;color:#0B6B4B">QLead</div></td></tr>
<tr><td style="padding:8px 28px 0;font-size:16px;line-height:1.6">
<p style="margin:0 0 12px">Chào ${escapeHtml(name)},</p>
<p style="margin:0 0 20px">QLead nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn. Bấm nút dưới đây để đặt mật khẩu mới.</p>
</td></tr>
<tr><td style="padding:0 28px 20px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:14px 24px;border-radius:10px;background:#0E8A5F;color:#ffffff;font-weight:700;text-decoration:none;font-size:16px">Đặt mật khẩu mới</a></td></tr>
<tr><td style="padding:0 28px 24px;font-size:14px;line-height:1.6;color:#55655C">
<p style="margin:0 0 12px">Link dùng được một lần và hết hạn sau ${minutes} phút. Nếu nút không bấm được, hãy mở link này:<br><a href="${escapeHtml(link)}" style="color:#0B6B4B;word-break:break-all">${escapeHtml(link)}</a></p>
<p style="margin:0">Nếu bạn không yêu cầu, hãy bỏ qua email này. Mật khẩu hiện tại của bạn vẫn giữ nguyên.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

/**
 * Issues a link and emails it if the email has a web account. Runs after the HTTP response (next/server `after`), so
 * the response never depends on whether the account exists. Errors are logged without the email address.
 */
export async function sendPasswordResetLink(email: string, requestOrigin: string): Promise<void> {
  const client = await db().connect();
  let issued: Awaited<ReturnType<typeof createPasswordReset>> = null;
  try {
    await client.query('BEGIN');
    issued = await createPasswordReset(client, email);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(`[password-reset] Could not issue a link: ${error instanceof Error ? error.message : 'error'}`);
    return;
  } finally { client.release(); }
  if (!issued) return;
  const link = `${publicBaseUrl(requestOrigin)}${RESET_PATH}?ma=${issued.token}`;
  await sendEmail({ to: issued.email, ...passwordResetEmail(issued.displayName, link) });
}

export const resetLinkUsable = (token: string) => isPasswordResetUsable(db(), token);

/** Sets the new password through a link. Returns false when the link no longer works. */
export async function resetPasswordWithLink(token: string, password: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const userId = await consumePasswordReset(client, token, passwordHash);
    await client.query(userId ? 'COMMIT' : 'ROLLBACK');
    return Boolean(userId);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
