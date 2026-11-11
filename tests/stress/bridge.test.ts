// The UI ↔ slicer-worker bridge: every way a slice can end is reported (never a silent stop, never stuck at
// "Preparing"), including the web version being redeployed while a tab is open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { slice } from '../../src/engine/slicer';
import { centreMesh } from '../../src/io/load';
import { primitive } from '../../src/state/ops';
import { centreOnBed } from '../../src/state/ops';
import { cancelSlice, sliceNow } from '../../src/state/slicing';
import { newId, useStore } from '../../src/state/store';
import { reportError, STALE_PAGE } from '../../src/state/errors';

type Mode = 'ok' | 'missing' | 'crash' | 'engine-error' | 'unclonable' | 'hang';
let mode: Mode = 'ok';
let serverHas = true;
let spaFallback = false;
let offline = false;
const created: FakeWorker[] = [];

class FakeWorker {
  onmessage: ((ev: { data: any }) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  constructor(public url: string | URL) { created.push(this); }
  terminate() { this.terminated = true; }
  postMessage(data: any) {
    if (mode === 'unclonable') throw new DOMException('function could not be cloned', 'DataCloneError');
    const err = (message?: string) => setTimeout(() => this.onerror?.({ message, preventDefault() {} }), 0);
    if (mode === 'missing' || mode === 'crash') return err(undefined); // a load failure or crash carries no message
    if (mode === 'hang') return;
    setTimeout(() => {
      if (this.terminated) return;
      if (mode === 'engine-error') { this.onmessage?.({ data: { id: data.id, type: 'error', message: 'boom (while slicing mesh)' } }); return; }
      const out = slice(data.meshes, data.cfg, (stage, pct) => this.onmessage?.({ data: { id: data.id, type: 'progress', stage, pct } }), data.opts);
      this.onmessage?.({ data: { id: data.id, type: 'done', out } });
    }, 0);
  }
}

const S = () => useStore.getState();
function plateWithBox() {
  const mesh = primitive('box', 20);
  centreMesh(mesh);
  const o = centreOnBed({ id: newId(), name: 'box', mesh, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: 0 }, 'bbl-a1');
  useStore.setState({ printerId: 'bbl-a1', objects: [o], selected: [o.id], activePlate: 0, plates: [{ id: 'plate1', name: 'Plate 1', layerActions: [] }], toast: null, slice: { status: 'idle', stage: '', progress: 0, result: null, error: null, dirty: true, plate: 0 } });
}

beforeEach(() => {
  mode = 'ok'; serverHas = true; spaFallback = false; offline = false; created.length = 0;
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('location', { href: 'https://example.github.io/NexSpiro/' });
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (offline) throw new TypeError('Failed to fetch');
    return { ok: serverHas || spaFallback, status: serverHas || spaFallback ? 200 : 404, headers: { get: () => (spaFallback ? 'text/html; charset=utf-8' : 'text/javascript') } };
  }));
  plateWithBox();
});
afterEach(() => { cancelSlice(); vi.unstubAllGlobals(); });

describe('slice bridge', () => {
  it('a normal slice ends in "done" with a result and stops the worker', async () => {
    const out = await sliceNow();
    expect(out?.stats.filamentMm).toBeGreaterThan(0);
    expect(S().slice.status).toBe('done');
    expect(created[0].terminated).toBe(true);
  });
  it('after a redeploy (worker script gone) the user is told to reload, not "stopped unexpectedly"', async () => {
    mode = 'missing'; serverHas = false;
    expect(await sliceNow()).toBeNull();
    expect(S().slice.status).toBe('error');
    expect(S().toast?.text).toMatch(/updated while this page was open.*reload the page/i);
  });
  it('a host that answers a missing file with its HTML page (single-page fallback) still gets the reload message', async () => {
    mode = 'missing'; serverHas = false; spaFallback = true;
    expect(await sliceNow()).toBeNull();
    expect(S().toast?.text).toMatch(/updated while this page was open/);
  });
  it('offline, the message says the slicer could not be loaded instead of blaming memory', async () => {
    mode = 'missing'; offline = true;
    expect(await sliceNow()).toBeNull();
    expect(S().toast?.text).toMatch(/could not be loaded \(offline/);
    expect(S().toast?.text).not.toMatch(/memory/);
  });
  it('a crash with the script still on the server points at memory', async () => {
    mode = 'crash';
    expect(await sliceNow()).toBeNull();
    expect(S().slice.status).toBe('error');
    expect(S().toast?.text).toMatch(/stopped unexpectedly.*memory/);
  });
  it('an engine error is shown with the stage it happened in', async () => {
    mode = 'engine-error';
    expect(await sliceNow()).toBeNull();
    expect(S().slice.error).toMatch(/boom \(while slicing mesh\)/);
    expect(S().toast?.kind).toBe('error');
  });
  it('data that cannot be sent to the worker fails cleanly instead of staying at "Preparing"', async () => {
    mode = 'unclonable';
    expect(await sliceNow()).toBeNull();
    expect(S().slice.status).toBe('error');
    expect(S().toast?.text).toMatch(/could not be sent to the slicer/);
  });
  it('cancel ends a running slice quietly', async () => {
    mode = 'hang';
    const p = sliceNow();
    expect(S().slice.status).toBe('slicing');
    cancelSlice();
    expect(await p).toBeNull();
    expect(S().slice.status).toBe('idle');
    expect(S().toast?.text).toMatch(/cancelled/);
  });
  it('a new slice replaces a running one; only the new one reports', async () => {
    mode = 'hang';
    const first = sliceNow();
    mode = 'ok';
    const second = sliceNow();
    expect(await first).toBeNull();
    expect((await second)?.stats.filamentMm).toBeGreaterThan(0);
    expect(created[0].terminated).toBe(true);
    expect(S().slice.status).toBe('done');
  });
  it('an object with a broken transform still slices (the store repairs it on the way in)', async () => {
    S().updateObjects((o) => ({ ...o, scale: [NaN, 1, 1], position: [o.position[0], o.position[1], Infinity] }));
    S().updateObjects((o) => ({ ...o, position: [o.position[0], o.position[1], 0] }));
    const out = await sliceNow();
    expect(out).not.toBeNull();
    expect(S().slice.status).toBe('done');
  });
  it('an empty plate says so', async () => {
    useStore.setState({ objects: [] });
    expect(await sliceNow()).toBeNull();
    expect(S().toast?.text).toMatch(/empty/);
  });
});

describe('error reporting', () => {
  it('shows unexpected errors once, ignores browser noise', () => {
    useStore.setState({ toast: null });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportError(new Error('ResizeObserver loop completed with undelivered notifications'));
    expect(S().toast).toBeNull();
    reportError(new Error('cannot read x'), 'Cut failed');
    expect(S().toast).toEqual({ kind: 'error', text: 'Cut failed: cannot read x' });
    useStore.setState({ toast: null });
    reportError(new Error('cannot read x'), 'Cut failed'); // same message within 2 s
    expect(S().toast).toBeNull();
    reportError(new DOMException('The user aborted a request.', 'AbortError'));
    expect(S().toast).toBeNull();
    err.mockRestore();
  });
  it('has a message for a lazily loaded tool missing after a redeploy', () => {
    expect(STALE_PAGE).toMatch(/reload the page/);
  });
});
