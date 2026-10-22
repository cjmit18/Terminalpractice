/**
 * Progress sync: the merge and reset-epoch rules, shared by the app (src/lib/sync.ts) and the Worker
 * (worker/sync.ts), so one set of unit tests covers both sides. Pure TypeScript with no imports, so
 * it compiles for the browser, for Node and for Workers alike.
 *
 * The model (docs/LOGIN_PLAN.md, "Syncing progress"):
 *
 * - Progress is one item per earned thing: a lab objective (`objective`, key "moduleId/objectiveId"),
 *   a lesson read (`lesson`, key "pathId/stepId") or a quiz score (`quiz`, key "pathId/stepId").
 * - Between resets progress only grows: items are a union, and a quiz keeps its best score.
 * - Each item belongs to one reset scope, derived from its key, never taken from the client:
 *   `lab:<moduleId>` for objectives and `path:<pathId>` for lessons and quizzes. A track reset is the
 *   reset of each of its labs' scopes.
 * - Each scope has an epoch counter (0 until its first reset). A reset raises it by one and deletes
 *   the scope's items. An upload carries, per item, the epoch the device knew for that scope; the
 *   server keeps an item only when that equals the scope's current epoch. So an offline device's
 *   pre-reset snapshot cannot bring reset progress back, while work done after syncing the reset is
 *   kept. Epochs are never lowered or removed.
 * - Settings (activity prefs, theme, earned badges, practice days, goal weeks, the last "clear
 *   badges") are one field each with an `updatedAt`; for each field the newest write wins.
 */

export type ItemKind = 'objective' | 'lesson' | 'quiz';
export const ITEM_KINDS: readonly ItemKind[] = ['objective', 'lesson', 'quiz'];

export interface SyncItem {
  kind: ItemKind;
  /** "moduleId/objectiveId" (objective) or "pathId/stepId" (lesson, quiz) */
  key: string;
  /** Derived from kind and key (scopeOf) */
  scope: string;
  /** The scope's epoch when the item was earned, as the sending device knew it */
  epoch: number;
  /** Quiz only: the best score */
  correct?: number;
  total?: number;
  /** Client time (ms), for display only, never for conflict decisions; 0 when unknown */
  earnedAt: number;
}

/** What a device has locally, before it is stamped with an epoch */
export type LocalItem = Omit<SyncItem, 'scope' | 'epoch' | 'earnedAt'> & { earnedAt?: number };

/** scope -> current epoch; a scope that is missing is at epoch 0 */
export type Epochs = Record<string, number>;

/** Limits checked on the server (and respected by the client) */
export const SYNC_LIMITS = {
  /** Request body of PUT /api/progress and POST /api/progress/reset */
  bodyBytes: 512 * 1024,
  /** Items in one upload */
  itemsPerRequest: 2000,
  /** Items stored per user */
  storedItems: 5000,
  /** Scopes with an epoch, per user */
  scopes: 2000,
  /** Scopes reset in one request */
  resetsPerRequest: 100,
  badges: 500,
  days: 400,
  goalWeeks: 2000,
} as const;

// ---------- Ids and keys ----------

/** The shape of every module, objective, path and step id the app uses */
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_EPOCH = 2 ** 31 - 1;
/** Year 2100: anything later is not a real client time */
const MAX_TIME = 4_102_444_800_000;

export const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

/** "a/b" with both parts ids */
export function isItemKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length > 129) return false;
  const parts = key.split('/');
  return parts.length === 2 && isId(parts[0]) && isId(parts[1]);
}

export const labScope = (moduleId: string) => `lab:${moduleId}`;
export const pathScope = (pathId: string) => `path:${pathId}`;

/** The reset scope an item belongs to */
export function scopeOf(kind: ItemKind, key: string): string {
  const first = key.slice(0, key.indexOf('/'));
  return kind === 'objective' ? labScope(first) : pathScope(first);
}

export function isScope(scope: unknown): scope is string {
  if (typeof scope !== 'string' || scope.length > 70) return false;
  const m = /^(lab|path):(.+)$/.exec(scope);
  return !!m && isId(m[2]);
}

const isEpoch = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_EPOCH;
export const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < MAX_TIME;

export const itemId = (i: { kind: ItemKind; key: string }) => `${i.kind}|${i.key}`;
export const epochOf = (epochs: Epochs, scope: string) => epochs[scope] ?? 0;

// ---------- Validation of untrusted data ----------

