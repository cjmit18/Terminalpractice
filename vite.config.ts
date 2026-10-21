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

export default defineConfig(() => {
  return {
    // Relative base so the build works from a GitHub Pages project path as well as a domain root
    base: './',
    plugins: [react(), tailwindcss(), precacheBuildAssets()],
    build: {
      rollupOptions: {
        output: {
          // React and the icon set change rarely; a separate chunk stays cached across app updates
          manualChunks: (id: string) => (/node_modules\/(react|react-dom|scheduler|lucide-react)\//.test(id) ? 'vendor' : undefined),
        },
      },
    },
  };
});
