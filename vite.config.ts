import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {defineConfig, type Plugin} from 'vite';

/** Writes the build's hashed asset list and a build id into dist/sw.js so the first visit caches everything. */
function precacheBuildAssets(): Plugin {
  let outDir = 'dist';
  let assets: string[] = [];
  return {
    name: 'precache-build-assets',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    generateBundle(_options, bundle) {
      assets = Object.keys(bundle).filter(f => f.startsWith('assets/') && !f.endsWith('.map')).sort();
    },
    closeBundle() {
      const swPath = join(outDir, 'sw.js');
      const buildId = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 12);
      const sw = readFileSync(swPath, 'utf8')
        .replace("const BUILD_ID = 'dev';", `const BUILD_ID = '${buildId}';`)
        .replace('const BUILD_ASSETS = [];', `const BUILD_ASSETS = ${JSON.stringify(assets.map(a => `./${a}`))};`);
      if (!sw.includes(buildId)) throw new Error('precache-build-assets: placeholders not found in sw.js');
      writeFileSync(swPath, sw);
    },
  };
}

/**
 * The headers public/_headers gives every static file on Cloudflare, for `vite preview`: the browser tests
 * run against the preview, so the whole suite runs under the live Content-Security-Policy, and a
 * violation (a console error) fails it. HSTS and upgrade-insecure-requests are left out on http://localhost.
 */
export function staticHeaders(text = readFileSync('public/_headers', 'utf8')): Record<string, string> {
  const headers: Record<string, string> = {};
  let all = false;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      all = line.trim() === '/*';
      continue;
    }
    const i = line.indexOf(':');
    if (!all || i < 0) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (name === 'Strict-Transport-Security') continue;
    headers[name] = name === 'Content-Security-Policy' ? value.replace(/;\s*upgrade-insecure-requests/, '') : value;
  }
  return headers;
}

export default defineConfig(() => {
  return {
    // Relative by default, so the build works from a GitHub Pages project path (/<repo>/).
    // Hosts that serve the app for any path (Cloudflare's SPA fallback) build with VITE_BASE=/ so a
    // deep link such as /old/path still loads /assets/... instead of /old/assets/...
    base: process.env.VITE_BASE || './',
    plugins: [react(), tailwindcss(), precacheBuildAssets()],
    preview: { headers: staticHeaders() },
    build: {
      rollupOptions: {
        output: {
          // Split by how often things change, so an app update does not re-download everything:
          // React and icons rarely change; command docs and course content change independently of the UI
          manualChunks: (id: string) => {
            if (/node_modules\/(react|react-dom|scheduler|lucide-react)\//.test(id)) return 'vendor';
            if (id.includes('/src/terminal/docs/')) return 'docs';
            if (id.includes('/src/data/')) return 'content';
            return undefined;
          },
        },
      },
    },
  };
});
