// Password hashing (PBKDF2-SHA256 through WebCrypto) and the password rules.
//
// Pepper (portal part 10): with the PASSWORD_PEPPER secret set, the PBKDF2 output is put through
// HMAC-SHA256 keyed with it before it is stored, so a copy of the database alone cannot be used to test
// guesses. The HMAC comes after PBKDF2, so a stored hash from before the pepper is upgraded from the hash
// itself, without the password: at the next sign-in and by the daily sweep (pepperStoredHash). The pepper
// costs one HMAC per check, well within the free plan's CPU time; Argon2id would not fit it.
// The pepper cannot be rotated: if it is lost, every peppered password stops working until it is reset.
import { COMMON_PASSWORDS } from './common-passwords';
import type { ApiEnv } from './http';

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

/** Where the pepper comes from: the Worker's env */
export type PasswordPepperEnv = Pick<ApiEnv, 'PASSWORD_PEPPER'>;

/** A pepper shorter than this is not used (and says so once): it would add little and could be guessed */
export const PEPPER_MIN = 32;
let warnedShort = false;

function pepperOf(env: PasswordPepperEnv): string | null {
  const pepper = env.PASSWORD_PEPPER;
  if (!pepper) return null;
  if (pepper.length < PEPPER_MIN) {
    if (!warnedShort) console.warn(`password: PASSWORD_PEPPER is shorter than ${PEPPER_MIN} characters, so it is not used`);
    warnedShort = true;
    return null;
  }
  return pepper;
}

async function hmac(pepper: string, bytes: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes as BufferSource));
}

/** Without a pepper `pbkdf2$sha256$100000$<salt b64>$<hash b64>`; with one, `pbkdf2-hmac$…` and the HMAC of that hash */
export async function hashPassword(password: string, env: PasswordPepperEnv): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  const pepper = pepperOf(env);
  if (!pepper) return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
  return `pbkdf2-hmac$sha256$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(await hmac(pepper, hash))}`;
}

/** A stored hash from before the pepper, upgraded from the hash itself (no password needed); null when there is nothing to do */
export async function pepperStoredHash(stored: string, env: PasswordPepperEnv): Promise<string | null> {
  const pepper = pepperOf(env);
  const parts = stored.split('$');
  if (!pepper || parts.length !== 5 || parts[0] !== 'pbkdf2') return null;
  let hash: Uint8Array;
  try {
    hash = fromB64(parts[4]);
  } catch {
    return null;
  }
  return `pbkdf2-hmac$${parts[1]}$${parts[2]}$${parts[3]}$${toB64(await hmac(pepper, hash))}`;
}

/** Compares every byte, so the time taken does not depend on where the first difference is */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}


/**
 * Stores `upgraded` (pepperStoredHash of `stored`) only while the account still has `stored`: a password
 * change or reset landing in between is never overwritten.
 */
export async function pepperHash(db: ApiEnv['DB'], userId: string, stored: string, upgraded: string): Promise<void> {
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?').bind(upgraded, userId, stored).run();
}

/** Daily sweep: upgrades up to `limit` stored hashes from before the pepper; returns how many it looked at */
export async function pepperStoredHashes(env: Pick<ApiEnv, 'DB' | 'PASSWORD_PEPPER'>, limit = 100): Promise<number> {
  if (!pepperOf(env)) return 0;
  const { results } = await env.DB.prepare("SELECT id, password_hash FROM users WHERE password_hash LIKE 'pbkdf2$%' LIMIT ?")
    .bind(limit)
    .all<{ id: string; password_hash: string }>();
  for (const row of results) {
    const upgraded = await pepperStoredHash(row.password_hash, env);
    if (upgraded) await pepperHash(env.DB, row.id, row.password_hash, upgraded);
  }
  return results.length;
}

export async function verifyPassword(password: string, stored: string, env: PasswordPepperEnv): Promise<boolean> {
  const parts = stored.split('$');
  const peppered = parts[0] === 'pbkdf2-hmac';
  if (parts.length !== 5 || !(peppered || parts[0] === 'pbkdf2') || parts[1] !== 'sha256') return false;
  const pepper = pepperOf(env);
  // A peppered hash cannot be checked without the pepper (it was removed or shortened): every such check fails
  if (peppered && !pepper) return false;
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
  const derived = await derive(password, salt, iterations);
  return constantTimeEqual(peppered ? await hmac(pepper!, derived) : derived, expected);
}

let dummy: Promise<string> | null = null;
/**
 * Spends the same time as a real check when there is no account (or no password) to check against,
 * so response times do not tell whether an email is registered. Always false.
 */
export async function verifyAgainstDummy(password: string, env: PasswordPepperEnv): Promise<false> {
  // Made without the pepper; when one is set the check below adds the same HMAC a peppered check does
  dummy ??= hashPassword(crypto.randomUUID(), {});
  const stored = await dummy;
  await verifyPassword(password, (await pepperStoredHash(stored, env)) ?? stored, env);
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
