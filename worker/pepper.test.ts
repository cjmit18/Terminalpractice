// Portal part 10: the password pepper. Hashes made before it are upgraded without the password, at
// sign-in and by the daily sweep; a pepper too short to help is not used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, sessionOf, setup } from './testkit.ts';
import { hashPassword, pepperStoredHash, pepperStoredHashes, verifyPassword } from './password.ts';
import { dailyMaintenance } from './maintenance.ts';

const PEPPER = { PASSWORD_PEPPER: 'test-only-pepper-0123456789abcdefghij' };
const OTHER = { PASSWORD_PEPPER: 'another-test-pepper-0123456789abcdefgh' };
const storedHash = (s: ReturnType<typeof setup>) =>
  (s.db.raw.prepare('SELECT password_hash FROM users WHERE email = ?').get('learner@example.com') as { password_hash: string }).password_hash;

/** Runs `effect` just before the first statement starting with `prefix` is prepared */
function interleave(s: ReturnType<typeof setup>, prefix: string, effect: () => void) {
  const prepare = s.db.prepare.bind(s.db);
  let done = false;
  s.db.prepare = sql => {
    if (!done && sql.replace(/\s+/g, ' ').trimStart().startsWith(prefix)) {
      done = true;
      effect();
    }
    return prepare(sql);
  };
  return () => done;
}

test('a peppered hash needs the same pepper; a short pepper is not used', async () => {
  const stored = await hashPassword(PASSWORD, PEPPER);
  assert.match(stored, /^pbkdf2-hmac\$sha256\$100000\$/);
  assert.equal(await verifyPassword(PASSWORD, stored, PEPPER), true);
  assert.equal(await verifyPassword('wrong password here', stored, PEPPER), false);
  assert.equal(await verifyPassword(PASSWORD, stored, {}), false, 'the database alone cannot check it');
  assert.equal(await verifyPassword(PASSWORD, stored, OTHER), false);

  const short = await hashPassword(PASSWORD, { PASSWORD_PEPPER: 'too-short' });
  assert.match(short, /^pbkdf2\$/);
  assert.equal(await verifyPassword(PASSWORD, short, { PASSWORD_PEPPER: 'too-short' }), true);
});

test('an old hash is upgraded from the hash itself, without the password', async () => {
  const old = await hashPassword(PASSWORD, {});
  const upgraded = (await pepperStoredHash(old, PEPPER))!;
  assert.match(upgraded, /^pbkdf2-hmac\$/);
  assert.equal(old.split('$')[3], upgraded.split('$')[3], 'same salt');
  assert.equal(await verifyPassword(PASSWORD, upgraded, PEPPER), true);
  assert.equal(await verifyPassword(PASSWORD, old, PEPPER), true, 'old hashes still sign in until upgraded');
  assert.equal(await pepperStoredHash(upgraded, PEPPER), null, 'nothing to do twice');
  assert.equal(await pepperStoredHash(old, {}), null, 'nothing to do without a pepper');
});

test('signing in upgrades an old hash; sign-up, reset and change make peppered ones', async () => {
  const before = setup();
  await before.register();
  const old = storedHash(before);
  assert.match(old, /^pbkdf2\$/);

  // The same database once the pepper is set
  const s = setup(PEPPER);
  s.db.raw.prepare("INSERT INTO users (id, display_name, created_at, email, email_set_at, email_verified_at, password_hash) VALUES ('u', 'Learner', 0, 'learner@example.com', 0, 0, ?)").run(old);
  assert.equal((await s.login()).status, 200);
  assert.match(storedHash(s), /^pbkdf2-hmac\$/);
  assert.equal((await s.login()).status, 200, 'and signs in after');

  const fresh = setup(PEPPER);
  await fresh.register();
  assert.match(storedHash(fresh), /^pbkdf2-hmac\$/);
});

test('an upgrade landing during a sign-in or a password change is not a change of password', async () => {
  const s = setup(PEPPER);
  const old = await hashPassword(PASSWORD, {});
  s.db.raw.prepare("INSERT INTO users (id, display_name, created_at, email, email_set_at, email_verified_at, password_hash) VALUES ('u', 'Learner', 0, 'learner@example.com', 0, 0, ?)").run(old);
  const upgraded = (await pepperStoredHash(old, PEPPER))!;
  // Another sign-in upgrades the hash between this one's check and its session
  let happened = interleave(s, 'INSERT INTO sessions', () => s.db.raw.prepare('UPDATE users SET password_hash = ?').run(upgraded));
  const res = await s.login();
  assert.ok(happened());
  assert.equal(res.status, 200);

  // The daily sweep upgrades while a password change is between its check and its write
  s.db.raw.prepare('UPDATE users SET password_hash = ?').run(old);
  happened = interleave(s, 'UPDATE users SET password_hash = ?, updated_at', () => s.db.raw.prepare('UPDATE users SET password_hash = ?').run(upgraded));
  const change = await s.call('POST', '/api/account/password', { currentPassword: PASSWORD, newPassword: 'a different long passphrase' }, { Cookie: `__Host-session=${sessionOf(res)}` });
  assert.ok(happened());
  assert.equal(change.status, 200);
  assert.equal(await verifyPassword('a different long passphrase', storedHash(s), PEPPER), true);
});

test('the daily sweep upgrades accounts that do not sign in, a batch at a time, and never touches new hashes', async () => {
  const s = setup(PEPPER);
  for (let i = 0; i < 3; i++) {
    s.db.raw
      .prepare('INSERT INTO users (id, display_name, created_at, email, password_hash) VALUES (?, ?, 0, ?, ?)')
      .run(`u${i}`, `L${i}`, `l${i}@example.com`, await hashPassword(PASSWORD, {}));
  }
  const kept = await hashPassword(PASSWORD, PEPPER);
  s.db.raw.prepare("INSERT INTO users (id, display_name, created_at, email, password_hash) VALUES ('new', 'N', 0, 'n@example.com', ?)").run(kept);
  const kinds = () => (s.db.raw.prepare('SELECT password_hash FROM users ORDER BY id').all() as { password_hash: string }[]).map(r => r.password_hash.split('$')[0]);

  assert.equal(await pepperStoredHashes({ DB: s.db }, 2), 0, 'without a pepper, nothing');
  assert.equal(await pepperStoredHashes({ DB: s.db, ...PEPPER }, 2), 2);
  assert.deepEqual(kinds().filter(k => k === 'pbkdf2').length, 1);
  await dailyMaintenance({ DB: s.db, ...PEPPER }, Date.now());
  assert.deepEqual(kinds(), ['pbkdf2-hmac', 'pbkdf2-hmac', 'pbkdf2-hmac', 'pbkdf2-hmac']);
  assert.equal((s.db.raw.prepare("SELECT password_hash FROM users WHERE id = 'new'").get() as { password_hash: string }).password_hash, kept);
  assert.equal((await s.login('l0@example.com')).status, 200);
});
