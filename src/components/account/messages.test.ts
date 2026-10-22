import test from 'node:test';
import assert from 'node:assert/strict';
import { describeError, emailError, newPasswordError, normalizeEmail, passwordLengthHint, returnErrorMessage } from './messages.ts';
import { parseHash, routeHref } from '../../lib/router.ts';

test('error codes become plain messages, tied to a field when there is one', () => {
  assert.match(describeError('invalid_credentials', 401).message, /don’t match an account/);
  assert.equal(describeError('last_method', 409).field, undefined);
  assert.match(describeError('last_method', 409).message, /only way you can sign in/);
  assert.equal(describeError('wrong_password', 400).field, 'currentPassword');
  assert.equal(describeError('common_password', 400).field, 'password');
  assert.match(describeError('anything', 429, undefined, 300).message, /5 minutes/);
  // Unknown codes use the server's sentence, without exclamation marks
  assert.equal(describeError('new_code', 400, 'Something new happened!').message, 'Something new happened.');
  assert.match(describeError('http_500', 500).message, /server/);
  for (const m of [describeError('network', 0).message, describeError('x', 404).message]) assert.ok(!m.includes('!'));
});

test('password and email checks', () => {
  assert.match(passwordLengthHint(''), /at least 10/);
  assert.match(passwordLengthHint('abc'), /7 more characters/);
  assert.equal(passwordLengthHint('abcdefghij'), 'Long enough.');
  assert.equal(newPasswordError('abcdefghij'), null);
  assert.match(newPasswordError('short') ?? '', /at least 10/);
  assert.match(newPasswordError('me@example.com', 'ME@example.com ') ?? '', /same as your email/);
  assert.equal(emailError('me@example.com'), null);
  assert.ok(emailError('nope'));
});

test('emails are NFC-normalized and trimmed, and lookalike forms are refused', () => {
  const nfd = 'cafe\u0301@example.com';
  assert.equal(normalizeEmail(`  ${nfd}\n`), 'caf\u00e9@example.com');
  assert.equal(normalizeEmail(nfd), normalizeEmail('caf\u00e9@example.com'));
  assert.equal(emailError(' caf\u00e9@example.com '), null);
  for (const bad of ['x<attacker@evil.example>', '"a"@b.c', 'a@b.c>', 'a@b.c\u200b', 'a\u202e@b.c', 'a,b@c.d']) {
    assert.ok(emailError(bad), bad);
  }
});

test('link and sign-in-again errors have plain messages', () => {
  assert.match(returnErrorMessage('identity_in_use'), /already linked to a different account/);
  assert.match(returnErrorMessage('provider_already_linked'), /Unlink it first/);
  assert.match(returnErrorMessage('not_signed_in'), /Sign in, then try again/);
  assert.match(returnErrorMessage('reauth_failed'), /could not confirm it was you/);
  assert.match(returnErrorMessage('email_unverified'), /Verify your email first/);
  assert.match(returnErrorMessage('something_new'), /nothing was changed/);
  assert.equal(describeError('reauth_required', 403).message, 'For your security, sign in again to continue.');
});

test('account routes parse with or without a one-time token', () => {
  assert.deepEqual(parseHash('#/account'), { section: 'account', page: 'home' });
  assert.deepEqual(parseHash('#/account/settings'), { section: 'account', page: 'settings' });
  assert.deepEqual(parseHash('#/account/reset?token=abc'), { section: 'account', page: 'reset' });
  assert.deepEqual(parseHash('#/account/verify?token=abc'), { section: 'account', page: 'verify' });
  assert.equal(parseHash('#/account/home'), null);
  assert.equal(parseHash('#/account/nope'), null);
  assert.equal(parseHash('#/account/settings/x'), null);
  assert.equal(routeHref({ section: 'account', page: 'home' }), '#/account');
  assert.equal(routeHref({ section: 'account', page: 'security' }), '#/account/security');
  // Other routes are unchanged
  assert.deepEqual(parseHash('#/learn'), { section: 'learn', pathId: null, stepId: null });
  assert.equal(parseHash('#/accounts'), null);
});
