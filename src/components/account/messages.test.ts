import test from 'node:test';
import assert from 'node:assert/strict';
import { describeError, emailError, newPasswordError, passwordLengthHint } from './messages.ts';

test('account errors read as plain sentences, tied to the field they belong to', () => {
  assert.deepEqual(describeError('email_taken', 409).field, 'email');
  assert.match(describeError('invalid_credentials', 401).message, /don’t match an account/);
  assert.equal(describeError('rate_limited', 429, undefined, 61).message, 'Too many tries in a short time. Try again in 2 minutes.');
  // An unknown code uses the server's own sentence; without one, the status decides
  assert.equal(describeError('brand_new_code', 400, 'Something specific happened!').message, 'Something specific happened.');
  assert.match(describeError('http_503', 503).message, /aren’t available on this site/);
});

test('form checks before sending: email shape and password length', () => {
  assert.equal(emailError(''), 'Enter your email address.');
  assert.ok(emailError('Name <a@b.com>'));
  assert.equal(emailError(' casey@example.com '), null);
  assert.equal(newPasswordError('short'), 'Use at least 10 characters.');
  assert.equal(newPasswordError('a long enough passphrase'), null);
  assert.equal(passwordLengthHint('abcdefgh'), '2 more characters needed (at least 10).');
});