function isScore(correct: unknown, total: unknown): boolean {
  return (
    typeof correct === 'number' && typeof total === 'number' &&
    Number.isInteger(correct) && Number.isInteger(total) &&
    total > 0 && total <= 1000 && correct >= 0 && correct <= total
  );
}

/** A well-formed item, or null. The scope is always derived from the key; a sent scope is ignored. */
export function sanitizeItem(raw: unknown): SyncItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind as ItemKind;
  if (!ITEM_KINDS.includes(kind) || !isItemKey(r.key) || !isEpoch(r.epoch)) return null;
  const item: SyncItem = { kind, key: r.key, scope: scopeOf(kind, r.key), epoch: r.epoch, earnedAt: isTime(r.earnedAt) ? r.earnedAt : 0 };
  if (kind === 'quiz') {
    if (!isScore(r.correct, r.total)) return null;
    item.correct = r.correct as number;
    item.total = r.total as number;
  }
  return item;
}

/**
 * Items from an untrusted list. `error` is set when the value is not a list or is longer than
 * `max`; malformed entries otherwise make the whole list invalid too, so a client bug shows up
 * as an error instead of silently losing progress.
 */
export function sanitizeItems(raw: unknown, max: number = SYNC_LIMITS.itemsPerRequest): { items: SyncItem[]; error?: 'invalid_items' | 'too_many_items' } {
  if (raw === undefined) return { items: [] };
  if (!Array.isArray(raw)) return { items: [], error: 'invalid_items' };
  if (raw.length > max) return { items: [], error: 'too_many_items' };
  const items: SyncItem[] = [];
  for (const r of raw) {
    const item = sanitizeItem(r);
    if (!item) return { items: [], error: 'invalid_items' };
    items.push(item);
  }
  return { items };
}

/** Epochs from untrusted data: valid scopes and epochs only */
export function sanitizeEpochs(raw: unknown): Epochs {
  const out: Epochs = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [scope, e] of Object.entries(raw as Record<string, unknown>)) if (isScope(scope) && isEpoch(e)) out[scope] = e;
  return out;
}

// ---------- Merging items (within one owner) ----------

/** True when score a is better than b: a higher fraction, or the same fraction out of more questions */
export function betterScore(a: { correct?: number; total?: number }, b: { correct?: number; total?: number }): boolean {
  const ac = a.correct ?? 0, at = a.total ?? 1, bc = b.correct ?? 0, bt = b.total ?? 1;
  return ac * bt > bc * at || (ac * bt === bc * at && at > bt);
}

/**
 * Two copies of the same item: a newer epoch replaces an older one entirely; within an epoch the
 * best quiz score and the earliest known earnedAt are kept. Commutative and idempotent.
 */
export function mergeItem(a: SyncItem, b: SyncItem): SyncItem {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch ? a : b;
  const best = a.kind === 'quiz' && betterScore(b, a) ? b : a;
  const times = [a.earnedAt, b.earnedAt].filter(t => t > 0);
  return { ...best, earnedAt: times.length ? Math.min(...times) : 0 };
}

/** Union of two item lists (merged per item), sorted by kind and key */
export function mergeItems(a: SyncItem[], b: SyncItem[]): SyncItem[] {
  const map = new Map<string, SyncItem>();
  for (const item of [...a, ...b]) {
    const id = itemId(item);
    const prev = map.get(id);
    map.set(id, prev ? mergeItem(prev, item) : item);
  }
  return [...map.values()].sort((x, y) => (itemId(x) < itemId(y) ? -1 : itemId(x) > itemId(y) ? 1 : 0));
}

/** The server's state for one user */
export interface ProgressState {
  items: SyncItem[];
  epochs: Epochs;
}

/**
 * An upload: incoming items are kept only when their epoch is the scope's current epoch, then
 * merged with what is stored. Returns the new state plus what was dropped.
 */
export function acceptUpload(state: ProgressState, incoming: SyncItem[]): ProgressState & { dropped: SyncItem[] } {
  const kept: SyncItem[] = [];
  const dropped: SyncItem[] = [];
  for (const item of incoming) (item.epoch === epochOf(state.epochs, item.scope) ? kept : dropped).push(item);
  return { items: mergeItems(state.items, kept), epochs: state.epochs, dropped };
}

/**
 * A reset of one scope. With `expected` (the epoch the resetting device knew), the reset only
 * happens while the scope is still at that epoch: a repeated request (two tabs, a retry) or a
 * reset that another device already made is then a no-op instead of a second raise. Either way,
 * no item older than the scope's epoch survives.
 */
