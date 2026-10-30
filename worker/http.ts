// Shared plumbing for the account API: environment and dependency types, routes, JSON bodies,
// cookies, errors and small crypto helpers. Free of Cloudflare-only imports so it runs in Node.

/** The slice of D1 this API uses. Cloudflare's D1Database satisfies it. */
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface Db {
  prepare(sql: string): DbStatement;
}

export interface ApiEnv {
  DB: Db;
  /** Public Client ID of the GitHub App (a var in wrangler.jsonc) */
  GITHUB_CLIENT_ID?: string;
  /** Client secret of the GitHub App (set with `wrangler secret put GITHUB_CLIENT_SECRET`) */
  GITHUB_CLIENT_SECRET?: string;
  /** Public OAuth client ID from Google Cloud (a var in wrangler.jsonc) */
  GOOGLE_CLIENT_ID?: string;
  /** Google OAuth client secret (set with `wrangler secret put GOOGLE_CLIENT_SECRET`) */
  GOOGLE_CLIENT_SECRET?: string;
  /** SMTP server for account emails (a var; default smtp.purelymail.com) */
  SMTP_HOST?: string;
  /** SMTP port (a var): only 465 (TLS from the start) is accepted */
  SMTP_PORT?: string;
  /** SMTP username, the sending mailbox's address, e.g. noreply@terminuscli.com (a var) */
  SMTP_USER?: string;
  /** That mailbox's password (set with `wrangler secret put SMTP_PASSWORD`); emails are skipped without it */
  SMTP_PASSWORD?: string;
  /** Sender address shown on account emails (a var; defaults to SMTP_USER) */
  EMAIL_FROM?: string;
  /** Where replies to account emails go, e.g. a support inbox (a var; optional) */
  REPLY_TO?: string;
  /**
   * Comma-separated origins the app is served from, e.g. "https://terminuscli.com" (a var). Email links
   * and OAuth redirect URIs use the request's origin when it is listed, otherwise the first entry, and
   * only listed origins pass the Origin check. Empty or unset means "the request's own origin" (previews).
   */
  APP_ORIGINS?: string;
  /** Secret key for hashing rate-limit subjects (set with `wrangler secret put RATE_LIMIT_PEPPER`) */
  RATE_LIMIT_PEPPER?: string;
  /**
   * "1" lets rate limits run without RATE_LIMIT_PEPPER, using plain SHA-256 keys. Only for local runs,
   * tests and previews (whose databases hold no real accounts); production must set the pepper instead.
   */
  ALLOW_UNPEPPERED_RATE_LIMITS?: string;
  /**
   * The site owner's email (set as a secret: `wrangler secret put OWNER_EMAIL`, so it stays out of the repo).
   * The account with this confirmed address is the owner: it sees the admin dashboard and adds admins.
   */
  OWNER_EMAIL?: string;
}

export interface ApiDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  /** Keeps work running after the response is sent (ctx.waitUntil). Without it the work is awaited. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Sends one email (worker/smtp.ts in the Worker, a fake in tests). Without it no email is sent. */
  sendMail?: (env: ApiEnv, message: MailMessage) => Promise<void>;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export const defaultDeps: ApiDeps = {
  // Wrapped so the platform fetch is never called with a detached `this`
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

// --- Routes --------------------------------------------------------------------------------

export const BODY_LIMIT = 64 * 1024;
/** Progress uploads may be larger (up to SYNC_LIMITS.itemsPerRequest items at once) */
export const SYNC_BODY_LIMIT = 512 * 1024;

export interface RouteContext {
  request: Request;
  url: URL;
  env: ApiEnv;
  deps: ApiDeps;
  /** Named groups of the route's path pattern */
  params: Record<string, string>;
  /** The JSON object body, size-capped; throws 413 / 415 / 400 as an HttpError */
  body(): Promise<Record<string, unknown>>;
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** An exact path, or a regex with named groups for parameters */
  path: string | RegExp;
  handler: (c: RouteContext) => Promise<Response> | Response;
  /** Body size cap in bytes (default BODY_LIMIT) */
  bodyLimit?: number;
}

/** Thrown by handlers for a JSON error answer: `{ error, message, ...extra }` with a 4xx status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
    /** More fields for the error body, e.g. `providers` on reauth_required */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function errorResponse(err: HttpError): Response {
  return json({ ...err.extra, error: err.code, message: err.message }, err.status, err.headers);
}

/** Reads the body as text, never more than `limit` bytes, whether or not Content-Length was sent. */
export async function readBodyText(request: Request, limit: number): Promise<string> {
  const tooLarge = () => new HttpError(413, 'payload_too_large', 'This request is too large.');
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > limit) throw tooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function readJsonObject(request: Request, limit: number): Promise<Record<string, unknown>> {
  const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Send the request as JSON.');
  const raw = await readBodyText(request, limit);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_request', 'The request body is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_request', 'The request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

/** A required string field, or a 400 */
export function str(body: Record<string, unknown>, key: string, max = 1024): string {
  const v = body[key];
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, 'invalid_request', `The field "${key}" is missing or invalid.`);
  return v;
}

/** An optional string field (undefined or null when absent), or a 400 when it has the wrong type */
export function optStr(body: Record<string, unknown>, key: string, max = 1024): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  return str(body, key, max);
}

