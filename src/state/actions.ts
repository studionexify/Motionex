// User-level actions shared by menus, toolbar and keyboard shortcuts.
import { weld } from '../engine/mesh';
import { ImportCancelled, loadModelFile } from '../io/load';
import { askPrinterSwitch, importCancelled, importDone, importProgress, importStart } from '../ui/ImportDialog';
import { openModelFiles } from '../platform';
import { PRINTERS, printerById } from '../profiles/printers';
import { arrange, autoOrient, centreOnBed } from './ops';
import { plateObjects, sliceNow } from './slicing';
import { emptyProject, newId, plateOrigin, useStore, type SceneObject } from './store';
import { centreMesh } from '../io/load';

export async function importBuffers(files: { name: string; data: ArrayBuffer }[]) {
  const s = useStore.getState();
  const added: SceneObject[] = [];
  let placedExactly = false;
  for (const f of files) {
    if (/\.svg$/i.test(f.name)) {
      // SVG is a 2-D outline: it goes through the Text / Emboss tool rather than the mesh loader
      if (confirm(`SVG detected: ${f.name}. Load it into the Text/Emboss volume tool?`)) {
        const { offerSvg } = await import('./svgHandoff');
        offerSvg(f.name, new TextDecoder().decode(f.data));
        useStore.getState().set({ tool: 'text' });
      } else useStore.getState().set({ toast: { kind: 'info', text: `${f.name} was not imported.` } });
      continue;
    }
    importStart(f.name);
    try {
      if (/\.3mf$/i.test(f.name)) {
        const { isProject, loadProject } = await import('./project');
        if (await isProject(f.data)) {
          importDone();
          if (s.objects.length && !confirm(`Open project ${f.name}? The current plate will be replaced.`)) continue;
          await loadProject(f.data);
          useStore.getState().set({ toast: { kind: 'info', text: `Opened project ${f.name}` } });
          return;
        }
      }
      const models = /\.(step|stp|iges|igs|brep)$/i.test(f.name)
        ? await (await import('../io/cad')).loadCadFile(f.name, f.data)
        : await loadModelFile(f.name, f.data, importProgress, importCancelled);
      await importProgress(0.98, 'Placing on the plate');
      // the printer the file was made for (Bambu / Orca projects): ask to switch, like Bambu Studio
      const info = models[0]?.file;
      let exact = !!info?.bed && models.some((m) => m.local);
      if (info?.printerModel) {
        const want = PRINTERS.find((p) => `${p.vendor} ${p.model}`.toLowerCase() === info.printerModel!.toLowerCase() || p.model.toLowerCase() === info.printerModel!.toLowerCase());
        const cur = printerById(useStore.getState().printerId);
        if (want && want.id !== cur.id) {
          const c = await askPrinterSwitch(f.name, `${want.vendor} ${want.model}`, `${cur.vendor} ${cur.model}`);
          if (c === 'cancel') continue;
          if (c === 'switch') {
            const st = useStore.getState();
            st.set({ printerId: want.id, plate: want.plates.some((x) => x.type === st.plate) ? st.plate : want.plates[0].type, machineOverrides: {} });
          } else {
            // another bed: positions only carry over when the beds are the same size
            const nb = printerById(useStore.getState().printerId).bed;
            exact = exact && Math.abs(nb.x - info.bed![0]) < 1 && Math.abs(nb.y - info.bed![1]) < 1;
          }
        }
      }
      const pid = useStore.getState().printerId;
      // file plates go on fresh plates: from plate 1 on an empty project, after the last plate otherwise
      const st0 = useStore.getState();
      const firstPlate = st0.objects.length || added.length ? st0.plates.length : 0;
      if (exact) {
        const need = firstPlate + (info?.plateCount ?? 1);
        if (st0.plates.length < need) {
          const plates = st0.plates.slice();
          for (let i = plates.length; i < need; i++) plates.push({ id: newId(), name: `Plate ${i + 1}`, layerActions: [] });
          st0.set({ plates });
        }
        // the file's per-plate filament sequences
        const seqs = info?.plateSequences;
        if (seqs?.some(Boolean)) {
          const st1 = useStore.getState();
          st1.set({ plates: st1.plates.map((p, k) => (seqs[k - firstPlate] ? { ...p, filamentSequence: seqs[k - firstPlate] } : p)) });
        }
      }
      for (const m of models) {
        let o: SceneObject = { id: newId(), name: m.name, mesh: m.mesh, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: m.openEdges };
        if (m.filament) o.filament = m.filament;
        if (m.color) o.paint = { color: m.color };
        ensureSlots(m);
        if (exact && m.local) {
          const [ox, oy] = plateOrigin(firstPlate + (m.plate ?? 0), pid);
          o.position = [ox + m.local[0], oy + m.local[1], m.local[2]];
          placedExactly = true;
        } else o = centreOnBed(o, pid);
        added.push(o);
        if (m.openEdges && !m.color) s.set({ toast: { kind: 'warn', text: `${m.name}: mesh has ${m.openEdges} open edges and may not slice cleanly. Fix it with Fix model.` } });
      }
    } catch (e: any) {
      if (e instanceof ImportCancelled) s.set({ toast: { kind: 'info', text: `Import of ${f.name} cancelled.` } });
      else s.set({ toast: { kind: 'error', text: e?.message ?? `Could not open ${f.name}` } });
    } finally {
      importDone();
    }
  }
  if (!added.length) return;
  s.addObjects(added);
  // new models land in the centre of the active plate; several at once are spread around it (the rest stay put).
  // Objects placed from a project file keep their plates and positions.
  if (!placedExactly && added.length > 1) arrange(undefined, useStore.getState().activePlate, added.map((o) => o.id));
  s.set({ workspace: 'prepare' });
}

