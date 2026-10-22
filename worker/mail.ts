// Account emails (verification and password reset) through Resend's HTTP API.
// Without RESEND_API_KEY and EMAIL_FROM nothing is sent, and /api/me reports emailSending: false.
import type { ApiDeps, ApiEnv } from './http';

const RESEND_URL = 'https://api.resend.com/emails';

export function emailSendingEnabled(env: ApiEnv): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

interface Message {
  to: string;
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function layout(heading: string, intro: string, button: string, link: string, outro: string): { text: string; html: string } {
  const text = `${heading}\n\n${intro}\n\n${link}\n\n${outro}\n\n-- Terminus CertSim\n`;
  const l = escapeHtml(link);
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2328">
<h1 style="font-size:20px">${escapeHtml(heading)}</h1>
<p>${escapeHtml(intro)}</p>
<p><a href="${l}" style="display:inline-block;padding:10px 16px;background:#1f6feb;color:#fff;text-decoration:none;border-radius:6px">${escapeHtml(button)}</a></p>
<p style="font-size:13px">Or copy this link into your browser:<br><span style="word-break:break-all">${l}</span></p>
<p style="font-size:13px;color:#57606a">${escapeHtml(outro)}</p>
<p style="font-size:13px;color:#57606a">Terminus CertSim</p>
</body></html>`;
  return { text, html };
}

export function verificationEmail(origin: string, to: string, token: string): Message {
  const link = `${origin}/#/account/verify?token=${encodeURIComponent(token)}`;
  return {
    to,
    subject: 'Confirm your email for Terminus CertSim',
    ...layout(
      'Confirm your email address',
      'Open this link to confirm the email address on your Terminus CertSim account. The link works once and expires in 24 hours.',
      'Confirm email',
      link,
      'If you did not create an account or add this address, you can ignore this email.',
    ),
  };
}

export function resetEmail(origin: string, to: string, token: string): Message {
  const link = `${origin}/#/account/reset?token=${encodeURIComponent(token)}`;
  return {
    to,
    subject: 'Reset your Terminus CertSim password',
    ...layout(
      'Reset your password',
      'Someone (hopefully you) asked to reset the password of your Terminus CertSim account. Open this link to choose a new one. It works once and expires in 1 hour. Resetting signs you out everywhere else.',
      'Choose a new password',
      link,
      'If you did not ask for this, ignore this email: your password stays the same.',
    ),
  };
}

/** Sends one email. Returns false when sending is off or Resend refused it; never logs the address. */
export async function sendEmail(env: ApiEnv, deps: ApiDeps, message: Message): Promise<boolean> {
  if (!emailSendingEnabled(env)) return false;
  const res = await deps.fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
  });
  if (!res.ok) {
    console.error('email: Resend answered', res.status);
    return false;
  }
  return true;
}
