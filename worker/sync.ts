// Progress sync API: GET /api/progress, PUT /api/progress, POST /api/progress/reset.
// The merge and epoch rules are shared with the app (src/lib/syncRules.ts); this file stores them in
// D1. Like the rest of the API it has no Cloudflare-only imports, so it runs in Node tests against node:sqlite.
//
// Security: the router (api.ts) applies the shared checks: this site's Origin on PUT and POST, a JSON
// body of at most SYNC_BODY_LIMIT (512 KB). The user always comes from the session cookie
// (requireSession), never from the body. Every key, scope and value is checked against the shapes the
// app uses, so no free text is ever stored.
import { SYNC_BODY_LIMIT, json, type Db, type DbStatement, type Route, type RouteContext } from './http';
import { requireSession, type Session } from './session';
import {
  SETTING_FIELDS,
  SYNC_LIMITS,
  type Epochs,
  type SyncItem,
  type SyncSettings,
  isScope,
  itemId,
  mergeSettings,
  sanitizeItems,
  sanitizeSettings,
  stableJson,
} from '../src/lib/syncRules';

/** What sync needs beyond the API's Db: atomic batches. Cloudflare's D1 has it. */
export interface SyncDb extends Db {
  /** Runs the statements in one transaction */
  batch(statements: DbStatement[]): Promise<unknown[]>;
}

/** Tables holding a user's progress; account deletion clears them (ON DELETE CASCADE does too) */
export const SYNC_TABLES = ['progress_items', 'progress_epochs', 'user_settings'] as const;

export interface SyncResponseBody {
  items: SyncItem[];
  epochs: Epochs;
  settings: SyncSettings;
}

const SETTINGS_RETRIES = 5;

const syncDb = (c: RouteContext) => c.env.DB as SyncDb;

async function getProgress(c: RouteContext): Promise<Response> {
  const session = await requireSession(c);
  return withRenewal(session, json(await readState(syncDb(c), session.userId)));
}

async function putProgress(c: RouteContext): Promise<Response> {
  const session = await requireSession(c);
  return withRenewal(session, await put(syncDb(c), session.userId, await c.body(), c.deps.now()));
}

async function resetProgress(c: RouteContext): Promise<Response> {
  const session = await requireSession(c);
  return withRenewal(session, await reset(syncDb(c), session.userId, await c.body()));
}

/** A session renewed by this request sends its new cookie, or the browser drops it before the server does */
function withRenewal(session: Session, res: Response): Response {
  if (session.renewedCookie) res.headers.append('Set-Cookie', session.renewedCookie);
  return res;
}

export const syncRoutes: Route[] = [
  { method: 'GET', path: '/api/progress', handler: getProgress },
  { method: 'PUT', path: '/api/progress', handler: putProgress, bodyLimit: SYNC_BODY_LIMIT },
  { method: 'POST', path: '/api/progress/reset', handler: resetProgress, bodyLimit: SYNC_BODY_LIMIT },
];

// --- PUT: upload items (kept only at the current epoch) and settings --------------------------

async function put(db: SyncDb, userId: string, body: Record<string, unknown>, now: number): Promise<Response> {
  const { items, error: itemsError } = sanitizeItems(body.items);
  if (itemsError === 'too_many_items') return error(413, 'too_many_items', `At most ${SYNC_LIMITS.itemsPerRequest} items per request.`);
  if (itemsError) return error(400, 'invalid_items', 'An item is not in the expected form.');
  const settings = sanitizeSettings(body.settings, true);
  if (!settings) return error(400, 'invalid_settings', 'A setting is not in the expected form.');
  // `epochs` is accepted for the record but never trusted: each item carries its own epoch

  if (items.length > 0) {
    // Only items the account does not hold yet count toward the cap: improving a quiz score or a
    // retried upload adds no row. upsertItem repeats the check inside the batch, so uploads at once
    // cannot pass it together.
    const { results } = await db.prepare('SELECT kind, item_key FROM progress_items WHERE user_id = ?').bind(userId).all<{ kind: SyncItem['kind']; item_key: string }>();
    const held = new Set(results.map(r => itemId({ kind: r.kind, key: r.item_key })));
    const added = new Set(items.map(itemId).filter(id => !held.has(id))).size;
    if (held.size + added > SYNC_LIMITS.storedItems) {
      return error(413, 'too_many_items', 'This account holds the most progress items allowed.');
    }
    await db.batch(items.map(item => upsertItem(db, userId, item)));
  }
  if (Object.keys(settings).length > 0) {
    const ok = await writeSettings(db, userId, settings, now);
    if (!ok) return error(409, 'conflict', 'Settings changed at the same time. Try again.');
  }
  return json(await readState(db, userId));
}

