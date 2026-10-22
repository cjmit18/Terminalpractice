// Sign in with Google: OAuth 2.0 authorization-code flow with `state` and PKCE (S256), scopes
// `openid email profile`. The identity is Google's `sub`; the email is only a label and never merges accounts.
import { base64url, randomToken, safeReturn, text, type ApiEnv, type Route, type RouteContext } from '../http';
import { backToApp, checkState, finishOAuth, linkRefusal, providerFailed, readSavedState, stateCookie, stateMismatch } from './oauth';

export const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

export const googleConfigured = (env: ApiEnv) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const notConfigured = () => text('Sign-in with Google is not set up on this server yet.', 503);
const redirectUri = (c: RouteContext) => `${c.url.origin}/api/auth/google/callback`;

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

async function start(c: RouteContext): Promise<Response> {
  if (!googleConfigured(c.env)) return notConfigured();
  const link = c.url.searchParams.get('link') === '1';
  const refused = await linkRefusal(c, link);
  if (refused) return refused;

  const state = randomToken();
  const verifier = randomToken();
  const returnTo = safeReturn(c.url.searchParams.get('return'));
  const authorize = new URL(GOOGLE_AUTHORIZE);
  authorize.searchParams.set('client_id', c.env.GOOGLE_CLIENT_ID!);
  authorize.searchParams.set('redirect_uri', redirectUri(c));
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'openid email profile');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', await pkceChallenge(verifier));
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('prompt', 'select_account');

  const headers = new Headers({ Location: authorize.toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', stateCookie({ state, returnTo, link, provider: 'google', verifier }));
  return new Response(null, { status: 302, headers });
}

async function callback(c: RouteContext): Promise<Response> {
  const saved = readSavedState(c.request);
  // The learner pressed Cancel on Google: go back quietly
  if (c.url.searchParams.get('error')) return backToApp(c, saved?.returnTo ?? safeReturn(null));
  if (!checkState(c, saved, 'google') || !saved.verifier) return stateMismatch();
  if (!googleConfigured(c.env)) return notConfigured();

  // The Google tokens are used once here and never stored
  const tokenRes = await c.deps.fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      code: c.url.searchParams.get('code')!,
      code_verifier: saved.verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(c),
    }).toString(),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenRes.ok || !token.access_token) return providerFailed('Google did not accept this sign-in. Go back to the app and try again.');

  // The userinfo endpoint, over TLS with Google's own token, saves verifying the ID token's signature here
  const infoRes = await c.deps.fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' } });
  const info = (await infoRes.json().catch(() => ({}))) as { sub?: string; email?: string; name?: string; picture?: string };
  if (!infoRes.ok || typeof info.sub !== 'string' || !info.sub) {
    return providerFailed('Could not read your Google profile. Go back to the app and try again.');
  }

  const email = typeof info.email === 'string' ? info.email : '';
  const name = (typeof info.name === 'string' && info.name.trim()) || email.split('@')[0] || 'Learner';
  return finishOAuth(c, saved, {
    provider: 'google',
    providerId: info.sub,
    label: email || 'Google account',
    name: name.trim().slice(0, 50),
    avatarUrl: typeof info.picture === 'string' ? info.picture : null,
  });
}

export const googleRoutes: Route[] = [
  { method: 'GET', path: '/api/auth/google/start', handler: start },
  { method: 'GET', path: '/api/auth/google/callback', handler: callback },
];
