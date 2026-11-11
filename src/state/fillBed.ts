// Fill bed with copies: packs copies of one object around the others on its plate (see engine/nest.ts).
import { startWorker, workerFailure } from '../workers';
import * as THREE from 'three';
import { transformVertices } from '../engine/mesh';
import type { Mirror, NestPlacement, NestRequest } from '../engine/nest';
import { printerById } from '../profiles/printers';
import type { Config } from '../profiles/settings';
import { mirroredObject } from './objectOps';
import { currentConfig } from './slicing';
import { cloneObject, dropToBed, objectMatrix, objectPlate, plateOrigin, useStore, worldBounds, type SceneObject, type Vec3 } from './store';

export interface FillBedOptions {
  /** Minimum gap in mm toward N, NE, E, SE, S, SW, W, NW. */
  gaps: number[];
  edge: number;
  /** Rotation step in degrees; 0 = no rotation. */
  rotationStep: number;
  mirror: 'off' | 'x' | 'y' | 'auto';
  /** Cell size in mm. */
  precision: number;
  /** Most copies on the plate, the original included; 0 = as many as fit. */
  max: number;
}

export const DEFAULT_FILL: FillBedOptions = { gaps: Array(8).fill(2), edge: 0, rotationStep: 180, mirror: 'off', precision: 0.25, max: 0 };

const DEG = Math.PI / 180;

/** Room a brim or tree support takes around the part on the plate (normal supports stay under the part). */
export function footprintMargin(o: SceneObject, cfg: Config): { brim: number; support: number } {
  const c = { ...cfg, ...o.overrides };
  const n = (k: string) => Number(c[k] ?? 0) || 0;
  let brim = String(c.brim_type ?? 'no_brim');
  if (brim === 'auto_brim') {
    // same rule as the slicer: tall thin parts or small footprints get an outer brim
    const b = worldBounds(o);
    const minDim = Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1]);
    brim = (b.max[2] - b.min[2]) / Math.max(minDim, 0.1) > 3 || minDim < 6 ? 'outer_only' : 'no_brim';
  }
  const brimMm = brim !== 'no_brim' && n('brim_width') > 0 ? n('brim_object_gap') + n('brim_width') : 0;
  const tree = c.enable_support === true && String(c.support_type ?? '').startsWith('tree');
  const supportMm = tree ? n('support_object_xy_distance') + (n('tree_support_branch_diameter') || 6) / 2 : 0;
  return { brim: brimMm, support: supportMm };
}

/** World XY triangles of an object, shifted by (dx, dy). */
function xyTris(o: SceneObject, dx: number, dy: number): Float32Array {
  const v = transformVertices(o.mesh.vertices, objectMatrix(o).elements), ix = o.mesh.indices;
  const out = new Float32Array((ix.length / 3) * 6);
  for (let t = 0, k = 0; t < ix.length; t++, k += 2) { out[k] = v[ix[t] * 3] - dx; out[k + 1] = v[ix[t] * 3 + 1] - dy; }
  return out;
}

/** The object turned by `rotation` degrees about Z and mirrored, with its XY centre moved to (x, y). */
function placeCopy(o: SceneObject, p: NestPlacement, x: number, y: number): SceneObject {
  const base = p.mirror === 'none' ? o : mirroredObject(o, p.mirror === 'x' ? 0 : 1);
  const b = worldBounds(base);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
  const rz = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), p.rotation * DEG);
  const q = rz.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(base.rotation[0] * DEG, base.rotation[1] * DEG, base.rotation[2] * DEG, 'XYZ')));
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  const rel = new THREE.Vector3(base.position[0] - cx, base.position[1] - cy, 0).applyQuaternion(rz);
  const rotation = [e.x / DEG, e.y / DEG, e.z / DEG].map((v) => +v.toFixed(6)) as Vec3;
  return dropToBed({ ...base, position: [x + rel.x, y + rel.y, base.position[2]], rotation });
}

let worker: Worker | null = null;

/** Stop a fill that is still packing. */
export function cancelFillBed() { worker?.terminate(); worker = null; }

