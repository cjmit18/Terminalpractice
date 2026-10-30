// Calls for the admin dashboard (#/admin, portal part 9). Same rules as the account calls
// (src/lib/account.ts): JSON only, this site's cookie, plain-language errors.
import { apiBase } from './apiBase';
import type { ApiResult } from './account';
import { describeError } from '../components/account/messages';

export interface AdminStats {
  asOf: number;
  accounts: { total: number; newLast7Days: number; newLast30Days: number; emailConfirmed: number; withPassword: number; withGithub: number };
  activity: { signedInLast7Days: number; liveSessions: number };
  progress: { accountsWithProgress: number; tasksDone: number; lessonsRead: number; quizzesTaken: number };
}

/** One question on the most-missed list: learners who answered it, how many of them missed it, and the answer totals */
export interface MissedQuestion {
  key: string;
  learners: number;
  missedBy: number;
  answered: number;
  missed: number;
}

export interface MostMissed {
  asOf: number;
  learnersSharing: number;
  questions: MissedQuestion[];
}

export interface AdminEntry {
  email: string;
  addedAt: number;
}

const apiUrl = (path: string) =>
  new URL(`api/${path}`, apiBase(import.meta.env.BASE_URL, window.location.origin, document.baseURI)).toString();

async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, code: 'network', ...describeError('network', 0) };
  }
  const data = res.status !== 204 && res.headers.get('Content-Type')?.includes('application/json') ? await res.json().catch(() => null) : null;
  if (res.ok) return { ok: true, status: res.status, data: data as T };
  const err = (data && typeof data === 'object' ? data : {}) as { error?: unknown; message?: unknown };
  const code = typeof err.error === 'string' ? err.error : `http_${res.status}`;
  const { message, field } = describeError(code, res.status, typeof err.message === 'string' ? err.message : undefined);
  return { ok: false, status: res.status, code, message, field };
}

export const getAdminStats = () => call<AdminStats>('GET', 'admin/stats');
export const getMostMissed = () => call<MostMissed>('GET', 'admin/missed');
export const listAdmins = () => call<{ admins: AdminEntry[] }>('GET', 'admin/admins');
export const addAdmin = (email: string) => call<{ ok: true }>('POST', 'admin/admins', { email });
export const removeAdmin = (email: string) => call<unknown>('DELETE', 'admin/admins', { email });
