import test from 'node:test';
import assert from 'node:assert/strict';
import { apiBase } from './apiBase.ts';

const api = (base: string, page: string) => new URL('api/me', apiBase(base, new URL(page).origin, page)).toString();

test('API URL: an absolute base ignores the page path', () => {
  assert.equal(api('/', 'https://app.example/old/path#/learn'), 'https://app.example/api/me');
  assert.equal(api('/', 'https://app.example/#/learn'), 'https://app.example/api/me');
  assert.equal(api('/certsim/', 'https://app.example/certsim/deep/link'), 'https://app.example/certsim/api/me');
});

test('API URL: a relative base resolves against the page, as on a GitHub Pages project path', () => {
  assert.equal(api('./', 'https://u.github.io/repo/#/learn'), 'https://u.github.io/repo/api/me');
  assert.equal(api('./', 'https://app.example/'), 'https://app.example/api/me');
});
