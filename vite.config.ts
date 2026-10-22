import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
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

/** Path pattern and headers of each rule in a Cloudflare `_headers` file (`/*` style splats only). */
export function parseHeadersFile(text: string): {pattern: string; headers: [string, string][]}[] {
  const rules: {pattern: string; headers: [string, string][]}[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      rules.push({pattern: line.trim(), headers: []});
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0 || !rules.length) throw new Error(`_headers: cannot read "${line.trim()}"`);
    rules[rules.length - 1].headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

const matchesPattern = (pattern: string, path: string) =>
  pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern;

/**
 * `vite preview` sends the headers of dist/_headers (copied from public/_headers), as Cloudflare does
 * in production, so the e2e suite runs the built app under the real CSP.
 */
function previewHeaders(): Plugin {
  return {
    name: 'preview-headers',
    configurePreviewServer(server) {
      const file = join(server.config.root, server.config.build.outDir, '_headers');
      if (!existsSync(file)) return;
      const rules = parseHeadersFile(readFileSync(file, 'utf8'));
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        for (const rule of rules) if (matchesPattern(rule.pattern, path)) for (const [k, v] of rule.headers) res.setHeader(k, v);
        next();
      });
    },
  };
}

/**
 * The GitHub Pages copy (VITE_ACCOUNTS=off) cannot send headers, so it gets the CSP of public/_headers
 * as a <meta> right after the charset, before any script. frame-ancestors is dropped: browsers ignore it in a <meta>.
 */
function metaCspWithoutAccounts(): Plugin {
  let publicDir = 'public';
  return {
    name: 'meta-csp-without-accounts',
    apply: 'build',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    transformIndexHtml(html) {
      if (process.env.VITE_ACCOUNTS !== 'off') return html;
      const rules = parseHeadersFile(readFileSync(join(publicDir, '_headers'), 'utf8'));
      const csp = rules.find(r => r.pattern === '/*')?.headers.find(([k]) => k.toLowerCase() === 'content-security-policy')?.[1];
      if (!csp) throw new Error('meta-csp-without-accounts: no Content-Security-Policy for /* in public/_headers');
      const content = csp
        .split(';')
        .map(d => d.trim())
        .filter(d => d && !d.startsWith('frame-ancestors'))
        .join('; ');
      const charset = '<meta charset="UTF-8" />';
      if (!html.includes(charset) || content.includes('"')) throw new Error('meta-csp-without-accounts: unexpected index.html or CSP');
      return html.replace(charset, `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${content}" />`);
    },
  };
}

export default defineConfig(() => {
  return {
    // Relative by default, so the build works from a GitHub Pages project path (/<repo>/).
    // Hosts that serve the app for any path (Cloudflare's SPA fallback) build with VITE_BASE=/ so a
    // deep link such as /old/path still loads /assets/... instead of /old/assets/...
    base: process.env.VITE_BASE || './',
    plugins: [react(), tailwindcss(), precacheBuildAssets(), previewHeaders(), metaCspWithoutAccounts()],
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