export function applyReset(state: ProgressState, scope: string, expected?: number): ProgressState {
  const current = epochOf(state.epochs, scope);
  const raise = expected === undefined || expected === current;
  const epoch = raise ? current + 1 : current;
  return {
    epochs: raise ? { ...state.epochs, [scope]: epoch } : state.epochs,
    items: state.items.filter(i => i.scope !== scope || i.epoch >= epoch),
  };
}

// ---------- The client's side of the epoch rules ----------

/** Scopes whose epoch the server has raised since this device last knew it: local data there must go */
export function staleScopes(known: Epochs, server: Epochs): string[] {
  return Object.keys(server).filter(s => server[s] > epochOf(known, s)).sort();
}

/** True when the server copy already holds everything the local item says */
function covers(server: SyncItem | undefined, local: LocalItem): boolean {
  if (!server) return false;
  return local.kind !== 'quiz' || !betterScore(local, server);
}

/**
 * What a device still has to upload: its local items that the server copy it knows does not
 * already cover, stamped with the epoch this device knows for each scope. Stamping at upload time
 * is safe because a device clears a scope's local data as soon as it learns that the scope's epoch
 * went up (staleScopes), so any local item left was earned under the epoch it knows.
 */
export function pendingUploads(local: LocalItem[], server: SyncItem[], known: Epochs, now: number): SyncItem[] {
  const byId = new Map(server.map(i => [itemId(i), i]));
  const out: SyncItem[] = [];
  for (const l of local) {
    if (!ITEM_KINDS.includes(l.kind) || !isItemKey(l.key)) continue;
    if (l.kind === 'quiz' && !isScore(l.correct, l.total)) continue;
    if (covers(byId.get(itemId(l)), l)) continue;
    const scope = scopeOf(l.kind, l.key);
    out.push({ ...l, scope, epoch: epochOf(known, scope), earnedAt: isTime(l.earnedAt) ? l.earnedAt : now });
  }
  return mergeItems([], out);
}

/**
 * Signed-out progress joins an account only through the explicit "Add" choice, stamped with the
 * account's epochs at that moment. "Not now" (or no answer) imports nothing.
 */
export function importItems(choice: 'add' | 'not-now' | null, local: LocalItem[], epochs: Epochs, now: number): SyncItem[] {
  return choice === 'add' ? pendingUploads(local, [], epochs, now) : [];
}

/**
 * Which account a sync request was started for. Switching accounts starts a new generation; a
 * response for an older one (a late answer after sign-out or a switch) is discarded.
 */
export class AccountGate {
  private gen = 0;
  private user: string | null = null;
  switchTo(userId: string | null): void {
    if (userId === this.user) return;
    this.user = userId;
    this.gen++;
  }
  get userId(): string | null {
    return this.user;
  }
  ticket(): { userId: string | null; gen: number } {
    return { userId: this.user, gen: this.gen };
  }
  isCurrent(t: { userId: string | null; gen: number }): boolean {
    return t.gen === this.gen && t.userId === this.user && t.userId !== null;
  }
}

// ---------- Settings ----------

export type ThemeSetting = 'system' | 'light' | 'dark';

/** The activity prefs that sync (same fields and values as ActivityPrefs in activity.ts) */
export interface PrefsSetting {
  celebrations?: 'quiet' | 'off' | 'lively';
  showBadges?: boolean;
  weeklyGoal?: number;
  sandboxHost?: string;
  promptStyle?: 'standard' | 'bracket' | 'short' | 'host-first';
  bannerLine?: 'none' | 'calm' | 'tip' | 'loopback';
  storyNotes?: boolean;
  defaultShell?: 'bash' | 'cmd' | 'powershell';
  termFontSize?: 's' | 'm' | 'l';
}

export interface SettingField<T> {
  value: T;
  /** Client time (ms) of the write; the newest write of each field wins */
  updatedAt: number;
}

export interface SyncSettings {
  prefs?: SettingField<PrefsSetting>;
  theme?: SettingField<ThemeSetting>;
  /** badgeId -> first earned (ms) */
  badges?: SettingField<Record<string, number>>;
  /** YYYY-MM-DD practice days */
  practice?: SettingField<string[]>;
  /** YYYY-MM-DD start days of weeks that met the goal */
  goalWeeks?: SettingField<string[]>;
  /** Time of the last "Clear badges and activity" (ms) */
  cleared?: SettingField<number>;
}

export const SETTING_FIELDS = ['prefs', 'theme', 'badges', 'practice', 'goalWeeks', 'cleared'] as const;
export type SettingName = (typeof SETTING_FIELDS)[number];

