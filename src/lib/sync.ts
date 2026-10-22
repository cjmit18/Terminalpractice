// Progress sync for signed-in learners (docs/LOGIN_PLAN.md, "Syncing progress"). Signed out, none of
// this runs and the app keeps its progress in this browser exactly as before.
//
// - Ownership: signed-out progress stays under the existing keys; each account has its own keys,
//   `certsim:acct:<userId>:progress|journey|activity|queue`. Signing in switches the app to the
//   account's keys (useSyncedStorage follows the key), filled from the server. Signing out removes
//   them, so the next person on a shared computer starts from the signed-out data.
// - Signed-out progress is never uploaded on its own: ImportPrompt asks once per account, and only
//   "Add" copies it into the account.
// - Changes save locally first, as always; the engine then uploads what the server does not have yet,
//   after a short debounce. Offline, nothing is lost: what is missing on the server is worked out
//   again from the local records on the next attempt.
// - Every request carries the account it was started for and that account's AbortController; a
//   response that arrives after a switch is dropped.
// The merge and epoch rules themselves are in syncRules.ts, shared with the Worker.
import { createElement, useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { apiBase } from './apiBase';
import { SIGNED_OUT_EVENT, announceSignedOut, type AccountState } from './account';
import { readStorage, writeStorage } from './storage';
import type { SyncedCodec } from './syncedStorage';
import { PROGRESS_KEY, completeObjective, resetModules, type ProgressRecord } from './progress';
import { JOURNEY_KEY, markRead, recordQuizScore, resetPath, type Journey } from './journey';
import { ACTIVITY_KEY, mergeActivity, type Activity } from './activity';
import type { ThemeChoice } from './theme';
import {
  AccountGate,
  SYNC_LIMITS,
  epochOf,
  isItemKey,
  pendingUploads,
  sanitizeEpochs,
  sanitizeItems,
  sanitizeSettings,
  stableJson,
  staleScopes,
  type Epochs,
  type LocalItem,
  type PrefsSetting,
  type SettingField,
  type SyncItem,
  type SyncSettings,
  type ThemeSetting,
} from './syncRules';

export { labScope, pathScope } from './syncRules';

// ---------- Storage keys ----------

/** The account this browser is signed in to, so the app opens on its data before /api/me answers */
export const ACCOUNT_KEY = 'certsim:account';
/** Accounts already asked about importing this browser's progress (hashed ids) */
export const IMPORT_ASKED_KEY = 'certsim:import-asked:v1';

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isUserId = (v: unknown): v is string => typeof v === 'string' && USER_ID.test(v);

export interface StorageKeys {
  progress: string;
  journey: string;
  activity: string;
  /** The account's sync state; null signed out */
  queue: string | null;
}

export const accountPrefix = (userId: string) => `certsim:acct:${userId}:`;

export function accountKeys(userId: string): Required<{ [K in keyof StorageKeys]: string }> {
  const p = accountPrefix(userId);
  return { progress: `${p}progress`, journey: `${p}journey`, activity: `${p}activity`, queue: `${p}queue` };
}

/** Where the app keeps its records: the account's keys when signed in, the signed-out keys otherwise */
export function storageKeys(userId: string | null): StorageKeys {
  return userId ? accountKeys(userId) : { progress: PROGRESS_KEY, journey: JOURNEY_KEY, activity: ACTIVITY_KEY, queue: null };
}

/** Key-value storage as the engine sees it (localStorage in the app, a Map in tests) */
export interface KeyStore {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
  keys(): string[];
}

const browserStore: KeyStore = {
  get: readStorage,
  set: writeStorage,
  keys: () => {
    try {
      return Object.keys(window.localStorage);
    } catch {
      return [];
    }
  },
};

/** Remove every key of this account from the browser (the server keeps the data) */
export function clearAccountKeys(userId: string, store: KeyStore = browserStore): void {
  const prefix = accountPrefix(userId);
  for (const k of new Set([...Object.values(accountKeys(userId)), ...store.keys().filter(k => k.startsWith(prefix))])) store.set(k, null);
}

// ---------- The account's sync state (the queue key) ----------

export interface QueueState {
  /** The server's state has been downloaded at least once */
  ready: boolean;
  /** Epochs as this device knows them (raised at once by a local reset) */
  epochs: Epochs;
  /** The server's items as last received */
  items: SyncItem[];
  /** The server's settings as last received */
  settings: SyncSettings;
  /** Resets not sent yet: the scope and the epoch it had when it was reset here */
  resets: { scope: string; epoch: number }[];
  lastSyncedAt: number | null;
}

const EMPTY_QUEUE: QueueState = { ready: false, epochs: {}, items: [], settings: {}, resets: [], lastSyncedAt: null };

export function parseQueue(text: string | null): QueueState {
  if (!text) return EMPTY_QUEUE;
  try {
    const r = JSON.parse(text) as Record<string, unknown>;
    const resets = Array.isArray(r.resets)
      ? r.resets.flatMap(x => {
          const e = sanitizeEpochs({ [(x as { scope?: string })?.scope ?? '']: (x as { epoch?: number })?.epoch });
          return Object.entries(e).map(([scope, epoch]) => ({ scope, epoch }));
        })
      : [];
    return {
      ready: r.ready === true,
      epochs: sanitizeEpochs(r.epochs),
      items: sanitizeItems(r.items, SYNC_LIMITS.storedItems).items,
      settings: sanitizeSettings(r.settings) ?? {},
      resets,
      lastSyncedAt: typeof r.lastSyncedAt === 'number' && r.lastSyncedAt > 0 ? r.lastSyncedAt : null,
    };
  } catch {
    return EMPTY_QUEUE;
  }
}

// ---------- Local records <-> items and settings ----------

/** The items a device holds: objectives done, lessons read, quiz scores */
export function itemsFromRecords(progress: ProgressRecord, journey: Journey): LocalItem[] {
  const out: LocalItem[] = [];
  for (const [moduleId, ids] of Object.entries(progress.done)) for (const id of ids) out.push({ kind: 'objective', key: `${moduleId}/${id}` });
  for (const key of journey.read) out.push({ kind: 'lesson', key });
  for (const [key, s] of Object.entries(journey.quiz)) out.push({ kind: 'quiz', key, correct: s.correct, total: s.total });
  return out.filter(i => isItemKey(i.key));
}

const scopeIds = (stale: string[], prefix: string) => stale.filter(s => s.startsWith(prefix)).map(s => s.slice(prefix.length));
const split = (key: string) => [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)] as const;

