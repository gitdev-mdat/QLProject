// Local stand-in for Resend's "send email" API, for trying the forgot-password flow without a real email account.
// It accepts the same JSON the app sends to https://api.resend.com/emails and shows each message in a small inbox.
//   node web/e2e/mail-catcher.mjs 3099
// then start the web app with RESEND_API_KEY=local MAIL_FROM='QLead <no-reply@qlead.vn>' RESEND_API_URL=http://127.0.0.1:3099/emails
// and open http://127.0.0.1:3099/ to read what was "sent". Nothing leaves this machine.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 3099);
const mails = [];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const page = (title, body) => `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#eef1f4;color:#1d2329}header{background:#2b3440;color:#fff;padding:12px 16px;font-weight:700}
.list a{display:block;padding:14px 16px;border-bottom:1px solid #dde2e7;background:#fff;color:inherit;text-decoration:none}.list small{color:#6b7580}
.meta{background:#fff;padding:14px 16px;border-bottom:1px solid #dde2e7;line-height:1.6;font-size:14px}.meta b{display:inline-block;min-width:64px;color:#6b7580;font-weight:400}
.meta h1{font-size:18px;margin:0 0 6px}iframe{width:100%;border:0;display:block}</style></head><body>${body}</body></html>`;

createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/emails') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const mail = { ...JSON.parse(body), at: new Date() };
      mails.push(mail);
      console.log(`[mail-catcher] #${mails.length} to ${mail.to} — ${mail.subject}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `local-${mails.length}` }));
    });
    return;
  }
  const one = /^\/mail\/(\d+)$/.exec(req.url ?? '');
  const raw = /^\/mail\/(\d+)\/html$/.exec(req.url ?? '');
  if (raw && mails[raw[1] - 1]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(mails[raw[1] - 1].html.replace('<head>', '<head><base target="_top">').replace(/<body/, m => (/<head>/.test(mails[raw[1] - 1].html) ? '' : '<base target="_top">') + m)); return; }
  if (one && mails[one[1] - 1]) {
    const m = mails[one[1] - 1];
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(m.subject, `<header>Hộp thư thử nghiệm (máy local)</header>
<div class="meta"><h1>${esc(m.subject)}</h1><div><b>Từ</b> ${esc(m.from)}</div><div><b>Đến</b> ${esc(m.to.join(', '))}</div><div><b>Lúc</b> ${m.at.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</div></div>
<iframe src="/mail/${one[1]}/html" onload="this.style.height=this.contentDocument.documentElement.scrollHeight+'px'"></iframe>`));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Hộp thư thử nghiệm', `<header>Hộp thư thử nghiệm (máy local) · ${mails.length} email</header><div class="list">${
    mails.map((m, i) => ({ m, i })).reverse().map(({ m, i }) => `<a href="/mail/${i + 1}"><div><b>${esc(m.subject)}</b></div><small>${esc(m.from)} → ${esc(m.to.join(', '))}</small></a>`).join('') || '<p style="padding:16px">Chưa có email.</p>'}</div>`));
}).listen(port, '127.0.0.1', () => console.log(`[mail-catcher] inbox at http://127.0.0.1:${port}/`));
