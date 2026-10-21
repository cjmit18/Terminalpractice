import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    // Relative base so the build works from a GitHub Pages project path as well as a domain root
    base: './',
    plugins: [react(), tailwindcss()],
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
