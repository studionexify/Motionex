import { describe, expect, it } from 'vitest';
import { DEFAULT_SLICE, slice } from '../../src/workbench/generator';
import { defaultDesign, makeInner, OUTLINES, SECTIONS, surprise, type Design } from '../../src/workbench/design';
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

describe('lamp holder seat', () => {
  it('a new pendant has an E27 shade-ring seat at the top with a nominal 40.5 mm hole + fit', () => {
    const d = defaultDesign('pendant'), s = seatOf(d)!;
    expect(s.top).toBe(true);
    expect(s.z1).toBe(d.height); expect(s.z1 - s.z0).toBeCloseTo(3, 6);
    expect(s.holeR * 2).toBeCloseTo(holderById('e27').ringHole + 0.3, 6);
    expect(requiredFlip(d)).toBe(true);
    expect(fittingWarnings(d)).toEqual([]);
  });
  it('every pendant / shade outline and section leaves room for the shade ring after fitting', () => {
    for (const fam of ['pendant', 'shade'] as const) for (const o of OUTLINES.filter((x) => x.families.includes(fam))) for (const sec of SECTIONS) for (const holder of SEAT_HOLDERS) {
      const d = defaultDesign(fam); d.profile = structuredClone(o.pts); if (o.h) d.height = o.h; if (o.d) d.maxDiameter = o.d; d.section = sec.id; d.sides = 7;
      d.fitting = { ...fittingOf(d), holder: holder.id, stand: 'none' };
      fitOpening(d);
      const s = seatOf(d)!;
      expect(Math.min(minIn(d, (s.z0 + s.z1) / 2), minIn(d, s.top ? s.z0 : s.z1)), `${fam}/${o.id}/${sec.id}/${holder.id}`).toBeGreaterThanOrEqual(seatNeed(d));
    }
  });
  it('hole sizes follow the mount: shade ring, M10 nipple, cord', () => {
    const d = defaultDesign('pendant');
    for (const h of SEAT_HOLDERS) expect(holeDia({ ...fittingOf(d), holder: h.id })).toBeCloseTo(h.ringHole + 0.3, 6);
    expect(holeDia({ ...fittingOf(d), seat: 'grip' })).toBeCloseTo(10.5, 6);
    expect(holeDia({ ...fittingOf(d), seat: 'cord' })).toBeCloseTo(7.5, 6);
    expect(holeDia({ ...fittingOf(d), hole: 42 })).toBe(42);
    expect(SEAT_HOLDERS.map((h) => h.id)).toEqual(expect.arrayContaining(['e27', 'e14', 'b22', 'b15', 'e26', 'e12']));
  });
  it('prints the seat first on the bed: solid rings around a clean round hole, upside down for a pendant', () => {
    const d = defaultDesign('pendant'), s = seatOf(d)!;
    const r = slice(d, { ...S, flip: false }, [], brush);          // the wrong orientation is corrected
    expect(r.warnings.join(' ')).toMatch(/upside down/);
    expect(r.gcode).not.toMatch(/[XYZEF]-?(NaN|Infinity)/);
    const seatLayers = r.layerZ.filter((z) => z <= 3 + 1e-6).length;
    expect(seatLayers).toBeGreaterThan(8);
    const lw = S.lineWidth;
    for (const li of [0, 1, seatLayers - 1]) {
      const rr = radii(r, (l) => l === li, 'base');
      // nothing is printed inside the hole, and the innermost line hugs it
      expect(Math.min(...rr)).toBeGreaterThanOrEqual(s.holeR + lw / 2 - 0.02);
      expect(Math.min(...rr)).toBeLessThanOrEqual(s.holeR + lw / 2 + 0.02);
      // the rings reach the wall with no gap wider than a line
      const sorted = [...new Set(rr.map((v) => Math.round(v * 50) / 50))].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeLessThanOrEqual(lw + 0.03);
      const wallR = minIn(d, d.height - r.layerZ[li]);
      expect(Math.max(...rr)).toBeGreaterThan(wallR - 2 * lw);
    }
    // above the seat the piece is a plain wall again: nothing inside it
    const above = radii(r, (l) => l === seatLayers + 2);
    expect(Math.min(...above)).toBeGreaterThan(s.holeR + 1);
    expect(above.length).toBeGreaterThan(10);
  });
  it('the seat volume printed matches the plate (flow is exact)', () => {
    const d = defaultDesign('pendant'), s = seatOf(d)!, r = slice(d, S, [], brush);
    const fa = Math.PI * (S.filamentDia / 2) ** 2;
    const n = r.layerZ.filter((z) => z <= 3 + 1e-6).length;
    const li = 3, zTop = r.layerZ[li], wallIn = minIn(d, d.height - zTop);
    const printed = r.segs.filter((g) => g.layer === li && g.kind === 'base').reduce((a, g) => a + g.e, 0) * fa;
    const plate = Math.PI * (wallIn ** 2 - s.holeR ** 2) * S.layerHeight * S.flowRatio;
    expect(n).toBeGreaterThan(li);
    expect(printed / plate).toBeGreaterThan(0.93); expect(printed / plate).toBeLessThan(1.05);
  });
  it('a table shade without a stand carries the seat at the bottom and prints upright', () => {
    const d = defaultDesign('shade'); d.fitting = { ...fittingOf(d), stand: 'none' }; fitOpening(d);
    const s = seatOf(d)!;
    expect(s.top).toBe(false); expect(s.z0).toBe(0); expect(requiredFlip(d)).toBe(false);
    const r = slice(d, { ...S, flip: true }, [], brush);
    const rr = radii(r, (l) => l === 0, 'base');
    expect(Math.min(...rr)).toBeCloseTo(s.holeR + S.lineWidth / 2, 1);
  });
  it('the mesh has the seat: a flat ring with the hole, and the STL is valid', () => {
    const d = defaultDesign('pendant'), s = seatOf(d)!, m = buildMesh(d, 'quick');
    const p = m.position; let onTop = 0, minR = Infinity;
    for (let k = 0; k < p.length; k += 3) if (Math.abs(p[k + 2] - s.z0) < 1e-4) { const r = Math.hypot(p[k], p[k + 1]); if (r < 60) { onTop++; minR = Math.min(minR, r); } }
    expect(onTop).toBeGreaterThan(100);
    expect(minR).toBeCloseTo(s.holeR, 3);
    for (let k = 0; k < p.length; k++) expect(Number.isFinite(p[k])).toBe(true);
    expect(m.src.length).toBe(p.length / 3);
    expect(meshToStl(m).byteLength).toBe(84 + (p.length / 9) * 50);
    const plain = buildMesh(defaultDesign('vase'), 'quick');
    expect(plain.triangles).toBeGreaterThan(0);
  });
  it('checks the real bulb against the wall', () => {
    const d = defaultDesign('pendant'), p = bulbPlace(d)!;
    // socket mouth 20 mm below the seat; an A60 is 108 mm long
    expect(p.mouth).toBeCloseTo(seatOf(d)!.z0 - holderById('e27').above, 6);
    expect(bulbLength(bulbById('a60'))).toBe(108);
    expect(bulbFit(d)!.gap).toBeGreaterThan(20);
    const tight = { ...d, maxDiameter: 90, fitting: { ...fittingOf(d), bulb: 'g125' } };
    expect(fittingWarnings(tight).join(' ')).toMatch(/does not fit|from the wall/);
    for (const h of SEAT_HOLDERS) expect(bulbsFor(h.id).length).toBeGreaterThan(0);
    expect(fittingWarnings({ ...d, fitting: { ...fittingOf(d), holder: 'e14' } }).join(' ')).toMatch(/does not fit the E14/);
  });
  it('surprise pieces and saved pieces without a fitting still slice', () => {
    for (let i = 0; i < 6; i++) { const d = surprise('pendant'); d.height = Math.min(d.height, 60); expect(slice(d, { ...S, layerHeight: 0.3 }, [], brush).gcode).not.toMatch(/NaN|Infinity/); }
    const old = defaultDesign('pendant'); delete old.fitting; old.height = 40;
    expect(slice(old, S, [], brush).segs.length).toBeGreaterThan(100);
    const vase = defaultDesign('vase'); expect(seatOf(vase)).toBeNull(); expect(requiredFlip(vase)).toBeNull();
  });
});

