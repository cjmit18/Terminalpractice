// Sign in with GitHub (a GitHub App's user authorization, an OAuth 2.0 code flow), or link GitHub to the
// signed-in user with `?link=1`.
import { randomToken, redirect, safeReturn, text, type ApiEnv, type Route, type RouteContext } from '../http';
import { backToApp, callbackUrl, checkState, finishOAuth, planStart, providerFailed, readSavedState, stateCookie, stateMismatch } from './oauth';

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';

export const githubConfigured = (env: ApiEnv) => Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
const notConfigured = () => text('Sign-in with GitHub is not set up on this server yet.', 503);

async function start(c: RouteContext): Promise<Response> {
  if (!githubConfigured(c.env)) return notConfigured();
  const plan = await planStart(c, 'github');
  if (plan instanceof Response) return plan;
  const { mode, returnTo, sessionHash } = plan;

  const state = randomToken();
  const authorize = new URL(GITHUB_AUTHORIZE);
  authorize.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID!);
  // The app's origin (APP_ORIGINS), or the request's when none is configured (previews, localhost)
  authorize.searchParams.set('redirect_uri', callbackUrl(c, 'github'));
  authorize.searchParams.set('state', state);

  return redirect(authorize.toString(), [stateCookie({ state, returnTo, mode, provider: 'github', verifier: '', sessionHash })]);
}

async function callback(c: RouteContext): Promise<Response> {
  const saved = readSavedState(c.request);
  // The learner pressed Cancel on GitHub: go back quietly
  if (c.url.searchParams.get('error')) return backToApp(c, saved?.returnTo ?? safeReturn(null));
  if (!checkState(c, saved, 'github')) return stateMismatch();
  if (!githubConfigured(c.env)) return notConfigured();

  // Exchange the one-time code for a short-lived token, then read the GitHub profile with it.
  // The GitHub token is used once here and never stored.
  const tokenRes = await c.deps.fetch(GITHUB_TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.env.GITHUB_CLIENT_ID!,
      client_secret: c.env.GITHUB_CLIENT_SECRET!,
      code: c.url.searchParams.get('code')!,
      redirect_uri: callbackUrl(c, 'github'),
    }).toString(),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenRes.ok || !token.access_token) return providerFailed('GitHub did not accept this sign-in. Go back to the app and try again.');

  const profileRes = await c.deps.fetch(GITHUB_USER, {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'terminus-certsim',
    },
  });
  const profile = (await profileRes.json().catch(() => ({}))) as { id?: number; login?: string; name?: string | null; avatar_url?: string };
  if (!profileRes.ok || typeof profile.id !== 'number' || !profile.login) {
    return providerFailed('Could not read your GitHub profile. Go back to the app and try again.');
  }

  return finishOAuth(c, saved, {
    provider: 'github',
    providerId: String(profile.id),
    label: profile.login,
    name: (profile.name || profile.login).slice(0, 50),
    avatarUrl: profile.avatar_url ?? null,
  });
}

export const githubRoutes: Route[] = [
  { method: 'GET', path: '/api/auth/github/start', handler: start },
  { method: 'GET', path: '/api/auth/github/callback', handler: callback },
];