/**
 * Insert or merge one item, only while its epoch is its scope's current epoch. The epoch check is
 * part of the statement, so a reset running at the same time cannot let an old item back in.
 * A new row is added only while the account is under the stored-item cap; an existing one is
 * always merged. Within an epoch the best quiz score and the earliest earnedAt are kept (as
 * mergeItem does).
 */
function upsertItem(db: SyncDb, userId: string, item: SyncItem): DbStatement {
  const better = `(excluded.correct * progress_items.total > progress_items.correct * excluded.total
     OR (excluded.correct * progress_items.total = progress_items.correct * excluded.total AND excluded.total > progress_items.total))`;
  return db
    .prepare(
      `INSERT INTO progress_items (user_id, kind, item_key, scope, epoch, correct, total, earned_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
        WHERE ?5 = COALESCE((SELECT epoch FROM progress_epochs WHERE user_id = ?1 AND scope = ?4), 0)
          AND (EXISTS (SELECT 1 FROM progress_items WHERE user_id = ?1 AND kind = ?2 AND item_key = ?3)
               OR (SELECT COUNT(*) FROM progress_items WHERE user_id = ?1) < ?9)
       ON CONFLICT (user_id, kind, item_key) DO UPDATE SET
         correct = CASE WHEN ${better} THEN excluded.correct ELSE progress_items.correct END,
         total = CASE WHEN ${better} THEN excluded.total ELSE progress_items.total END,
         earned_at = CASE WHEN excluded.earned_at > 0 AND (progress_items.earned_at = 0 OR excluded.earned_at < progress_items.earned_at)
                          THEN excluded.earned_at ELSE progress_items.earned_at END`,
    )
    .bind(userId, item.kind, item.key, item.scope, item.epoch, item.correct ?? null, item.total ?? null, item.earnedAt, SYNC_LIMITS.storedItems);
}

/** Read-merge-write of the settings row, retried when another request changed it in between */
async function writeSettings(db: SyncDb, userId: string, incoming: SyncSettings, now: number): Promise<boolean> {
  for (let attempt = 0; attempt < SETTINGS_RETRIES; attempt++) {
    const row = await db.prepare('SELECT data, version FROM user_settings WHERE user_id = ?').bind(userId).first<{ data: string; version: number }>();
    const stored = row ? parseSettings(row.data) : {};
    const merged = mergeSettings(stored, incoming);
    const text = stableJson(merged);
    if (row && text === stableJson(stored)) return true;
    const res = row
      ? await db
          .prepare('UPDATE user_settings SET data = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND version = ?')
          .bind(text, now, userId, row.version)
          .run()
      : await db
          .prepare('INSERT INTO user_settings (user_id, data, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT (user_id) DO NOTHING')
          .bind(userId, text, now)
          .run();
    if (changes(res) > 0) return true;
  }
  return false;
}