/** A coloured 3MF needs as many filament slots as its colours use; new slots take the file's colours.
 *  Slots the user already has keep their filament; empty slots of a fresh plate take the file's colours. */
function ensureSlots(m: { color?: Uint8Array; filament?: number; filamentColors?: string[] }) {
  const s = useStore.getState();
  let need = (m.filament ?? 0) + 1;
  if (m.color) for (let i = 0; i < m.color.length; i++) if (m.color[i] > need) need = m.color[i];
  const cols = m.filamentColors ?? [];
  if (need <= 1 && !cols.length) return;
  const fresh = !s.objects.length;
  const base = s.filaments[0];
  const next = s.filaments.slice();
  for (let k = 0; k < Math.max(need, next.length); k++) {
    const c = cols[k];
    if (k >= next.length) next.push({ presetId: base?.presetId ?? 'generic-pla', color: c ?? PALETTE[k % PALETTE.length] });
    else if (fresh && c && k < need) next[k] = { ...next[k], color: c };
  }
  if (next.length !== s.filaments.length || next.some((f, k) => f !== s.filaments[k])) {
    s.set({ filaments: next, flushMatrix: null });
    if (next.length > s.filaments.length) s.set({ toast: { kind: 'info', text: `${next.length} filament slots set up for the colours in this file.` } });
  }
}
const PALETTE = ['#5DBE7A', '#E04B4B', '#3B7DD8', '#F2C230', '#222222', '#FFFFFF', '#9B59B6', '#F28C28'];

export async function importDialog() {
  const files = await openModelFiles();
  if (files.length) await importBuffers(files);
}

export function newProject() {
  const s = useStore.getState();
  if (s.objects.length && !confirm('Start a new project? Unsaved changes on the plate will be lost.')) return;
  s.set({ objects: [], selected: [], selectedPart: null, undoStack: [], redoStack: [], workspace: 'prepare', project: emptyProject(), plates: [{ id: 'plate1', name: 'Plate 1', layerActions: [] }], activePlate: 0, slice: { status: 'idle', stage: '', progress: 0, result: null, error: null, dirty: true, plate: 0 } });
}

/** Slice the active plate; the Preview tab opens at once so the progress window is visible there. */
export async function sliceAndPreview() {
  const st = useStore.getState();
  if (st.slice.status === 'slicing') { st.set({ workspace: 'preview' }); return; }
  st.set({ workspace: 'preview' });
  const out = await sliceNow();
  const after = useStore.getState();
  // cancelled, failed or nothing to slice: back to Prepare (a replaced slice is still running, so stay)
  if (!out && after.slice.status !== 'slicing' && after.workspace === 'preview') after.set({ workspace: 'prepare' });
}

/** Slice every non-empty plate in turn (Snapmaker Orca's "Slice all"), then show a per-plate summary. The last
 *  sliced plate stays open in Preview; a cancelled or failed plate stops the run. */
