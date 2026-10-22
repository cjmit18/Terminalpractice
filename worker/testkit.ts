// Shared test setup for the account API: Node's SQLite standing in for D1 with every migration applied,
// a fake clock, a fake mailer that records what it was asked to send, and request helpers.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleApi, type ApiEnv, type Db, type DbStatement } from './api.ts';
import type { ApiDeps, MailMessage } from './http.ts';

export const ORIGIN = 'https://terminuscli.com';
export const PASSWORD = 'correct horse battery staple';

export function testDb(): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const statement = (sql: string, values: unknown[] = []): DbStatement => ({
    bind: (...v) => statement(sql, v),
    first: async <T,>() => (raw.prepare(sql).get(...(values as never[])) as T | undefined) ?? null,
    all: async <T,>() => ({ results: raw.prepare(sql).all(...(values as never[])) as T[] }),
    run: async () => raw.prepare(sql).run(...(values as never[])),
  });
  return { raw, prepare: sql => statement(sql) };
}

export const MAIL_ENV: Partial<ApiEnv> = { SMTP_USER: 'no-reply@terminuscli.com', SMTP_PASSWORD: 'test-only' };

export function setup(overrides: Partial<ApiEnv> = {}, opts: { failMail?: boolean } = {}) {
  let now = Date.UTC(2026, 9, 23);
  const db = testDb();
  const env: ApiEnv = { DB: db, RATE_LIMIT_PEPPER: 'test-pepper', ...MAIL_ENV, ...overrides };
  const sent: MailMessage[] = [];
  const deps: ApiDeps = {
    fetch: async () => new Response('unexpected', { status: 500 }),
    now: () => now,
    sendMail: async (_env, message) => {
      if (opts.failMail) throw new Error('SMTP down');
      sent.push(message);
    },
  };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handleApi(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      deps,
    ).then(r => r!);
  const register = (fields: Record<string, unknown> = {}, headers?: Record<string, string>) =>
    call('POST', '/api/auth/email/register', { email: 'Learner@Example.com', password: PASSWORD, displayName: 'Learner', ageConfirmed: true, ...fields }, headers);
  const login = (email = 'learner@example.com', password = PASSWORD, headers?: Record<string, string>) =>
    call('POST', '/api/auth/email/login', { email, password }, headers);
  return { db, env, sent, call, register, login, advance: (ms: number) => (now += ms) };
}

export const sessionOf = (res: Response) => /__Host-session=([^;]*)/.exec(res.headers.get('Set-Cookie') ?? '')?.[1] ?? null;
export const count = (db: { raw: DatabaseSync }, table: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
/** The token in the link of a sent email */
export const tokenIn = (message: MailMessage) => decodeURIComponent(/token=([^\s"&<]+)/.exec(message.text)?.[1] ?? '');