function parseSettings(text: string): SyncSettings {
  try {
    return sanitizeSettings(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
}

/** Rows changed by a run(): D1 reports meta.changes, node:sqlite reports changes */
function changes(res: unknown): number {
  const r = res as { changes?: number; meta?: { changes?: number } } | null;
  return Number(r?.meta?.changes ?? r?.changes ?? 0);
}

// --- POST reset: raise a scope's epoch and delete its items ----------------------------------

async function reset(db: SyncDb, userId: string, body: Record<string, unknown>): Promise<Response> {
  // One reset `{ scope, epoch? }`, or several `{ resets: [{ scope, epoch? }] }`
  const list = Array.isArray(body.resets) ? body.resets : body.scope !== undefined ? [body] : null;
  if (!list || list.length === 0) return error(400, 'invalid_scope', 'Name the scope to reset.');
  if (list.length > SYNC_LIMITS.resetsPerRequest) return error(413, 'too_many_resets', `At most ${SYNC_LIMITS.resetsPerRequest} resets per request.`);
  const resets: { scope: string; epoch: number | null }[] = [];
  for (const r of list as unknown[]) {
    const x = r as Record<string, unknown> | null;
    if (!x || typeof x !== 'object' || !isScope(x.scope)) return error(400, 'invalid_scope', 'A scope is not in the expected form.');
    const epoch = x.epoch;
    if (epoch !== undefined && !(typeof epoch === 'number' && Number.isInteger(epoch) && epoch >= 0 && epoch < 2 ** 31)) {
      return error(400, 'invalid_scope', 'An epoch is not in the expected form.');
    }
    resets.push({ scope: x.scope, epoch: (epoch as number | undefined) ?? null });
  }

  // Only scopes reset for the first time count toward the cap: a scope already reset keeps its row
  const { results } = await db.prepare('SELECT scope FROM progress_epochs WHERE user_id = ?').bind(userId).all<{ scope: string }>();
  const held = new Set(results.map(r => r.scope));
  const added = new Set(resets.map(r => r.scope).filter(scope => !held.has(scope))).size;
  if (held.size + added > SYNC_LIMITS.scopes) return error(413, 'too_many_scopes', 'This account has reset too many scopes.');

  const statements: DbStatement[] = [];
  for (const { scope, epoch } of resets) {
    // Raise by one; with an expected epoch only while the scope is still at it, so a repeated
    // request (two tabs, a retry) does not reset twice (applyReset in syncRules.ts). A scope with a
    // row is raised by the UPDATE; the INSERT starts one that has none (epoch 0 has no row). They
    // run in this order, so a scope is never raised twice by one reset.
    statements.push(
      db
        .prepare('UPDATE progress_epochs SET epoch = epoch + 1 WHERE user_id = ?1 AND scope = ?2 AND (?3 IS NULL OR epoch = ?3)')
        .bind(userId, scope, epoch),
      db
        .prepare(
          `INSERT INTO progress_epochs (user_id, scope, epoch)
           SELECT ?1, ?2, 1 WHERE (?3 IS NULL OR ?3 = 0)
              AND NOT EXISTS (SELECT 1 FROM progress_epochs WHERE user_id = ?1 AND scope = ?2)
              AND (SELECT COUNT(*) FROM progress_epochs WHERE user_id = ?1) < ?4`,
        )
        .bind(userId, scope, epoch, SYNC_LIMITS.scopes),
      // No item older than the scope's epoch survives
      db
        .prepare(
          `DELETE FROM progress_items WHERE user_id = ?1 AND scope = ?2
             AND epoch < COALESCE((SELECT epoch FROM progress_epochs WHERE user_id = ?1 AND scope = ?2), 0)`,
        )
        .bind(userId, scope),
    );
  }
  await db.batch(statements);
  return json({ epochs: await readEpochs(db, userId) });
}

// --- Reading ---------------------------------------------------------------------------------

async function readEpochs(db: Db, userId: string): Promise<Epochs> {
  const { results } = await db.prepare('SELECT scope, epoch FROM progress_epochs WHERE user_id = ? ORDER BY scope').bind(userId).all<{ scope: string; epoch: number }>();
  const epochs: Epochs = {};
  for (const r of results) epochs[r.scope] = Number(r.epoch);
  return epochs;
}

/** The user's stored progress, epochs and settings (also used by the account export) */
export async function readState(db: Db, userId: string): Promise<SyncResponseBody> {
  const { results } = await db
    .prepare('SELECT kind, item_key, scope, epoch, correct, total, earned_at FROM progress_items WHERE user_id = ? ORDER BY kind, item_key')
    .bind(userId)
    .all<{ kind: SyncItem['kind']; item_key: string; scope: string; epoch: number; correct: number | null; total: number | null; earned_at: number }>();
  const items = results.map(r => {
    const item: SyncItem = { kind: r.kind, key: r.item_key, scope: r.scope, epoch: Number(r.epoch), earnedAt: Number(r.earned_at) };
    if (r.kind === 'quiz') {
      item.correct = Number(r.correct);
      item.total = Number(r.total);
    }
    return item;
  });
  const row = await db.prepare('SELECT data FROM user_settings WHERE user_id = ?').bind(userId).first<{ data: string }>();
  const settings = row ? parseSettings(row.data) : {};
  // Fields in a fixed order
  const ordered: SyncSettings = {};
  for (const f of SETTING_FIELDS) if (settings[f]) (ordered as Record<string, unknown>)[f] = settings[f];
  return { items, epochs: await readEpochs(db, userId), settings: ordered };
}

// --- Helpers ---------------------------------------------------------------------------------

function error(status: number, code: string, message: string): Response {
  return json({ error: code, message }, status);
}
