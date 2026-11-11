// Shared helpers for the Advanced engine slicer tests.
import { expect } from 'vitest';
import { slice } from '../../src/engine/slicer';
import { resolveConfig } from '../../src/profiles/resolve';
import { indexed } from './shapes';
import type { TechId } from '../../src/engine/advanced/types';
import { FEATURE_ORDER, type SliceOutput } from '../../src/engine/types';

export const cfgFor = (printerId: string, overrides = {}, filamentId = 'generic-pla') => resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId, presetId: '0.20', overrides });
const ALL = ['fea_stress', 'sdf_frep', 'eulerian_spiral', 'conformal_layers', 'hot_on_hot', 'kinematic_extrusion', 'z_weave', 'subvoxel_aa', 'turing_infill', 'corner_overshoot', 'spatial_lattice', 'metamaterial', 'dovetail', 'sgd_slicing', 'eikonal_offsets', 'inverse_warp', 'gloss_modulation', 'foam_control', 'knot_braiding', 'co_molding', 'thick_vase', 'tangent_entry', 'scarf_splice', 'harmonic_dome', 'conformal_ironing', 'perimeter_feathering', 'iso_gloss', 'quasicrystal', 'metric_morph', 'monge_ampere', 'symplectic_shaper', 'morse_router', 'spinor_fields', 'band_gap', 'homogenization'] as TechId[];
export type Mesh = ReturnType<typeof indexed> & { paint?: { adv?: Uint8Array; color?: Uint8Array }; filament?: number };
/** Advanced slice with every technology off except the listed ones. */
export function adv(meshes: Mesh | Mesh[], printerId: string, on: TechId[], intent: 'structural' | 'aesthetic' | 'optical' | 'acoustic' | 'morph4d' = 'structural', o: { overrides?: Record<string, unknown>; params?: Record<string, Record<string, number | boolean | string>>; filamentId?: string; extra?: Record<string, unknown>; filaments?: unknown[] } = {}) {
  const techs: Record<string, { enabled: boolean; params?: Record<string, number | boolean | string> }> = Object.fromEntries(ALL.map((id) => [id, { enabled: on.includes(id) }]));
  for (const [id, p] of Object.entries(o.params ?? {})) techs[id] = { ...techs[id], params: p };
  const list = Array.isArray(meshes) ? meshes : [meshes];
  const out = slice(list as any, cfgFor(printerId, o.overrides, o.filamentId), () => {}, { advanced: { intent, printerId, techs, resolution: 'draft', ...(o.extra ?? {}) } as any, ...(o.filaments ? { filaments: o.filaments as any } : {}) });
  const rep = new Map(out.advanced!.techs.map((t) => [t.id, t]));
  return { out, rep };
}
export const sane = (g: string) => { expect(g).not.toMatch(/NaN|Infinity|undefined/); };
export const ran = (st?: string) => expect(['applied', 'adapted']).toContain(st);

/** Per-triangle paint from a predicate on the triangle centroid. */
export function paintBy(m: ReturnType<typeof indexed>, f: (x: number, y: number, z: number) => number): Uint8Array {
  const T = m.indices.length / 3, out = new Uint8Array(T), v = m.vertices, ix = m.indices;
  for (let t = 0; t < T; t++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) { x += v[ix[t * 3 + k] * 3] / 3; y += v[ix[t * 3 + k] * 3 + 1] / 3; z += v[ix[t * 3 + k] * 3 + 2] / 3; }
    out[t] = f(x, y, z);
  }
  return out;
}

/** Extrusion segments of a feature on a layer (from the packed moves): [x0, y0, x1, y1, z1, w]. */
export function segments(out: SliceOutput, layer: number, feature: string): number[][] {
  const L = out.layers[layer], f = FEATURE_ORDER.indexOf(feature as never), m = out.moves;
  const res: number[][] = [];
  for (let i = Math.max(1, L.moveStart); i < L.moveEnd; i++) {
    if (out.moveFeatures[i] !== f || m[i * 8 + 3] <= 0) continue;
    res.push([m[(i - 1) * 8], m[(i - 1) * 8 + 1], m[i * 8], m[i * 8 + 1], m[i * 8 + 2], m[i * 8 + 3]]);
  }
  return res;
}
export const layerAt = (out: SliceOutput, z: number) => out.layers.findIndex((l) => Math.abs(l.z - z) < 0.11);

