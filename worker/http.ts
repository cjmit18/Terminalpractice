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
  /** Sender address for account emails, e.g. "Terminus <accounts@terminuscli.com>" (a var) */
  EMAIL_FROM?: string;
  /** Resend API key (set with `wrangler secret put RESEND_API_KEY`); emails are skipped without it */
  RESEND_API_KEY?: string;
}

export interface ApiDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  /** Keeps work running after the response is sent (ctx.waitUntil). Without it the work is awaited. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export const defaultDeps: ApiDeps = {
  // Wrapped so the platform fetch is never called with a detached `this`
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

// --- Routes --------------------------------------------------------------------------------

export const BODY_LIMIT = 64 * 1024;
/** For the progress sync routes (worker/sync.ts) */
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

/** Thrown by handlers for a JSON error answer: `{ error, message }` with a 4xx status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function errorResponse(err: HttpError): Response {
  return json({ error: err.code, message: err.message }, err.status, err.headers);
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

export function json(body: unknown, status = 200, extra: Record<string, string> | Headers = {}): Response {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}

export function text(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

export function noContent(extra: Record<string, string> | Headers = {}): Response {
  const headers = new Headers(extra);
  headers.set('Cache-Control', 'no-store');
  return new Response(null, { status: 204, headers });
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

/** The client's address as Cloudflare reports it (hashed before it is stored anywhere) */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** Runs work after the response when the platform allows it, otherwise before. Errors are logged, never thrown. */
export async function inBackground(deps: ApiDeps, work: () => Promise<unknown>): Promise<void> {
  const task = work().catch(err => console.error('background task failed:', err instanceof Error ? err.name : 'error'));
  if (deps.waitUntil) deps.waitUntil(task);
  else await task;
}
