import { defineConfig } from 'vite';

// Web app build for Cloudflare Pages: `npm run build:web` → dist-web/ (static files only).
export default defineConfig({
  root: 'web',
  base: '/',
  publicDir: 'public',
  worker: { format: 'es' },
  build: { outDir: '../dist-web', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
