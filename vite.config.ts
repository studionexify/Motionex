import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base: './'` lets the same build load from file:// inside Electron and from any web host.
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  test: { environment: 'node' },
} as any);
