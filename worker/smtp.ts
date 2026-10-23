// Sends one account email through the SMTP mailbox (Purelymail by default). Cloudflare-only: worker-mailer
// opens a TCP socket with cloudflare:sockets, so only the Worker entry (index.ts) imports this file; Node
// tests pass a fake `sendMail` instead.
import { LogLevel, WorkerMailer } from 'worker-mailer';
import type { ApiEnv, MailMessage } from './http';

export async function smtpSend(env: ApiEnv, message: MailMessage): Promise<void> {
  // Only implicit TLS (465): with STARTTLS (587) the library falls back to plain text when the server does
  // not offer the upgrade, so someone on the path could strip it and read the mailbox password
  const port = Number(env.SMTP_PORT || 465);
  if (port !== 465) throw new Error('SMTP_PORT must be 465 (TLS from the start)');
  await WorkerMailer.send(
    {
      host: env.SMTP_HOST || 'smtp.purelymail.com',
      port,
      secure: true,
      startTls: false,
      // The library logs each SMTP line at its default level, recipient addresses included
      logLevel: LogLevel.NONE,
      credentials: { username: env.SMTP_USER!, password: env.SMTP_PASSWORD! },
      authType: 'plain',
      socketTimeoutMs: 10_000,
      responseTimeoutMs: 10_000,
    },
    {
      from: { name: 'Terminus CertSim', email: env.EMAIL_FROM || env.SMTP_USER! },
      to: message.to,
      reply: env.REPLY_TO || undefined,
      subject: message.subject,
      text: message.text,
      html: message.html,
    },
  );
}
