// Opt-in most-missed questions (portal part 9c). When the signed-in learner has turned sharing on, each
// checkpoint or review answer is queued here and sent in small batches to POST /api/answers: the
// question's key and whether it was right, nothing else. Off by default; the server keeps the setting,
// so it follows the account to every browser. Best effort: an answer that cannot be sent is dropped,
// and nothing here ever blocks or slows the quiz.
import { useEffect, useSyncExternalStore } from 'react';
import { apiBase } from './apiBase';

/** Sharing for the signed-in account: unknown until the server has answered; `questions` is as of that answer */
export type SharingState = { status: 'unknown' } | { status: 'known'; userId: string; share: boolean; questions: number };

/** Answers per request (the server takes up to 50) and how long the first answer waits for more */
export const BATCH_SIZE = 20;
export const BATCH_DELAY_MS = 5000;

const apiUrl = (path: string) =>
  new URL(`api/${path}`, apiBase(import.meta.env.BASE_URL, window.location.origin, document.baseURI)).toString();

let state: SharingState = { status: 'unknown' };
const listeners = new Set<() => void>();
let queue: { key: string; right: boolean }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
/** The account the queue belongs to */
let current: string | null = null;

function set(next: SharingState): void {
  state = next;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const sharingFor = (userId: string | null) => state.status === 'known' && state.userId === userId && state.share;

/** Forgets the setting and anything queued (signed out, or another account signed in) */
function reset(): void {
  queue = [];
  if (timer) clearTimeout(timer);
  timer = null;
  set({ status: 'unknown' });
}

async function load(userId: string): Promise<void> {
  try {
    const res = await fetch(apiUrl('answers/sharing'), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const data = (await res.json()) as { share?: unknown; questions?: unknown };
    // Still the same account? A sign-out or switch while this was in flight wins
    if (current !== userId) return;
    set({ status: 'known', userId, share: data.share === true, questions: Number(data.questions) || 0 });
  } catch {
    // Offline or no account API: sharing stays unknown, so nothing is sent
  }
}

/** Follows the signed-in account: loads its setting, and drops everything when it changes */
export function useAnswerSharingFor(userId: string | null): void {
  useEffect(() => {
    if (current === userId) return;
    current = userId;
    reset();
    if (userId) void load(userId);
  }, [userId]);
}

/** The signed-in account's sharing setting, for the account page */
export function useAnswerSharing(): SharingState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Turns sharing on or off; off makes the server delete everything this account sent */
export async function setAnswerSharing(share: boolean): Promise<{ ok: true } | { ok: false; status: number }> {
  const userId = current;
  if (!share) queue = [];
  let res: Response;
  try {
    res = await fetch(apiUrl('answers/sharing'), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ share }),
    });
  } catch {
    return { ok: false, status: 0 };
  }
  if (!res.ok) return { ok: false, status: res.status };
  if (userId && current === userId) {
    const questions = share && state.status === 'known' ? state.questions : 0;
    set({ status: 'known', userId, share, questions });
  }
  return { ok: true };
}

/** Queues one answer when the signed-in account shares; `key` is "pathId/questionId" */
export function reportAnswer(userId: string | null, key: string, right: boolean): void {
  if (!userId || !sharingFor(userId)) return;
  queue.push({ key, right });
  if (queue.length >= BATCH_SIZE) void flush();
  else timer ??= setTimeout(() => void flush(), BATCH_DELAY_MS);
}

/** Sends what is queued. `keepalive` lets it finish while the page is closing. */
export async function flush(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const userId = current;
  const batch = queue.splice(0, BATCH_SIZE);
  if (batch.length === 0 || !userId) return;
  if (queue.length > 0) timer = setTimeout(() => void flush(), 0);
  try {
    const res = await fetch(apiUrl('answers'), {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: batch }),
    });
    // Turned off on another device: stop here too
    if (res.status === 409 && current === userId && state.status === 'known') {
      queue = [];
      set({ ...state, share: false, questions: 0 });
    }
  } catch {
    // Dropped: these totals are a guide for improving questions, not a record of anyone's work
  }
}

// Send what is queued when the tab is hidden or closed, instead of waiting for the timer
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
}