const BADGE_ID = /^[a-z0-9][a-z0-9:._-]{0,79}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const isDay = (d: unknown): d is string => typeof d === 'string' && DAY.test(d) && !Number.isNaN(Date.parse(d));

function sanitizePrefsSetting(raw: unknown): PrefsSetting | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const p: PrefsSetting = {};
  if (r.celebrations === 'quiet' || r.celebrations === 'off' || r.celebrations === 'lively') p.celebrations = r.celebrations;
  if (typeof r.showBadges === 'boolean') p.showBadges = r.showBadges;
  if (typeof r.weeklyGoal === 'number' && Number.isInteger(r.weeklyGoal) && r.weeklyGoal >= 0 && r.weeklyGoal <= 7) p.weeklyGoal = r.weeklyGoal;
  if (typeof r.sandboxHost === 'string' && (r.sandboxHost === '' || HOSTNAME.test(r.sandboxHost))) p.sandboxHost = r.sandboxHost;
  if (r.promptStyle === 'standard' || r.promptStyle === 'bracket' || r.promptStyle === 'short' || r.promptStyle === 'host-first')
    p.promptStyle = r.promptStyle;
  if (r.bannerLine === 'none' || r.bannerLine === 'calm' || r.bannerLine === 'tip' || r.bannerLine === 'loopback') p.bannerLine = r.bannerLine;
  if (typeof r.storyNotes === 'boolean') p.storyNotes = r.storyNotes;
  if (r.defaultShell === 'bash' || r.defaultShell === 'cmd' || r.defaultShell === 'powershell') p.defaultShell = r.defaultShell;
  if (r.termFontSize === 's' || r.termFontSize === 'm' || r.termFontSize === 'l') p.termFontSize = r.termFontSize;
  return p;
}

function sanitizeDays(raw: unknown, max: number): string[] | null {
  if (!Array.isArray(raw) || raw.length > max) return null;
  if (!raw.every(isDay)) return null;
  return [...new Set(raw as string[])].sort();
}

function sanitizeValue(name: SettingName, raw: unknown): unknown {
  switch (name) {
    case 'prefs':
      return sanitizePrefsSetting(raw);
    case 'theme':
      return raw === 'system' || raw === 'light' || raw === 'dark' ? raw : null;
    case 'badges': {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const entries = Object.entries(raw as Record<string, unknown>);
      if (entries.length > SYNC_LIMITS.badges || !entries.every(([id, t]) => BADGE_ID.test(id) && isTime(t))) return null;
      return Object.fromEntries(entries.sort(([x], [y]) => (x < y ? -1 : 1)));
    }
    case 'practice':
      return sanitizeDays(raw, SYNC_LIMITS.days);
    case 'goalWeeks':
      return sanitizeDays(raw, SYNC_LIMITS.goalWeeks);
    case 'cleared':
      return isTime(raw) ? raw : null;
  }
}

/**
 * Settings from untrusted data. With `strict`, any malformed field makes the whole value invalid
 * (null), which the server answers with 400; otherwise malformed fields are just left out.
 */
export function sanitizeSettings(raw: unknown, strict = false): SyncSettings | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return strict ? null : {};
  const r = raw as Record<string, unknown>;
  const out: Record<string, SettingField<unknown>> = {};
  for (const key of Object.keys(r)) {
    if (!(SETTING_FIELDS as readonly string[]).includes(key)) {
      if (strict) return null;
      continue;
    }
    const name = key as SettingName;
    const f = r[name] as Record<string, unknown> | null;
    const value = f && typeof f === 'object' && !Array.isArray(f) && isTime(f.updatedAt) ? sanitizeValue(name, f.value) : null;
    if (value === null) {
      if (strict) return null;
      continue;
    }
    out[name] = { value, updatedAt: f!.updatedAt as number };
  }
  return out as SyncSettings;
}

/** JSON with object keys sorted, so equal values give equal text */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Per field, the newest write wins; on a tie the larger text, so the order of a and b does not matter */
export function mergeSettings(a: SyncSettings, b: SyncSettings): SyncSettings {
  const out: Record<string, SettingField<unknown>> = {};
  for (const name of SETTING_FIELDS) {
    const x = a[name] as SettingField<unknown> | undefined;
    const y = b[name] as SettingField<unknown> | undefined;
    if (!x || !y) {
      if (x || y) out[name] = (x ?? y)!;
      continue;
    }
    out[name] = y.updatedAt > x.updatedAt || (y.updatedAt === x.updatedAt && stableJson(y.value) > stableJson(x.value)) ? y : x;
  }
  return out as SyncSettings;
}
