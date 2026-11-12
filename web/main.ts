// Motionex web app (Cloudflare Pages). Everything — design, slicing, print physics, preview — runs in this
// browser on this computer. Printers are reached through the Motionex printer bridge on the local network.
import { mountStudio } from '../src/workbench/studio';
import { makeHost } from '../src/workbench/host';
import { initDevices, reloadDevices } from '../src/state/devices';
import { bridge } from '../src/connect/wsbridge';
import { idb } from './idb';
import '../src/workbench/studio.css';

const host = makeHost({ bridge });

function download(name: string, data: Uint8Array) {
  const url = URL.createObjectURL(new Blob([data as BlobPart]));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

mountStudio(document.getElementById('app')!, {
  host,
  save: async (name, data) => download(name, data),
  worker: () => new Worker(new URL('../src/workbench/slice.worker.ts', import.meta.url), { type: 'module' }),
  storage: idb,
});

// Reconnect to the bridge if this browser was paired before; printers load once it's ready.
void (async () => {
  if (bridge.saved.code && (await bridge.connect())) await reloadDevices();
  else await initDevices();
})();
