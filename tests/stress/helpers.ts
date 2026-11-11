// Shared fixtures for the stress suites.
import { weld } from '../../src/engine/mesh';
import { resolveConfig } from '../../src/profiles/resolve';
import type { Config, ParamDef } from '../../src/profiles/settings';
import type { MeshInput } from '../../src/engine/types';
import { parseGcode } from '../reverse-verifier/gcodeParser';

export const PRINTER = 'bbl-a1';
export const mesh = (soup: Float32Array, name = 'part'): MeshInput => { const m = weld(soup); return { id: name, name, vertices: m.vertices, indices: m.indices }; };
export const cfgWith = (sel: { overrides?: Config; machineOverrides?: Config; filamentOverrides?: Config } = {}, printerId = PRINTER, presetId = '0.20'): Config =>
  resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId, overrides: sel.overrides ?? {}, machineOverrides: sel.machineOverrides, filamentOverrides: sel.filamentOverrides });

/** Values a user can reach for a setting in the UI (inputs clamp to [min, max]): both ends, 0 when allowed, every option. */
export function edgeValues(p: ParamDef): Config[string][] {
  if (p.type === 'bool') return [!p.def];
  if (p.type === 'enum') return (p.options ?? []).map((o) => o.value).filter((v) => v !== p.def);
  if (p.type === 'string' || p.type === 'text') return [];
  if (p.type === 'floatOrPercent') return ['0', '0%', '400%', String(p.max ?? 10)];
  const vs = new Set<number>();
  if (p.min !== undefined) vs.add(p.min);
  if (p.max !== undefined) vs.add(p.max);
  if ((p.min ?? 0) <= 0) vs.add(0);
  vs.delete(p.def as number);
  return [...vs];
}

/** Seeded random numbers (Park–Miller), so a failing combination can be replayed. */
export function rng(seed: number) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

/** Filament (mm) laid by brim moves inside `where`, each move sampled along its length (read back from the G-code). */
export function brimFilament(gcode: string, where: (x: number, y: number) => boolean): number {
  let sum = 0, px = NaN, py = NaN;
  for (const m of parseGcode(gcode).moves) {
    if (m.isExtruding && /brim/i.test(m.feature ?? '') && Number.isFinite(px)) {
      const n = Math.max(1, Math.ceil(Math.hypot(m.x - px, m.y - py) / 0.25));
      for (let k = 1; k <= n; k++) if (where(px + ((m.x - px) * k) / n, py + ((m.y - py) * k) / n)) sum += m.e / n;
    }
    px = m.x; py = m.y;
  }
  return sum;
}

/** Closed tube (ring) standing on the bed: outer radius r, hole radius h. */
export function tube(cx: number, cy: number, r: number, h: number, height: number, seg = 64): Float32Array {
  const out: number[] = [];
  const P = (rad: number, a: number, z: number) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a), z];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const o0b = P(r, a0, 0), o1b = P(r, a1, 0), o0t = P(r, a0, height), o1t = P(r, a1, height);
    const i0b = P(h, a0, 0), i1b = P(h, a1, 0), i0t = P(h, a0, height), i1t = P(h, a1, height);
    out.push(...o0b, ...o1b, ...o1t, ...o0b, ...o1t, ...o0t);
    out.push(...i0b, ...i1t, ...i1b, ...i0b, ...i0t, ...i1t);
    out.push(...o0t, ...o1t, ...i1t, ...o0t, ...i1t, ...i0t);
    out.push(...o0b, ...i1b, ...o1b, ...o0b, ...i0b, ...i1b);
  }
  return new Float32Array(out);
}
