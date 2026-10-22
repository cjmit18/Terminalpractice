// Sends one account email through the SMTP mailbox (Purelymail by default). Cloudflare-only: worker-mailer
// opens a TCP socket with cloudflare:sockets, so only the Worker entry (index.ts) imports this file; Node
// tests pass a fake `sendMail` instead.
import { WorkerMailer } from 'worker-mailer';
import type { ApiEnv, MailMessage } from './http';

export async function smtpSend(env: ApiEnv, message: MailMessage): Promise<void> {
  const port = Number(env.SMTP_PORT || 465);
  await WorkerMailer.send(
    {
      host: env.SMTP_HOST || 'smtp.purelymail.com',
      port,
      // 465 is TLS from the first byte; 587 starts plain and upgrades with STARTTLS (never left plain)
      secure: port === 465,
      startTls: port !== 465,
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
