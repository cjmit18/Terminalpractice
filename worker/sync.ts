// Progress sync API: GET /api/progress, PUT /api/progress, POST /api/progress/reset.
// The merge and epoch rules are shared with the app (src/lib/syncRules.ts); this file stores them in
// D1. Like api.ts it has no Cloudflare-only imports, so it runs in Node tests against node:sqlite.
//
// Security: the user always comes from the session cookie (the caller passes the id it found, or
// null), never from the body. PUT and POST need this site's Origin and a JSON body of at most
// 512 KB. Every key, scope and value is checked against the shapes the app uses, so no free text
// is ever stored.
import type { ApiEnv, Db, DbStatement } from './api';
import {
  SETTING_FIELDS,
  SYNC_LIMITS,
  type Epochs,
  type SyncItem,
  type SyncSettings,
  isScope,
  mergeSettings,
  sanitizeItems,
  sanitizeSettings,
  stableJson,
} from '../src/lib/syncRules';

/** What sync needs beyond api.ts's Db: listing rows and atomic batches. Cloudflare's D1 has both. */
export interface SyncStatement extends DbStatement {
  bind(...values: unknown[]): SyncStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface SyncDb extends Db {
  prepare(sql: string): SyncStatement;
  /** Runs the statements in one transaction */
  batch(statements: SyncStatement[]): Promise<unknown[]>;
}

export interface SyncResponseBody {
  items: SyncItem[];
  epochs: Epochs;
  settings: SyncSettings;
}

const SETTINGS_RETRIES = 5;

/** Handles /api/progress and /api/progress/reset for the user the session cookie named (null: signed out). */
export async function handleSync(request: Request, env: ApiEnv, userId: string | null, now: number = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  const known = route === 'GET /api/progress' || route === 'PUT /api/progress' || route === 'POST /api/progress/reset';
  if (!known) {
    const pathKnown = url.pathname === '/api/progress' || url.pathname === '/api/progress/reset';
    return pathKnown ? error(405, 'method_not_allowed', 'This method is not allowed here.') : error(404, 'not_found', 'Not found.');
  }
  if (request.method !== 'GET') {
    // Only this site's own pages may change progress (blocks cross-site requests)
    if (request.headers.get('Origin') !== url.origin) return error(403, 'forbidden', 'This request must come from the site itself.');
  }
  if (!userId) return error(401, 'unauthorized', 'Sign in to sync your progress.');
  const db = env.DB as SyncDb;

  if (request.method === 'GET') return json(await readState(db, userId));

  const body = await readJson(request);
  if ('error' in body) return body.error;

  if (route === 'POST /api/progress/reset') return reset(db, userId, body.value);
  return put(db, userId, body.value, now);
}

// --- PUT: upload items (kept only at the current epoch) and settings --------------------------

async function put(db: SyncDb, userId: string, raw: unknown, now: number): Promise<Response> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return error(400, 'invalid_body', 'Expected a JSON object.');
  const body = raw as Record<string, unknown>;
  const { items, error: itemsError } = sanitizeItems(body.items);
  if (itemsError === 'too_many_items') return error(413, 'too_many_items', `At most ${SYNC_LIMITS.itemsPerRequest} items per request.`);
  if (itemsError) return error(400, 'invalid_items', 'An item is not in the expected form.');
  const settings = sanitizeSettings(body.settings, true);
  if (!settings) return error(400, 'invalid_settings', 'A setting is not in the expected form.');
  // `epochs` is accepted for the record but never trusted: each item carries its own epoch

  if (items.length > 0) {
    const stored = await db.prepare('SELECT COUNT(*) AS n FROM progress_items WHERE user_id = ?').bind(userId).first<{ n: number }>();
    if ((stored?.n ?? 0) + items.length > SYNC_LIMITS.storedItems) {
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
 * Within an epoch the best quiz score and the earliest earnedAt are kept (as mergeItem does).
 */
function upsertItem(db: SyncDb, userId: string, item: SyncItem): SyncStatement {
  const better = `(excluded.correct * progress_items.total > progress_items.correct * excluded.total
     OR (excluded.correct * progress_items.total = progress_items.correct * excluded.total AND excluded.total > progress_items.total))`;
  return db
    .prepare(
      `INSERT INTO progress_items (user_id, kind, item_key, scope, epoch, correct, total, earned_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
        WHERE ?5 = COALESCE((SELECT epoch FROM progress_epochs WHERE user_id = ?1 AND scope = ?4), 0)
       ON CONFLICT (user_id, kind, item_key) DO UPDATE SET
         correct = CASE WHEN ${better} THEN excluded.correct ELSE progress_items.correct END,
         total = CASE WHEN ${better} THEN excluded.total ELSE progress_items.total END,
         earned_at = CASE WHEN excluded.earned_at > 0 AND (progress_items.earned_at = 0 OR excluded.earned_at < progress_items.earned_at)
                          THEN excluded.earned_at ELSE progress_items.earned_at END`,
    )
    .bind(userId, item.kind, item.key, item.scope, item.epoch, item.correct ?? null, item.total ?? null, item.earnedAt);
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

async function reset(db: SyncDb, userId: string, raw: unknown): Promise<Response> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return error(400, 'invalid_body', 'Expected a JSON object.');
  const body = raw as Record<string, unknown>;
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

  const count = await db.prepare('SELECT COUNT(*) AS n FROM progress_epochs WHERE user_id = ?').bind(userId).first<{ n: number }>();
  if ((count?.n ?? 0) + resets.length > SYNC_LIMITS.scopes) return error(413, 'too_many_scopes', 'This account has reset too many scopes.');

  const statements: SyncStatement[] = [];
  for (const { scope, epoch } of resets) {
    // Raise by one; with an expected epoch only while the scope is still at it, so a repeated
    // request (two tabs, a retry) does not reset twice (applyReset in syncRules.ts)
    statements.push(
      db
        .prepare(
          `INSERT INTO progress_epochs (user_id, scope, epoch)
           SELECT ?1, ?2, 1 WHERE ?3 IS NULL OR ?3 = 0
           ON CONFLICT (user_id, scope) DO UPDATE SET epoch = progress_epochs.epoch + 1
            WHERE ?3 IS NULL OR progress_epochs.epoch = ?3`,
        )
        .bind(userId, scope, epoch),
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

async function readEpochs(db: SyncDb, userId: string): Promise<Epochs> {
  const { results } = await db.prepare('SELECT scope, epoch FROM progress_epochs WHERE user_id = ? ORDER BY scope').bind(userId).all<{ scope: string; epoch: number }>();
  const epochs: Epochs = {};
  for (const r of results) epochs[r.scope] = Number(r.epoch);
  return epochs;
}

async function readState(db: SyncDb, userId: string): Promise<SyncResponseBody> {
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

async function readJson(request: Request): Promise<{ value: unknown } | { error: Response }> {
  if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
    return { error: error(415, 'unsupported_media_type', 'Send JSON (Content-Type: application/json).') };
  }
  const tooLarge = () => ({ error: error(413, 'too_large', 'The request is too large.') });
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > SYNC_LIMITS.bodyBytes) return tooLarge();
  // The declared length can be missing or wrong: count what actually arrives, and stop reading past the cap
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SYNC_LIMITS.bodyBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { error: error(400, 'invalid_json', 'The body is not valid JSON.') };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: code, message }, status);
}