export async function sliceAllPlates() {
  const st = useStore.getState();
  if (st.slice.status === 'slicing') return;
  const todo = st.plates.map((p, i) => ({ p, i })).filter(({ p, i }) => p.program || plateObjects(i).some((o) => o.printable !== false));
  if (!todo.length) { st.set({ toast: { kind: 'warn', text: 'Every plate is empty — add a model first.' } }); return; }
  st.set({ workspace: 'preview' });
  let secs = 0, grams = 0; const done: string[] = [];
  for (const { p, i } of todo) {
    useStore.getState().set({ activePlate: i });
    const out = await sliceNow();
    if (!out) { useStore.getState().set({ toast: { kind: 'error', text: `Slice all stopped at ${p.name}.` } }); return; }
    secs += out.stats.timeSeconds; grams += out.stats.filamentGrams; done.push(p.name);
  }
  const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
  useStore.getState().set({ toast: { kind: 'info', text: `Sliced ${done.length} plate${done.length > 1 ? 's' : ''}: ${h ? `${h} h ` : ''}${m} min, ${grams.toFixed(1)} g in total.` } });
}

export async function exportGcode() {
  const s = useStore.getState();
  let r = s.slice.result;
  if (!r || s.slice.dirty) r = await sliceNow();
  if (!r) return;
  const mx = r.pluginReports?.motionex as { check?: { blocking?: boolean; collisionCount?: number } } | undefined;
  if (mx?.check?.blocking) {
    s.set({ toast: { kind: 'error', text: `Motionex: the print head would hit the print in ${mx.check.collisionCount} spots. Export is stopped — see the Motionex panel.` } });
    return;
  }
  // same file as Export plate: filename_format, post-processing scripts, thumbnails, the sliced plate's objects
  const { exportPlateFile } = await import('./printjob');
  await exportPlateFile('gcode');
}

// ----- built-in sample models (procedural, no assets needed)
function boxSoup(sx: number, sy: number, sz: number, x0 = 0, y0 = 0, z0 = 0): number[] {
  const x1 = x0 + sx, y1 = y0 + sy, z1 = z0 + sz;
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return f.flatMap((t) => t.flatMap((i) => v[i]));
}
function tubeSoup(rOut: number, rIn: number, h: number, seg = 96): number[] {
  const out: number[] = [];
  const P = (r: number, a: number, z: number) => [r * Math.cos(a), r * Math.sin(a), z];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const o0b = P(rOut, a0, 0), o1b = P(rOut, a1, 0), o0t = P(rOut, a0, h), o1t = P(rOut, a1, h);
    out.push(...o0b, ...o1b, ...o1t, ...o0b, ...o1t, ...o0t);
    if (rIn > 0) {
      const i0b = P(rIn, a0, 0), i1b = P(rIn, a1, 0), i0t = P(rIn, a0, h), i1t = P(rIn, a1, h);
      out.push(...i0b, ...i1t, ...i1b, ...i0b, ...i0t, ...i1t);
      out.push(...o0t, ...o1t, ...i1t, ...o0t, ...i1t, ...i0t);
      out.push(...o0b, ...i1b, ...o1b, ...o0b, ...i0b, ...i1b);
    } else {
      out.push(0, 0, h, ...o0t, ...o1t, 0, 0, 0, ...o1b, ...o0b);
    }
  }
  return out;
}

export const SAMPLES: { id: string; name: string; description: string; make: () => number[] }[] = [
  { id: 'cube', name: 'Calibration cube', description: '20 mm cube for dimensional checks.', make: () => boxSoup(20, 20, 20) },
  { id: 'vase', name: 'Cylinder vase', description: 'Ø60 × 90 mm — try Spiral vase mode.', make: () => tubeSoup(30, 0, 90) },
  { id: 'ring', name: 'Ring', description: 'Ø40 tube, tests holes and seams.', make: () => tubeSoup(20, 14, 12) },
  { id: 'tee', name: 'Overhang test', description: 'T-shape that needs support or bridging.', make: () => [...boxSoup(10, 10, 15, -5, -5, 0), ...boxSoup(50, 10, 4, -25, -5, 15)] },
];

export function addSample(id: string) {
  const sm = SAMPLES.find((x) => x.id === id)!;
  const mesh = weld(new Float32Array(sm.make()));
  centreMesh(mesh);
  const s = useStore.getState();
  const o = centreOnBed({ id: newId(), name: sm.name, mesh, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: 0 }, s.printerId);
  s.addObjects([o]); // centre of the active plate
  s.set({ workspace: 'prepare' });
}

export { arrange, autoOrient };