// --- Responses -----------------------------------------------------------------------------

/** Headers on every API answer: no MIME sniffing, no Referer, never framed */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

/** Adds SECURITY_HEADERS and Cache-Control: no-store to a set of headers */
export function secureHeaders(extra: Record<string, string> | Headers = {}): Headers {
  const headers = new Headers(extra);
  headers.set('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return headers;
}

export function json(body: unknown, status = 200, extra: Record<string, string> | Headers = {}): Response {
  const headers = secureHeaders(extra);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

export function text(body: string, status: number, extra: Record<string, string> = {}): Response {
  const headers = secureHeaders(extra);
  if (!('Content-Type' in extra)) headers.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(body, { status, headers });
}

export function noContent(extra: Record<string, string> | Headers = {}): Response {
  return new Response(null, { status: 204, headers: secureHeaders(extra) });
}

/** A 302 to `location` with the API's headers; `cookies` become Set-Cookie headers */
export function redirect(location: string, cookies: string[] = []): Response {
  const headers = secureHeaders({ Location: location });
  for (const v of cookies) headers.append('Set-Cookie', v);
  return new Response(null, { status: 302, headers });
}

// --- Cookies -------------------------------------------------------------------------------

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  // __Host- cookies must be Secure, have Path=/ and no Domain: they stay on this exact host
  return `${name}=${value}; Path=/; Max-Age=${Math.floor(maxAgeSeconds)}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

// --- Misc ----------------------------------------------------------------------------------

export const DEFAULT_RETURN = '#/learn';

/** Only in-app hash routes are allowed as a place to return to, so a callback cannot redirect elsewhere. */
export function safeReturn(value: string | null): string {
  return value && /^#\/[A-Za-z0-9\-_/.]*$/.test(value) && !value.includes('..') ? value : DEFAULT_RETURN;
}

/** SQLite's (and so D1's) error for a database that lacks the account schema (no migrations applied) */
export function isMissingSchema(err: unknown): boolean {
  return err instanceof Error && /no such (table|column)/i.test(err.message);
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(err.message);
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes, base64url: session tokens, one-time tokens, OAuth state and PKCE verifiers */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The client's address as Cloudflare reports it. Only CF-Connecting-IP is trusted (never X-Forwarded-For). */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/**
 * The rate-limit subject for the client's address: an IPv4 address as is, an IPv6 address by its /64
 * prefix (one host usually holds a whole /64, so per-address keys would be trivial to rotate).
 * IPv4-mapped IPv6 (::ffff:a.b.c.d) counts as the IPv4 address. Hashed before it is stored.
 */
export function ipSubject(request: Request): string {
  const ip = clientIp(request).trim().toLowerCase();
  if (!ip.includes(':')) return ip;
  const groups = expandIpv6(ip);
  if (!groups) return ip;
  if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
  }
  return `${groups.slice(0, 4).map(g => g.toString(16)).join(':')}::/64`;
}

/** The eight 16-bit groups of an IPv6 address (with an optional embedded IPv4 tail), or null when malformed */
export function expandIpv6(value: string): number[] | null {
  let ip = value.replace(/%.*$/, ''); // zone id
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const b = v4.slice(1).map(Number);
    if (b.some(x => x > 255)) return null;
    ip = ip.slice(0, v4.index) + `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':') : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (all.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map(g => parseInt(g, 16));
}

/** The configured app origins (APP_ORIGINS), without trailing slashes; empty when unset */
export function appOrigins(env: ApiEnv): string[] {
  return (env.APP_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** The origin for links in emails and OAuth redirect URIs: the request's when allowlisted, else the first listed */
export function appOrigin(c: Pick<RouteContext, 'env' | 'url'>): string {
  const list = appOrigins(c.env);
  if (list.length === 0 || list.includes(c.url.origin)) return c.url.origin;
  return list[0];
}

/** Whether an Origin header may make state-changing requests: listed in APP_ORIGINS, or the request's own when the list is empty */
export function originAllowed(env: ApiEnv, url: URL, origin: string | null): boolean {
  if (!origin) return false;
  const list = appOrigins(env);
  return list.length === 0 ? origin === url.origin : list.includes(origin);
}

/** Runs work after the response when the platform allows it, otherwise before. Errors are logged, never thrown. */
export async function inBackground(deps: ApiDeps, work: () => Promise<unknown>): Promise<void> {
  const task = work().catch(err => console.error('background task failed:', err instanceof Error ? err.name : 'error'));
  if (deps.waitUntil) deps.waitUntil(task);
  else await task;
}
