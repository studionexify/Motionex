import { describe, expect, it } from 'vitest';
import { DEFAULT_SLICE, slice } from '../../src/workbench/generator';
import { defaultDesign, estimate, makeInner, OUTLINES, SECTIONS, surprise, type Design } from '../../src/workbench/design';
import { bulbFit, bulbPlace, fitOpening, fittingOf, fittingWarnings, holeDia, requiredFlip, SEAT_HOLDERS, seatNeed, seatOf, bulbsFor } from '../../src/workbench/fitting';
import { applyStand, buildStand, pauseCommand, sliceStand, standSection, standSoup, STANDS } from '../../src/workbench/stand';
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
  it('light, standard and heavy builds really differ in weight; light legs are hollow, heavy legs have pads', () => {
    const grams = (b: 'light' | 'standard' | 'heavy', id = 'tripod') => { const d = defaultDesign('shade'); d.fitting = fittingOf(d); applyStand(d.fitting, id as never); d.fitting.build = b; d.part = 'stand'; return { m: buildStand(d)!, g: estimate(d, 0.45, 0.2, 40).grams }; };
    for (const id of ['tripod', 'four', 'square', 'drum', 'cone', 'hourglass']) {
      const L = grams('light', id).g, M = grams('standard', id).g, Hv = grams('heavy', id).g;
      expect(L, id).toBeLessThan(M * 0.85); expect(Hv, id).toBeGreaterThan(M * 1.25);
    }
    const light = grams('light').m, mid = light.deck + (light.height - light.deck) / 2;
    const sec = standSection(light, mid), solid = standSection(grams('standard').m, mid);
    expect(areaTotal(sec)).toBeLessThan(areaTotal(solid) * 0.75);   // the legs are tubes
    const heavy = grams('heavy').m;
    expect(areaTotal(standSection(heavy, heavy.height - 0.1))).toBeGreaterThan(areaTotal(standSection(grams('standard').m, heavy.height - 0.1)) * 2);
  });
  it('heavy ballast: a sealed pocket, a pause where it can still be filled, and the seat stays clampable', () => {
    for (const id of ['tripod', 'drum']) {
      const d = defaultDesign('shade'); d.fitting = fittingOf(d); applyStand(d.fitting, id as never); d.fitting.build = 'heavy'; d.part = 'stand';
      const plain = buildStand(d)!; d.fitting.ballast = true; const m = buildStand(d)!;
      expect(m.deck - plain.deck).toBeCloseTo(12, 6);
      const p = m.pause!, ring = m.voids[0], rIn = ring.ha![0][0], rOut = ring.a[0][0], rMid = (rIn + rOut) / 2;
      // floor and lid are solid, the channel is open below the pause height and closed by the lid
      expect(pointIn(rMid, 0, standSection(m, 0.8))).toBe(true);
      expect(pointIn(rMid, 0, standSection(m, p.z - 0.5))).toBe(false);
      expect(pointIn(rMid, 0, standSection(m, m.deck - 0.8))).toBe(true);
      expect(areaTotal(standSection(m, p.z - 0.5))).toBeLessThan(areaTotal(standSection(plain, 5)) * 0.75);
      // counterbore: the seat plate is `thickness` thick, the holder body fits above it
      const f = fittingOf(d), body = holderById(f.holder).body / 2;
      expect(m.bore!).toBeGreaterThanOrEqual(body + 1);
      expect(pointIn(m.holeR + 0.5, 0, standSection(m, f.thickness - 0.3))).toBe(true);
      expect(pointIn(m.holeR + 0.5, 0, standSection(m, f.thickness + 0.3))).toBe(false);
      // the closed pocket is in the mesh as an inward-facing shell
      expect(standSoup(m).length).toBeGreaterThan(standSoup(plain).length);
      if (id !== 'tripod') continue; // a heavy stand is ~2 million moves: slice one
      // G-code: one pause, after the last layer at or below the roof start, for the chosen machine
      const r = slice(d, { ...S, printer: 'bbl-a1', layerHeight: 0.3, firstLayerHeight: 0.3 }, [], brush);
      const lines = r.gcode.split('\n'), at = lines.findIndex((l) => l === 'M400 U1');
      expect(lines.filter((l) => l === 'M400 U1').length).toBe(1);
      const zBefore = [...lines.slice(0, at)].reverse().find((l) => l.startsWith(';Z:'))!, zAfter = lines.slice(at).find((l) => l.startsWith(';Z:'))!;
      expect(+zBefore.slice(3)).toBeLessThanOrEqual(p.z + 1e-6); expect(+zAfter.slice(3)).toBeGreaterThan(p.z);
      expect(r.gcode).toMatch(/BALLAST PAUSE/);
    }
    expect(pauseCommand('elegoo-n4max')).toBe('PAUSE'); expect(pauseCommand('bbl-p1s')).toBe('M400 U1'); expect(pauseCommand('other')).toBe('M601');
  });
  it('light pedestals have pointed windows through the wall', () => {
    for (const id of ['drum', 'cone', 'hourglass']) {
      const d = defaultDesign('shade'); d.fitting = fittingOf(d); applyStand(d.fitting, id as never); d.fitting.build = 'light'; d.part = 'stand';
      const m = buildStand(d)!, zMid = (m.deck + 4 + m.height - 14 - 6) / 2;
      const sec = standSection(m, zMid);
      // between windows the wall is there, in a window it is not
      const nf = 4, nw = 2 * nf;
      let open = 0, solid = 0;
      for (let j = 0; j < nw; j++) for (const [a, want] of [[((j + 0.5) / nw) * TAU, 'open'], [((j + 1) / nw) * TAU, 'solid']] as const) {
        let hit = false; for (let r = 5; r < m.radius + 2 && !hit; r += 0.25) hit = pointIn(r * Math.cos(a), r * Math.sin(a), sec);
        if (want === 'open' && !hit) open++; if (want === 'solid' && hit) solid++;
      }
      expect(open, id).toBe(nw); expect(solid, id).toBe(nw);
    }
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