describe('table shade stands', () => {
  const kinds = STANDS.filter((t) => t.id !== 'none');
  it('offers a long list of stands', () => { expect(kinds.length).toBeGreaterThanOrEqual(12); });
  it.each(kinds.map((t) => [t.id]))('%s: fits the shade, holds the holder, prints without support', (id) => {
    const d = defaultDesign('shade'); d.fitting = fittingOf(d); applyStand(d.fitting, id as never); d.part = 'stand';
    const m = buildStand(d)!;
    const f = fittingOf(d);
    // the spigot fits inside the shade with a small clearance; the seat cone is wider than the shade's inside
    const inside = Math.min(minIn(d, 0), minIn(d, 1.5), minIn(d, 3));
    expect(inside - m.rim).toBeGreaterThan(0.2); expect(inside - m.rim).toBeLessThan(0.5);
    expect(m.flange).toBeGreaterThan(inside + 1);
    expect(m.holeR * 2).toBeCloseTo(40.8, 6);
    expect(m.height - m.deck).toBeCloseTo(f.standHeight, 6);
    expect(f.standHeight).toBeGreaterThanOrEqual(holderById(f.holder).length + 20);
    expect(m.warnings).toEqual([]);
    // the hole is open and its rim is solid on every seat layer
    for (const z of [0.1, 1.5, 2.9]) {
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
    expect(printed / vol).toBeGreaterThan(0.9); expect(printed / vol).toBeLessThan(1.08);
    // every extruded point is inside the solid
    const cx = S.bedX / 2, cy = S.bedY / 2;
    const secs = new Map<number, ReturnType<typeof standSection>>();
    let outside = 0, n = 0;
    for (const g of r.segs) { if (g.kind === 'travel' || g.layer < 1 || g.layer % 7) continue; let sec = secs.get(g.layer); if (!sec) { sec = standSection(m, r.layerZ[g.layer] - 0.15); secs.set(g.layer, sec); } n++; if (!pointIn(g.x - cx, g.y - cy, sec)) outside++; }
    expect(n).toBeGreaterThan(100); expect(outside).toBe(0);
  });
  it('the shade on a stand has no seat of its own and prints upright; the stand never flips', () => {
    const d = defaultDesign('shade');
    expect(fittingOf(d).stand).toBe('tripod'); expect(seatOf(d)).toBeNull(); expect(requiredFlip(d)).toBeNull();
    expect(requiredFlip({ ...d, part: 'stand' })).toBe(false);
    expect(sliceStand({ ...d, part: 'stand' }, { ...S, flip: true }).warnings).toEqual([]);
    expect(bulbPlace(d)!.dir).toBe(1);
    expect(fittingWarnings(d)).toEqual([]);
  });
  it('follows a small, non-round shade and warns when the stand is too low', () => {
    const d = defaultDesign('shade'); d.maxDiameter = 110; d.section = 'star'; d.sides = 6; d.part = 'stand';
    const m = buildStand(d)!; expect(m.rim).toBeLessThan(Math.min(minIn(d, 0), minIn(d, 3)));
    expect(sliceStand(d, S).gcode).not.toMatch(/NaN|Infinity/);
    d.fitting = { ...fittingOf(d), standHeight: 40 };
    expect(buildStand(d)!.warnings.join(' ')).toMatch(/need about 75 mm/);
  });
});