/** Lab progress after a download: scopes reset elsewhere are cleared (with a tombstone), then the server's objectives are added */
export function applyToProgress(r: ProgressRecord, stale: string[], items: SyncItem[], now: number): ProgressRecord {
  const mods = scopeIds(stale, 'lab:');
  let out = mods.length ? resetModules(r, mods, now) : r;
  for (const i of items) if (i.kind === 'objective') out = completeObjective(out, ...split(i.key));
  return out;
}

/** The journey after a download: paths reset elsewhere are cleared, then lessons and best scores are added */
export function applyToJourney(j: Journey, stale: string[], items: SyncItem[], now: number): Journey {
  let out = j;
  for (const pathId of scopeIds(stale, 'path:')) out = resetPath(out, pathId, now);
  for (const i of items) {
    if (i.kind === 'lesson') out = markRead(out, ...split(i.key));
    else if (i.kind === 'quiz' && i.total) out = recordQuizScore(out, ...split(i.key), { correct: i.correct ?? 0, total: i.total });
  }
  return out;
}

/** The synced settings as an activity record, to merge into the local one with mergeActivity */
export function activityFromSettings(s: SyncSettings): Activity {
  const a: Activity = { facts: [], days: [], badges: s.badges?.value ?? {} };
  if (s.prefs) {
    a.prefs = s.prefs.value;
    a.prefsAt = s.prefs.updatedAt;
  }
  if (s.cleared) a.clearedAt = s.cleared.value;
  if (s.practice) a.practice = s.practice.value;
  if (s.goalWeeks) a.goalWeeks = s.goalWeeks.value;
  return a;
}

