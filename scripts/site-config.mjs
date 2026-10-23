// Turns main's wrangler.jsonc into the test site's (Worker terminus-wm on https://terminus.wayne-mitchell.com).
// Used by scripts/build-test-site.mjs; run alone with: node scripts/site-config.mjs wrangler.jsonc
// Each replacement must match exactly once, so a change to main's file that breaks one fails loudly.
import { readFileSync, writeFileSync } from 'node:fs';

const EDITS = [
  ['"name": "terminuscli",', '"name": "terminus-wm",'],
  [
    '"routes": [{ "pattern": "terminuscli.com", "custom_domain": true }],',
    // Pull-request previews also live on the test domain: https://<branch>.terminus.wayne-mitchell.com
    '"routes": [{ "pattern": "terminus.wayne-mitchell.com", "custom_domain": true, "previews_enabled": true }],',
  ],
  // The test site is private: no workers.dev address (Cloudflare Access guards the domain)
  ['"workers_dev": true,', '"workers_dev": false,'],
  // VITE_TEST_SITE turns on the #/testing page and the strip that links to it
  ['"command": "npm test && npm run lint && VITE_BASE=/ npm run build"', '"command": "npm test && npm run lint && VITE_TEST_SITE=1 VITE_BASE=/ npm run build"'],
];

export function siteConfig(text) {
  let out = text;
  for (const [from, to] of EDITS) {
    const count = out.split(from).length - 1;
    if (count !== 1) throw new Error(`site-config: expected "${from}" once in wrangler.jsonc, found it ${count} times`);
    out = out.replace(from, to);
  }
  return `// Generated for the test site by scripts/site-config.mjs from main's wrangler.jsonc. Do not edit here.\n${out}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? 'wrangler.jsonc';
  writeFileSync(path, siteConfig(readFileSync(path, 'utf8')));
}