/** Pack the plate with copies of the object. Resolves to the number of copies on the plate (original included). */
export function fillBed(id: string, opt: FillBedOptions, onProgress?: (placed: number) => void): Promise<number> {
  const s = useStore.getState();
  const o = s.objects.find((x) => x.id === id);
  if (!o) return Promise.resolve(0);
  const plate = objectPlate(o, s.printerId, s.plates.length);
  if (s.plates[plate]?.locked) {
    s.set({ toast: { kind: 'warn', text: `${s.plates[plate].name} is locked. Unlock it to fill it.` } });
    return Promise.resolve(0);
  }
  const p = printerById(s.printerId);
  const [ox, oy] = plateOrigin(plate, s.printerId);
  const cfg = currentConfig(plate);
  const b = worldBounds(o);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
  const m = footprintMargin(o, cfg);
  const others = s.objects.filter((x) => x.id !== id && objectPlate(x, s.printerId, s.plates.length) === plate);
  const step = opt.rotationStep;
  const rotations = step > 0 ? Array.from({ length: Math.max(1, Math.round(360 / step)) }, (_, i) => i * step) : [0];
  const mirrors: Mirror[] = opt.mirror === 'off' ? ['none'] : opt.mirror === 'auto' ? ['none', 'x', 'y'] : ['none', opt.mirror];
  const req: NestRequest = {
    tris: xyTris(o, cx, cy),
    bed: { x: p.bed.x, y: p.bed.y },
    res: opt.precision,
    margin: Math.max(m.brim, m.support),
    gaps: opt.gaps,
    edge: opt.edge,
    rotations, mirrors,
    obstacles: others.map((x) => { const mm = footprintMargin(x, cfg); return { tris: xyTris(x, ox, oy), margin: Math.max(mm.brim, mm.support) }; }),
    excluded: p.excludedAreas ?? [],
    max: opt.max > 0 ? opt.max : undefined,
  };

  cancelFillBed();
  const w = startWorker('nest');
  worker = w;
  return new Promise((done) => {
    const finish = (n: number) => { if (worker === w) { w.terminate(); worker = null; } done(n); };
    w.onerror = (e) => {
      e.preventDefault?.();
      const report = (m: string) => { if (worker !== w) return; useStore.getState().set({ toast: { kind: 'error', text: `Fill bed failed: ${m}` } }); finish(0); };
      if (e.message) report(e.message); else void workerFailure('nest', 'arranging worker').then(report);
    };
    w.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === 'progress') { onProgress?.(msg.placed); return; }
      if (msg.type === 'error') { useStore.getState().set({ toast: { kind: 'error', text: `Fill bed failed: ${msg.message}` } }); finish(0); return; }
      const out = msg.out as NestPlacement[];
      const st = useStore.getState();
      if (!out.length || !st.objects.some((x) => x.id === id)) {
        st.set({ toast: { kind: 'info', text: 'There is no room on the plate for this object with these gaps.' } });
        finish(0);
        return;
      }
      const [first, ...rest] = out;
      const moved = placeCopy(o, first, ox + first.x, oy + first.y);
      const copies = rest.map((pl, k) => cloneObject(placeCopy(o, pl, ox + pl.x, oy + pl.y), { name: `${o.name} (${k + 2})` }));
      st.checkpoint();
      st.set({ objects: [...st.objects.map((x) => (x.id === id ? moved : x)), ...copies], selected: [id, ...copies.map((c) => c.id)], selectedPart: null });
      st.markDirty();
      const mirrored = rest.filter((pl) => pl.mirror !== 'none').length;
      const notes = [`${out.length} on the plate (${rest.length} new cop${rest.length === 1 ? 'y' : 'ies'}).`];
      if (mirrored) notes.push(`${mirrored} ${mirrored === 1 ? 'is' : 'are'} mirrored.`);
      st.set({ toast: { kind: 'info', text: notes.join(' ') } });
      finish(out.length);
    };
    w.postMessage({ id: 1, req }, [req.tris.buffer, ...req.obstacles.map((x) => x.tris.buffer)]);
  });
}