export interface LocalSettings {
  prefs?: SettingField<PrefsSetting>;
  theme: ThemeSetting;
  badges: Record<string, number>;
  practice: string[];
  goalWeeks: string[];
  cleared?: number;
}

export function settingsFromLocal(a: Activity, theme: ThemeChoice): LocalSettings {
  return {
    prefs: a.prefs ? { value: a.prefs, updatedAt: a.prefsAt ?? 0 } : undefined,
    theme,
    badges: a.badges,
    practice: a.practice ?? [],
    goalWeeks: a.goalWeeks ?? [],
    cleared: a.clearedAt,
  };
}

const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** The settings fields that changed here since the server's copy, each stamped with when */
export function settingsDelta(local: LocalSettings, known: SyncSettings, now: number): SyncSettings {
  const out: SyncSettings = {};
  if (local.prefs && !same(local.prefs.value, known.prefs?.value)) out.prefs = { value: local.prefs.value, updatedAt: local.prefs.updatedAt || now };
  if (local.theme !== (known.theme?.value ?? 'system')) out.theme = { value: local.theme, updatedAt: now };
  if (!same(local.badges, known.badges?.value ?? {})) out.badges = { value: local.badges, updatedAt: now };
  if (!same([...local.practice].sort(), known.practice?.value ?? [])) out.practice = { value: [...local.practice].sort(), updatedAt: now };
  if (!same([...local.goalWeeks].sort(), known.goalWeeks?.value ?? [])) out.goalWeeks = { value: [...local.goalWeeks].sort(), updatedAt: now };
  if (local.cleared && local.cleared !== known.cleared?.value) out.cleared = { value: local.cleared, updatedAt: local.cleared };
  return out;
}

// ---------- The engine ----------

export type SyncStatus = 'off' | 'syncing' | 'synced' | 'offline' | 'error';

/** What the engine needs from the app: its local data, and a way to put the server's into it */
export interface SyncAdapter {
  localItems(): LocalItem[];
  localSettings(): LocalSettings;
  /**
   * Clear the stale scopes, add the server's items, merge its settings; `theme` is set when the
   * account's theme should apply here. False when the app has moved on to another account.
   * Afterwards localItems and localSettings must already include what was applied.
   */
  apply(update: { stale: string[]; items: SyncItem[]; settings: SyncSettings; theme: ThemeSetting | null }): boolean;
  /** True when this browser has signed-out progress worth offering to add */
  hasSignedOutProgress(): boolean;
  /** Copy the signed-out progress into the account's records */
  importSignedOut(): void;
}

export interface SyncDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  store: KeyStore;
  now: () => number;
  url: (path: string) => string;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
}

export interface SyncSnapshot {
  status: SyncStatus;
  lastSyncedAt: number | null;
  /** Signed in, this browser has signed-out progress, and this account was not asked yet */
  importOffered: boolean;
}

/** Wait after a local change before uploading, so a burst of changes is one request */
export const UPLOAD_DEBOUNCE_MS = 1200;
const RETRY_MS = 30_000;

