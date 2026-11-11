// Bundles the Electron main process (TypeScript + mqtt/basic-ftp) into electron/dist/main.cjs.
import { build } from 'esbuild';
await build({
  entryPoints: ['electron/src/main.ts'],
  outfile: 'electron/dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: false,
  minify: true,
  logLevel: 'warning',
});
console.log('electron/dist/main.cjs built');
