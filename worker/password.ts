// Password hashing (PBKDF2-SHA256 through WebCrypto) and the password rules.
import { COMMON_PASSWORDS } from './common-passwords';

/** The most Cloudflare Workers allow for PBKDF2 */
export const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

const common = new Set(COMMON_PASSWORDS);

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(value: string): Uint8Array {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, KEY_BYTES * 8);
  return new Uint8Array(bits);
}

/** `pbkdf2$sha256$100000$<salt b64>$<hash b64>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

/** Compares every byte, so the time taken does not depend on where the first difference is */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromB64(parts[3]);
    expected = fromB64(parts[4]);
  } catch {
    return false;
  }
  return constantTimeEqual(await derive(password, salt, iterations), expected);
}

let dummy: Promise<string> | null = null;
/**
 * Spends the same time as a real check when there is no account (or no password) to check against,
 * so response times do not tell whether an email is registered. Always false.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummy ??= hashPassword(crypto.randomUUID());
  await verifyPassword(password, await dummy);
  return false;
}

export interface PasswordProblem {
  code: 'password_too_short' | 'password_too_long' | 'common_password' | 'password_equals_email' | 'password_contains_name';
  message: string;
}

/** Words no password may contain: the site's own names */
const SITE_WORDS = ['terminus', 'certsim'];
/** Personal words shorter than this are not checked as substrings (they would refuse too much) */
const MIN_PERSONAL = 4;

/**
 * Why this password is not allowed (an error code and a plain sentence), or null when it is fine.
 * No composition rules. Refuses the common list, the email itself, and any password containing the
 * site's name, the display name (with or without its spaces) or the email's local part.
 */
export function passwordProblem(password: string, email: string | null, displayName: string | null = null): PasswordProblem | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN) return { code: 'password_too_short', message: `Use at least ${PASSWORD_MIN} characters.` };
  if (length > PASSWORD_MAX) return { code: 'password_too_long', message: `Use at most ${PASSWORD_MAX} characters.` };
  const lower = password.toLowerCase();
  if (common.has(lower)) {
    return { code: 'common_password', message: 'This password is one of the most common ones. Choose something less guessable.' };
  }
  if (email && lower.trim() === email.toLowerCase()) return { code: 'password_equals_email', message: 'Your password cannot be your email address.' };
  const squashed = lower.replace(/\s+/g, '');
  const words = [...SITE_WORDS];
  const local = email ? email.toLowerCase().split('@')[0] : '';
  if (local.length >= MIN_PERSONAL) words.push(local);
  const name = (displayName ?? '').normalize('NFC').trim().toLowerCase();
  if (name.length >= MIN_PERSONAL) words.push(name, name.replace(/\s+/g, ''));
  if (words.some(w => w && (lower.includes(w) || squashed.includes(w.replace(/\s+/g, ''))))) {
    return { code: 'password_contains_name', message: "Your password cannot contain your name, your email address or the site's name." };
  }
  return null;
}
