// Shared check for every printed stand, run per build from the stand-*.test.ts files (one worker each: slicing many stands in one worker runs out of memory).
import { expect } from 'vitest';
import { DEFAULT_SLICE, slice } from '../../src/workbench/generator';
import { defaultDesign, estimate, makeInner, OUTLINES, SECTIONS, surprise, type Design } from '../../src/workbench/design';
import { bulbFit, bulbPlace, fitOpening, fittingOf, fittingWarnings, holeDia, requiredFlip, SEAT_HOLDERS, seatNeed, seatOf, bulbsFor } from '../../src/workbench/fitting';
import { applyStand, buildStand, sliceStand, standSection, standSoup, STANDS } from '../../src/workbench/stand';
import { buildMesh, meshToStl } from '../../src/workbench/meshbuild';
import { areaTotal, pointIn, SCALE } from '../../src/engine/clipper';
import { holderById, bulbById, bulbLength } from '../../src/plugins/lumonex/catalog';
import { PRESETS } from '../../src/plugins/motionex/presets';

const brush = (id: string) => PRESETS.find((b) => b.id === id);
const S = { ...DEFAULT_SLICE, bedX: 420, bedY: 420 };
const TAU = Math.PI * 2;
const minIn = (d: Design, z: number) => { const f = makeInner(d); let m = Infinity; for (let j = 0; j < 90; j++) m = Math.min(m, f(z, (j / 90) * TAU)); return m; };
/** Radii of every extruded point on the given layers, about the bed centre. */
const radii = (r: ReturnType<typeof slice>, layers: (l: number) => boolean, kind?: string) =>
  r.segs.filter((g) => g.kind !== 'travel' && g.z > 0 && layers(g.layer) && (!kind || g.kind === kind) && !(g.x < 12 && g.x0 < 12)).map((g) => Math.hypot(g.x - S.bedX / 2, g.y - S.bedY / 2));

export type B = 'light' | 'standard' | 'heavy' | 'ballast';
export const STAND_IDS = STANDS.filter((t) => t.id !== 'none').map((t) => t.id);
/** One stand type in one build: fits the shade, holds the holder, prints without support (and, on a subset, slices to the right volume). */
export function checkStand(id: string, build: B) {
    const d = defaultDesign('shade'); d.fitting = fittingOf(d); applyStand(d.fitting, id as never); d.fitting.build = build === 'ballast' ? 'heavy' : build; d.fitting.ballast = build === 'ballast'; d.part = 'stand';
    const m = buildStand(d)!;
    const f = fittingOf(d);
    // the spigot fits inside the shade with a small clearance; the seat cone is wider than the shade's inside
    const inside = Math.min(minIn(d, 0), minIn(d, 1.5), minIn(d, 3));
    expect(inside - m.rim).toBeGreaterThan(0.2); expect(inside - m.rim).toBeLessThan(0.5);
    expect(m.flange).toBeGreaterThan(inside + 1);
    expect(m.holeR * 2).toBeCloseTo(40.8, 6);
    expect(m.height - m.deck).toBeCloseTo(f.standHeight, 6);
    if (build === 'ballast') expect(m.pause!.cm3).toBeGreaterThan(50);
    expect(f.standHeight).toBeGreaterThanOrEqual(holderById(f.holder).length + 20);
    expect(m.warnings).toEqual([]);
    // the hole is open and its rim is solid on every seat layer
    for (const z of [0.1, 1.5, Math.min(2.9, f.thickness - 0.1)]) {
      const sec = standSection(m, z);
      expect(pointIn(0, 0, sec)).toBe(false);
      expect(pointIn(m.holeR - 0.2, 0, sec)).toBe(false);
      for (let a = 0; a < 12; a++) expect(pointIn((m.holeR + 2) * Math.cos(a), (m.holeR + 2) * Math.sin(a), sec)).toBe(true);
    }
    // no support: every layer rests on the one below, within a 50° lean
    const dz = 0.4, grow = dz * Math.tan((50 * Math.PI) / 180) + 0.05;
    let prev = standSection(m, 0.01);
    expect(areaTotal(prev)).toBeGreaterThan(500);
    for (let z = dz; z < m.height - 0.01; z += dz) {
      const cur = standSection(m, z);
      expect(areaTotal(cur), `z=${z}`).toBeGreaterThan(20);
      for (const path of cur) for (let i = 0; i < path.length; i += 3) {
        const qx = path[i].X / SCALE, qy = path[i].Y / SCALE; let ok = pointIn(qx, qy, prev);
        for (let a = 0; !ok && a < 16; a++) ok = pointIn(qx + grow * Math.cos((a / 16) * TAU), qy + grow * Math.sin((a / 16) * TAU), prev);
        expect(ok, `${id} overhang at z=${z.toFixed(1)}`).toBe(true);
      }
      prev = cur;
    }
    // the feet end flat at the full height
    expect(areaTotal(standSection(m, m.height - 0.05))).toBeGreaterThan(50);
    // slicing is slow and memory-hungry: every type in the standard build, and one leg and one pedestal type in the others
    if (build !== 'standard' && !(id === 'tripod' || (id === 'hourglass' && build === 'light'))) return;
    // mesh and G-code
    const soup = standSoup(m); let zmax = 0; for (let k = 2; k < soup.length; k += 3) { expect(Number.isFinite(soup[k])).toBe(true); zmax = Math.max(zmax, soup[k]); }
    expect(zmax).toBeCloseTo(m.height, 3);
    const mesh = buildMesh(d, 'quick'); expect(mesh.triangles).toBe(soup.length / 9);
    const r = slice(d, { ...S, layerHeight: 0.3, firstLayerHeight: 0.3 }, [], brush);
    expect(r.gcode).toContain('stand'); expect(r.gcode).not.toMatch(/[XYZEF]-?(NaN|Infinity)/);
    expect(r.layers).toBe(Math.ceil(m.height / 0.3 - 1e-6));
    expect(Math.max(...r.layerZ)).toBeCloseTo(m.height, 3);
    // printed volume ≈ solid volume
    let vol = 0; for (let z = 0.15; z < m.height; z += 0.3) vol += areaTotal(standSection(m, z)) * 0.3;
    const printed = r.stats.filamentMm * Math.PI * (S.filamentDia / 2) ** 2 / S.flowRatio;
    expect(printed / vol).toBeGreaterThan(0.9); expect(printed / vol).toBeLessThan(build === 'light' || build === 'ballast' ? 1.12 : 1.08); // thin hollow walls overlap a little more
    // every extruded point is inside the solid
    const cx = S.bedX / 2, cy = S.bedY / 2;
    const secs = new Map<number, ReturnType<typeof standSection>>();
    let outside = 0, n = 0;
    for (const g of r.segs) { if (g.kind === 'travel' || g.layer < 1 || g.layer % 7) continue; let sec = secs.get(g.layer); if (!sec) { sec = standSection(m, r.layerZ[g.layer] - 0.15); secs.set(g.layer, sec); } n++; if (!pointIn(g.x - cx, g.y - cy, sec)) outside++; }
    expect(n).toBeGreaterThan(100); expect(outside).toBe(0);
  }
