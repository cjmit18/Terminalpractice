// Account emails (verification and password reset): their wording, and sending them through the
// SMTP mailbox (worker/smtp.ts, Purelymail). Without SMTP_USER and SMTP_PASSWORD nothing is sent.
import type { ApiDeps, ApiEnv, MailMessage } from './http';

export function emailSendingEnabled(env: ApiEnv, deps: ApiDeps): boolean {
  return Boolean(deps.sendMail && env.SMTP_USER && env.SMTP_PASSWORD);
}

type Message = MailMessage;

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

/** "in 23 hours", "in 1 hour", "in less than an hour": rounded down, so the email never promises more time than there is */
export function expiresInText(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'in less than an hour';
  return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
}

/** `expiresIn`: how long the link works (ms), which a resend shortens to what is left of the address claim */
export function verificationEmail(origin: string, to: string, token: string, expiresIn = 24 * 3_600_000): Message {
  const link = `${origin}/#/account/verify?token=${encodeURIComponent(token)}`;
  return {
    to,
    subject: 'Confirm your email for Terminus CertSim',
    ...layout(
      'Confirm your email address',
      `Open this link to confirm the email address on your Terminus CertSim account. The link works once and expires ${expiresInText(expiresIn)}.`,
      'Confirm email',
      link,
      'If you did not create an account with this address, ignore this email and do not open the link.',
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

/** Sends one email. Returns false when sending is off or the server refused it; never logs the address. */
export async function sendEmail(env: ApiEnv, deps: ApiDeps, message: Message): Promise<boolean> {
  if (!emailSendingEnabled(env, deps)) return false;
  try {
    await deps.sendMail!(env, message);
    return true;
  } catch (err) {
    console.error('email: sending failed', err instanceof Error ? err.name : 'error');
    return false;
  }
}
