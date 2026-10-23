// Rebuilds the branch site/wayne-mitchell (the private test site, Worker terminus-wm) as:
//   main + every open pull request from this repository, merged in PR order
//   + the test site's wrangler.jsonc (scripts/site-config.mjs) + public/test-site.json (what the build holds).
// A pull request that does not merge cleanly is left out and listed as skipped. The branch is replaced each
// time (force push), so a closed pull request drops out on the next run. Run by .github/workflows/test-site.yml.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { siteConfig } from './site-config.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required');
const SITE_BRANCH = 'site/wayne-mitchell';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function openPulls() {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const pulls = await res.json();
  return pulls
    .filter(p => p.head.repo?.full_name === repo && p.head.ref !== SITE_BRANCH && p.base.ref === 'main')
    .sort((a, b) => a.number - b.number);
}

git('config', 'user.name', 'github-actions[bot]');
git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
git('fetch', '--no-tags', 'origin', 'main');
git('checkout', '-B', 'test-site-build', 'origin/main');
const mainSha = git('rev-parse', 'HEAD');

const included = [];
const skipped = [];
for (const pr of await openPulls()) {
  const entry = { number: pr.number, title: pr.title, url: pr.html_url };
  try {
    git('fetch', '--no-tags', 'origin', `refs/heads/${pr.head.ref}`);
    git('merge', '--no-ff', '--no-edit', '-m', `Test site: #${pr.number} ${pr.title}`, 'FETCH_HEAD');
    included.push(entry);
  } catch {
    try { git('merge', '--abort'); } catch { /* nothing to abort */ }
    skipped.push({ ...entry, reason: 'does not merge cleanly with main and the pull requests before it' });
  }
}

writeFileSync('wrangler.jsonc', siteConfig(readFileSync('wrangler.jsonc', 'utf8')));
writeFileSync('public/test-site.json', `${JSON.stringify({ builtAt: new Date().toISOString(), main: mainSha, included, skipped }, null, 2)}\n`);
git('add', 'wrangler.jsonc', 'public/test-site.json');
git('commit', '-m', `Test site: main ${mainSha.slice(0, 7)} + ${included.length} open pull request(s)`);
git('push', '--force', 'origin', `HEAD:refs/heads/${SITE_BRANCH}`);
console.log(`Pushed ${SITE_BRANCH}: main ${mainSha.slice(0, 7)}, included ${included.map(p => `#${p.number}`).join(' ') || 'none'}${skipped.length ? `, skipped ${skipped.map(p => `#${p.number}`).join(' ')}` : ''}`);
