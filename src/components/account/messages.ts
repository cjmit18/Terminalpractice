// Plain-language messages for the account API's error codes. Pure, so it is unit tested without a browser.

/** Which form field an error belongs to, so it can be shown next to that field */
export type ErrorField = 'email' | 'password' | 'displayName' | 'age';

interface Known {
  message: string;
  field?: ErrorField;
}

const LINK_EXPIRED: Known = { message: 'This link has expired or was already used. Ask for a new one.' };
const TOO_COMMON: Known = { message: 'That password is too common. Choose something harder to guess.', field: 'password' };
const RATE: Known = { message: 'Too many tries in a short time. Wait a few minutes, then try again.' };

const KNOWN: Record<string, Known> = {
  invalid_credentials: { message: 'That email and password don’t match an account. Check them and try again.' },
  email_taken: { message: 'That email is already used by another account. Try signing in, or reset the password.', field: 'email' },
  invalid_email: { message: 'Enter an email address like name@example.com.', field: 'email' },
  password_too_short: { message: 'Use at least 10 characters.', field: 'password' },
  password_too_long: { message: 'Use 128 characters or fewer.', field: 'password' },
  password_common: TOO_COMMON,
  common_password: TOO_COMMON,
  password_equals_email: { message: 'Your password can’t be the same as your email address.', field: 'password' },
  password_contains_name: { message: 'Your password can’t contain your name, your email address or the site’s name.', field: 'password' },
  invalid_display_name: { message: 'Use a display name between 1 and 50 characters.', field: 'displayName' },
  age_required: { message: 'Confirm that you are 13 or older to create an account.', field: 'age' },
  invalid_token: LINK_EXPIRED,
  token_expired: LINK_EXPIRED,
  rate_limited: RATE,
  not_signed_in: { message: 'You are signed out. Sign in again to continue.' },
  unauthorized: { message: 'You are signed out. Sign in again to continue.' },
  forbidden: { message: 'The request was blocked. Reload the page and try again.' },
  network: { message: 'Could not reach the server. Check your connection and try again.' },
};

/** The plain message for an error, and the field it belongs to when there is one. */
export function describeError(
  code: string,
  status: number,
  serverMessage?: string,
  retryAfterSeconds?: number,
): { message: string; field?: ErrorField } {
  const known = KNOWN[code] ?? (status === 429 ? RATE : undefined);
  if (known) {
    if (known === RATE && retryAfterSeconds && retryAfterSeconds > 0) {
      const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
      return { message: `Too many tries in a short time. Try again in ${minutes === 1 ? '1 minute' : `${minutes} minutes`}.` };
    }
    return known;
  }
  // An error this build does not know yet: the server's own sentence is written for people
  if (serverMessage && serverMessage.length <= 300) return { message: serverMessage.replace(/!+/g, '.') };
  if (status === 401) return KNOWN.not_signed_in;
  if (status === 403) return KNOWN.forbidden;
  if (status === 404) return { message: 'This isn’t available here yet.' };
  if (status === 503) return { message: 'Accounts aren’t available on this site right now. Everything else still works.' };
  if (status >= 500) return { message: 'Something went wrong on the server. Try again in a moment.' };
  return { message: 'That didn’t work. Check what you entered and try again.' };
}

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** The live hint under a new-password field */
export function passwordLengthHint(password: string): string {
  const n = [...password].length;
  if (n === 0) return `Use at least ${PASSWORD_MIN} characters. A few words together work well.`;
  if (n < PASSWORD_MIN) {
    const more = PASSWORD_MIN - n;
    return `${more} more ${more === 1 ? 'character' : 'characters'} needed (at least ${PASSWORD_MIN}).`;
  }
  if (n > PASSWORD_MAX) return `Too long: use ${PASSWORD_MAX} characters or fewer.`;
  return 'Long enough.';
}

/** Client-side check before a new password is sent; the server checks again (common passwords too). */
export function newPasswordError(password: string): string | null {
  const n = [...password].length;
  if (n === 0) return 'Enter a password.';
  if (n < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (n > PASSWORD_MAX) return `Use ${PASSWORD_MAX} characters or fewer.`;
  return null;
}

/**
 * What the forms send as an email: Unicode NFC (so "café" typed with a combining accent is the same
 * address as the precomposed one) and trimmed. The server lowercases and checks again.
 */
export function normalizeEmail(email: string): string {
  return email.normalize('NFC').trim();
}

export function emailError(email: string): string | null {
  const v = normalizeEmail(email);
  if (!v) return 'Enter your email address.';
  // No spaces, invisible format or control characters, or the characters of "Name <address>" forms
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /[\p{Cc}\p{Cf}<>()[\]\\,;:"]/u.test(v)) return KNOWN.invalid_email.message;
  return null;
}

export function displayNameError(name: string): string | null {
  const v = name.trim();
  if (!v) return 'Enter a display name.';
  if ([...v].length > 50) return 'Use 50 characters or fewer.';
  return null;
}