/** A short, one-way tag for an account id (what IMPORT_ASKED_KEY stores) */
function tag(userId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) h = Math.imul(h ^ userId.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export class SyncEngine {
  private gate = new AccountGate();
  private controller: AbortController | null = null;
  private adapter: SyncAdapter | null = null;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private again = false;
  private pullWanted = false;
  private snapshot: SyncSnapshot = { status: 'off', lastSyncedAt: null, importOffered: false };
  private listeners = new Set<() => void>();
  /** Called when the server no longer knows the session (401) */
  onUnauthorized: () => void = () => {};

  constructor(private deps: SyncDeps) {}

  get userId(): string | null {
    return this.gate.userId;
  }

  // --- status, for useSync ---
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = (): SyncSnapshot => this.snapshot;
  private set(patch: Partial<SyncSnapshot>) {
    const next = { ...this.snapshot, ...patch };
    if (next.status === this.snapshot.status && next.lastSyncedAt === this.snapshot.lastSyncedAt && next.importOffered === this.snapshot.importOffered) return;
    this.snapshot = next;
    for (const fn of this.listeners) fn();
  }

  // --- lifecycle ---

  /** Sync this account with the app's data. Switching accounts aborts what the previous one had in flight. */
  start(userId: string, adapter: SyncAdapter): void {
    if (this.gate.userId === userId) {
      this.adapter = adapter;
      return;
    }
    this.stop();
    this.adapter = adapter;
    this.gate.switchTo(userId);
    this.controller = new AbortController();
    const q = this.queue(userId);
    this.set({ status: 'syncing', lastSyncedAt: q.lastSyncedAt, importOffered: this.importOffered() });
    void this.run(true);
  }

  /** Stop syncing (signed out): requests in flight are aborted and their answers ignored. */
  stop(): void {
    this.gate.switchTo(null);
    this.controller?.abort();
    this.controller = null;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.adapter = null;
    this.set({ status: 'off', lastSyncedAt: null, importOffered: false });
  }

  /** Something changed locally: upload it soon */
  changed(): void {
    if (this.gate.userId) this.schedule(UPLOAD_DEBOUNCE_MS, false);
  }

  /** Download now too (the app came back online or into view) */
  pull(): void {
    if (this.gate.userId) this.schedule(0, true);
  }

  syncNow(): Promise<void> {
    if (!this.gate.userId) return Promise.resolve();
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    return this.run(true);
  }

  /**
   * Local resets of these scopes (a track's labs, a path). The scope's epoch goes up here at once,
   * so work done after the reset is stamped with the new epoch even before the reset reaches the
   * server; the reset itself is sent before any upload.
   */
  reset(scopes: string[]): void {
    const userId = this.gate.userId;
    if (!userId) return;
    const q = this.queue(userId);
    const pending = new Set(q.resets.map(r => r.scope));
    const fresh = [...new Set(scopes)].filter(s => !pending.has(s));
    if (fresh.length === 0) return;
    const epochs = { ...q.epochs };
    const resets = [...q.resets];
    for (const s of fresh) {
      resets.push({ scope: s, epoch: epochOf(q.epochs, s) });
      epochs[s] = epochOf(q.epochs, s) + 1;
    }
    this.writeQueue(userId, { ...q, epochs, resets, items: q.items.filter(i => !fresh.includes(i.scope)) });
    this.schedule(UPLOAD_DEBOUNCE_MS, false);
  }

  /** "Add": copy this browser's signed-out progress into the account, then upload it */
  importLocal(): Promise<void> {
    const userId = this.gate.userId;
    if (!userId || !this.adapter) return Promise.resolve();
    this.adapter.importSignedOut();
    this.markAsked(userId);
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    return this.run(false);
  }

  /** "Not now": do not ask this account again in this browser */
  dismissImport(): void {
    const userId = this.gate.userId;
    if (userId) this.markAsked(userId);
  }

  // --- internals ---

  private asked(): string[] {
    try {
      const v = JSON.parse(this.deps.store.get(IMPORT_ASKED_KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private importOffered(): boolean {
    const userId = this.gate.userId;
    if (!userId || !this.adapter || this.asked().includes(tag(userId))) return false;
    return this.adapter.hasSignedOutProgress();
  }

  private markAsked(userId: string) {
    const list = this.asked();
    if (!list.includes(tag(userId))) this.deps.store.set(IMPORT_ASKED_KEY, JSON.stringify([...list, tag(userId)].slice(-50)));
    this.set({ importOffered: false });
  }

  private queue(userId: string): QueueState {
    return parseQueue(this.deps.store.get(accountKeys(userId).queue));
  }

  private writeQueue(userId: string, q: QueueState) {
    this.deps.store.set(accountKeys(userId).queue, JSON.stringify(q));
  }

  private schedule(ms: number, pull: boolean) {
    this.pullWanted ||= pull;
    if (this.timer !== null) {
      if (ms > 0) return;
      this.deps.clearTimer(this.timer);
    }
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.run(false);
    }, ms);
  }

  private run(pull: boolean): Promise<void> {
    this.pullWanted ||= pull;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const loop = async () => {
      do {
        this.again = false;
        const p = this.pullWanted;
        this.pullWanted = false;
        await this.cycle(p);
      } while (this.again && this.gate.userId);
    };
    this.running = loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** One round: first download, pending resets, then upload what is missing (or just download) */
  private async cycle(pull: boolean): Promise<void> {
    const t = this.gate.ticket();
    const userId = t.userId;
    if (!userId || !this.adapter) return;

    let q = this.queue(userId);
    if (!q.ready) {
      const body = await this.request(t, 'GET', 'progress');
      if (!body || !this.applyResponse(t, body, true)) return;
      q = this.queue(userId);
      pull = false;
    }

    if (q.resets.length > 0) {
      const sent = q.resets.slice(0, SYNC_LIMITS.resetsPerRequest);
      const body = await this.request(t, 'POST', 'progress/reset', { resets: sent });
      if (!body) return;
      const server = sanitizeEpochs((body as { epochs?: unknown }).epochs);
      q = this.queue(userId);
      const done = new Set(sent.map(r => `${r.scope}|${r.epoch}`));
      const resets = q.resets.filter(r => !done.has(`${r.scope}|${r.epoch}`));
      const epochs = { ...q.epochs, ...server };
      for (const r of resets) epochs[r.scope] = Math.max(epochOf(epochs, r.scope), r.epoch + 1);
      this.writeQueue(userId, { ...q, resets, epochs, items: q.items.filter(i => i.epoch >= epochOf(epochs, i.scope)) });
      q = this.queue(userId);
      if (resets.length > 0) this.again = true;
    }

    const now = this.deps.now();
    const uploads = pendingUploads(this.adapter.localItems(), q.items, q.epochs, now);
    const settings = settingsDelta(this.adapter.localSettings(), q.settings, now);
    let body: unknown = null;
    if (uploads.length > 0 || Object.keys(settings).length > 0) {
      const items = uploads.slice(0, SYNC_LIMITS.itemsPerRequest);
      if (uploads.length > items.length) this.again = true;
      body = await this.request(t, 'PUT', 'progress', { items, epochs: q.epochs, settings });
    } else if (pull) {
      body = await this.request(t, 'GET', 'progress');
    } else {
      if (this.snapshot.status === 'syncing') this.set({ status: 'synced' });
      return;
    }
    if (body) this.applyResponse(t, body, false);
  }

  /** Put the server's answer into the app and the queue. False when it came too late (account switched). */
  private applyResponse(t: { userId: string | null; gen: number }, body: unknown, initial: boolean): boolean {
    if (!this.gate.isCurrent(t) || !this.adapter || !t.userId) return false;
    const b = (body ?? {}) as Record<string, unknown>;
    const q = this.queue(t.userId);
    const server = sanitizeEpochs(b.epochs);
    const pending = new Set(q.resets.map(r => r.scope));
    // A scope reset here but not sent yet keeps its raised epoch, and the server's items there are about to go
    const epochs = { ...server };
    for (const r of q.resets) epochs[r.scope] = Math.max(epochOf(server, r.scope), r.epoch + 1);
    // Before the first download nothing here is stale: this account's local data can only be work
    // done in this browser since signing in, so it is uploaded under the server's current epochs
    const stale = q.ready ? staleScopes(q.epochs, server).filter(s => !pending.has(s)) : [];
    const items = sanitizeItems(b.items, SYNC_LIMITS.storedItems).items.filter(i => !pending.has(i.scope) && i.epoch >= epochOf(epochs, i.scope));
    const settings = sanitizeSettings(b.settings) ?? {};
    const known = q.settings.theme;
    const theme = settings.theme && (initial || !known || settings.theme.updatedAt > known.updatedAt) ? settings.theme.value : null;
    if (!this.adapter.apply({ stale, items, settings, theme })) return false;
    const lastSyncedAt = this.deps.now();
    this.writeQueue(t.userId, { ready: true, epochs, items, settings, resets: q.resets, lastSyncedAt });
    this.set({ status: 'synced', lastSyncedAt, importOffered: this.importOffered() });
    return true;
  }

  private async request(t: { userId: string | null; gen: number }, method: string, path: string, body?: unknown): Promise<unknown> {
    const signal = this.controller?.signal;
    if (!signal || !this.gate.isCurrent(t)) return null;
    this.set({ status: 'syncing' });
    let res: Response;
    try {
      res = await this.deps.fetch(this.deps.url(path), {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch {
      if (!this.gate.isCurrent(t)) return null;
      // No connection: try again later (an `online` event also brings it forward)
      this.set({ status: 'offline' });
      this.retryLater();
      return null;
    }
    // The account changed while this was on its way: drop the answer
    if (!this.gate.isCurrent(t)) return null;
    if (res.status === 401) {
      this.onUnauthorized();
      return null;
    }
    if (!res.ok) {
      this.set({ status: 'error' });
      if (res.status >= 500 || res.status === 409 || res.status === 429) this.retryLater();
      return null;
    }
    const data = await res.json().catch(() => null);
    if (!this.gate.isCurrent(t)) return null;
    if (data === null) this.set({ status: 'error' });
    return data;
  }

  private retryLater() {
    if (this.timer === null) this.schedule(RETRY_MS, true);
  }
}

// ---------- The app's engine and hooks ----------

const apiUrl = (path: string) =>
  new URL(`api/${path}`, apiBase(import.meta.env.BASE_URL, window.location.origin, document.baseURI)).toString();

let engine: SyncEngine | null = null;
/** The app's one sync engine (created on first use, in the browser only) */
export function syncEngine(): SyncEngine {
  engine ??= new SyncEngine({
    fetch: (url, init) => fetch(url, init),
    store: browserStore,
    now: () => Date.now(),
    url: apiUrl,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: t => window.clearTimeout(t as number),
  });
  return engine;
}

/**
 * Which account's data the app shows: the signed-in user; while /api/me has not answered (or the
 * API is unreachable, e.g. offline), the account this browser was last signed in to, so a signed-in
 * learner keeps working on their own data. Signed out (or the session ended), null, and the
 * account's keys are removed from the browser.
 */
export function useSyncUser(account: AccountState): string | null {
  const [hint] = useState(() => {
    const v = readStorage(ACCOUNT_KEY);
    return isUserId(v) ? v : null;
  });
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    const onEnd = () => setEnded(true);
    window.addEventListener(SIGNED_OUT_EVENT, onEnd);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onEnd);
  }, []);

  let userId: string | null;
  if (account.status === 'signed-in') userId = isUserId(account.user.id) ? account.user.id : null;
  else if (account.status === 'signed-out' || ended) userId = null;
  else userId = hint;

  const signedOut = account.status === 'signed-out' || (ended && account.status !== 'signed-in');
  useEffect(() => {
    const previous = readStorage(ACCOUNT_KEY);
    if (userId) {
      if (isUserId(previous) && previous !== userId) clearAccountKeys(previous);
      writeStorage(ACCOUNT_KEY, userId);
    } else if (signedOut) {
      syncEngine().stop();
      if (isUserId(previous)) clearAccountKeys(previous);
      writeStorage(ACCOUNT_KEY, null);
    }
  }, [userId, signedOut]);
  return userId;
}

export interface AccountSyncOptions {
  userId: string | null;
  progress: ProgressRecord;
  journey: Journey;
  activity: Activity;
  theme: ThemeChoice;
  setProgress: Dispatch<SetStateAction<ProgressRecord>>;
  setJourney: Dispatch<SetStateAction<Journey>>;
  setActivity: Dispatch<SetStateAction<Activity>>;
  setTheme: (t: ThemeChoice) => void;
  codecs: { progress: SyncedCodec<ProgressRecord>; journey: SyncedCodec<Journey>; activity: SyncedCodec<Activity> };
}

/**
 * Connects the app's records to the sync engine while an account is signed in. Returns a number
 * that goes up each time server data is put into the records, so the game layer can take it in
 * quietly instead of celebrating it as new work.
 */
export function useAccountSync(o: AccountSyncOptions): number {
  const latest = useRef(o);
  latest.current = o;
  const [applied, setApplied] = useState(0);

  useEffect(() => {
    const userId = o.userId;
    if (!userId) return;
    const sync = syncEngine();
    const keys = accountKeys(userId);
    // This tab's records merged with what other tabs saved, tombstones respected
    const merged = <T,>(codec: SyncedCodec<T>, key: string, mine: T) => codec.merge(codec.parse(readStorage(key)), mine);
    const local = () => {
      const c = latest.current;
      return {
        progress: merged(c.codecs.progress, keys.progress, c.progress),
        journey: merged(c.codecs.journey, keys.journey, c.journey),
        activity: merged(c.codecs.activity, keys.activity, c.activity),
      };
    };
    const signedOut = () => {
      const c = latest.current.codecs;
      return {
        progress: c.progress.parse(readStorage(PROGRESS_KEY)),
        journey: c.journey.parse(readStorage(JOURNEY_KEY)),
        activity: c.activity.parse(readStorage(ACTIVITY_KEY)),
      };
    };
    const adapter: SyncAdapter = {
      localItems: () => {
        const l = local();
        return itemsFromRecords(l.progress, l.journey);
      },
      localSettings: () => settingsFromLocal(local().activity, latest.current.theme),
      apply: ({ stale, items, settings, theme }) => {
        const c = latest.current;
        if (c.userId !== userId) return false;
        const now = Date.now();
        const fromServer = activityFromSettings(settings);
        const activity = (a: Activity) => {
          const m = mergeActivity(a, fromServer);
          return c.codecs.activity.serialize(m) === c.codecs.activity.serialize(a) ? a : m;
        };
        c.setProgress(r => applyToProgress(r, stale, items, now));
        c.setJourney(j => applyToJourney(j, stale, items, now));
        c.setActivity(activity);
        if (theme && theme !== c.theme) c.setTheme(theme);
        // React saves these on its next render; what the engine reads next must include them already
        latest.current = {
          ...c,
          progress: applyToProgress(c.progress, stale, items, now),
          journey: applyToJourney(c.journey, stale, items, now),
          activity: activity(c.activity),
          theme: theme ?? c.theme,
        };
        setApplied(n => n + 1);
        return true;
      },
      hasSignedOutProgress: () => {
        const s = signedOut();
        return itemsFromRecords(s.progress, s.journey).length > 0;
      },
      importSignedOut: () => {
        const c = latest.current;
        if (c.userId !== userId) return;
        const s = signedOut();
        // Progress only, never the signed-out tombstones or settings: each record takes the
        // account's own reset times, so nothing of the account is dropped in the merge
        const progress = (r: ProgressRecord) => c.codecs.progress.merge(r, { done: s.progress.done, resetAt: r.resetAt });
        const journey = (j: Journey) => {
          const add: Journey = { read: s.journey.read, quiz: s.journey.quiz, last: null };
          if (j.resets) add.resets = j.resets;
          if (s.journey.answers) add.answers = s.journey.answers;
          return c.codecs.journey.merge(j, add);
        };
        const activity = (a: Activity) => mergeActivity(a, { ...s.activity, prefs: undefined, prefsAt: undefined, clearedAt: a.clearedAt });
        c.setProgress(progress);
        c.setJourney(journey);
        c.setActivity(activity);
        latest.current = { ...c, progress: progress(c.progress), journey: journey(c.journey), activity: activity(c.activity) };
      },
    };
    sync.onUnauthorized = announceSignedOut;
    sync.start(userId, adapter);

    const pull = () => sync.pull();
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync.pull();
    };
    // Another tab signed out (it removed this account's queue): sign out here too
    const onStorage = (e: StorageEvent) => {
      if (e.key === keys.queue && e.newValue === null) announceSignedOut();
    };
    window.addEventListener('online', pull);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('online', pull);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('storage', onStorage);
    };
  }, [o.userId]);

  // Every local change (this tab's or another's) is uploaded after a short wait
  useEffect(() => {
    if (o.userId) syncEngine().changed();
  }, [o.userId, o.progress, o.journey, o.activity, o.theme]);

  return applied;
}

/** Record a reset with the sync (no-op signed out). Scopes from labScope / pathScope. */
export function queueReset(scopes: string[]): void {
  syncEngine().reset(scopes);
}

const OFF: SyncSnapshot = { status: 'off', lastSyncedAt: null, importOffered: false };

export interface UseSync {
  status: SyncStatus;
  /** When the last sync finished (ms), or null */
  lastSyncedAt: number | null;
  /** Sync now (download and upload); resolves when done */
  syncNow: () => Promise<void>;
  /** Add this browser's signed-out progress to the account */
  importLocal: () => Promise<void>;
}

/** Sync status for the account pages: 'off' when signed out */
export function useSync(): UseSync {
  const e = syncEngine();
  const snap = useSyncExternalStore(e.subscribe, e.getSnapshot, () => OFF);
  return { status: snap.status, lastSyncedAt: snap.lastSyncedAt, syncNow: () => e.syncNow(), importLocal: () => e.importLocal() };
}

/**
 * "Add the progress saved in this browser to your account?" with Add / Not now. Shown once per
 * account, and only when this browser has signed-out progress; renders nothing otherwise.
 */
export function ImportPrompt({ className = '' }: { className?: string }) {
  const e = syncEngine();
  const snap = useSyncExternalStore(e.subscribe, e.getSnapshot, () => OFF);
  const [busy, setBusy] = useState(false);
  if (!snap.importOffered) return null;
  const button = 'inline-flex items-center justify-center min-h-11 sm:min-h-9 px-4 rounded-md text-sm font-medium';
  return createElement(
    'section',
    { 'aria-labelledby': 'import-progress-heading', className: `rounded-md border border-line bg-surface px-4 sm:px-5 py-4 space-y-2 ${className}`.trim() },
    createElement('h2', { id: 'import-progress-heading', className: 'text-base font-semibold text-text' }, 'Add the progress saved in this browser to your account?'),
    createElement(
      'p',
      { className: 'text-[15px] text-muted max-w-prose' },
      'This browser has progress from before you signed in. Add copies it into your account, so it appears on your other devices too. Not now keeps the two apart.',
    ),
    createElement(
      'div',
      { className: 'flex flex-wrap items-center gap-3 pt-2' },
      createElement(
        'button',
        {
          type: 'button',
          disabled: busy,
          onClick: () => {
            setBusy(true);
            void e.importLocal().finally(() => setBusy(false));
          },
          className: `${button} bg-accent text-accent-fg hover:opacity-90 disabled:opacity-60`,
        },
        'Add',
      ),
      createElement(
        'button',
        { type: 'button', onClick: () => e.dismissImport(), className: `${button} border border-line-strong text-text hover:bg-surface-2` },
        'Not now',
      ),
    ),
  );
}
