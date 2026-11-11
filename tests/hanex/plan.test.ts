// End-to-end checks on the spec scenario: every invariant a printer would punish.
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import { referenceScenario } from '../../src/plugins/hanex/core/scenario';
import { planLayer } from '../../src/plugins/hanex/core/layer';
import { emitMoves } from '../../src/plugins/hanex/core/gcode';
import { preset, waveStep, filamentArea } from '../../src/plugins/hanex/core/profile';
import { dist, pointInRings, distToSegment, type Vec2 } from '../../src/plugins/hanex/core/geom';
import type { RegionPlan } from '../../src/plugins/hanex/core/plan';

const sc = referenceScenario();
const P = preset('hanex-pla');
const step = waveStep(P), w = P.lineWidth;
const results = (['point', 'edge'] as const).map((seedMode) => {
  const p = { ...P, seedMode };
  return { seedMode, p, layer: planLayer(sc.current, sc.below, p, [0, 0]) };
});

const extrusionPoints = (pl: RegionPlan) => {
  const pts: { q: Vec2; kind: string; from: Vec2 }[] = [];
  let prev: Vec2 = [NaN, NaN];
  for (const m of pl.moves) { if (m.kind !== 'travel') pts.push({ q: [m.x, m.y], kind: m.kind, from: prev }); prev = [m.x, m.y]; }
  return pts;
};

for (const { seedMode, p, layer } of results) describe(`reference scenario, ${seedMode} seeding`, () => {
  const pl = layer.plans[0];

  test('one overhang component, no warnings, expected seed mode', () => {
    assert.equal(layer.plans.length, 1);
    assert.deepEqual(layer.warnings, []);
    assert.equal(pl.seedMode, seedMode);
    assert.ok(pl.arcs.length > 50, `${pl.arcs.length} arcs`);
  });

  test('collision-safe: no bead centre within half a bead of the hole or outside the printable region', () => {
    const { c, r } = sc.hole;
    for (const { q, from } of extrusionPoints(pl)) {
      assert.ok(dist(q, c) >= r + w / 2 - 0.01, `vertex ${q} at ${dist(q, c)} from hole centre`);
      if (Number.isFinite(from[0])) assert.ok(distToSegment(c, from, q) >= r + w / 2 - 0.01, `segment ${from}→${q} cuts the hole`);
      assert.ok(pointInRings(q[0], q[1], pl.printable) || pl.printable.some((ring) => ring.some((v, i) => distToSegment(q, v, ring[(i + 1) % ring.length]) < 1e-3)), `vertex ${q} outside printable`);
    }
  });

  test('every wave point is laid next to material that already exists (anchor or an earlier arc)', () => {
    // spatial hash of printed points
    const cell = step, grid = new Map<string, Vec2[]>();
    const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    const add = (q: Vec2) => { const k = key(q[0], q[1]); const l = grid.get(k); if (l) l.push(q); else grid.set(k, [q]); };
    const near = (q: Vec2, rad: number) => {
      const cx = Math.floor(q[0] / cell), cy = Math.floor(q[1] / cell), n = Math.ceil(rad / cell);
      for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) for (const v of grid.get(`${cx + i},${cy + j}`) ?? []) if (dist(v, q) <= rad) return true;
      return false;
    };
    let worst = 0;
    for (const arc of pl.arcs) {
      // densify to 0.1 mm so long straight chords are checked along their length
      const dense: Vec2[] = [];
      for (let i = 1; i < arc.pts.length; i++) {
        const a = arc.pts[i - 1], b = arc.pts[i], n = Math.max(1, Math.ceil(dist(a, b) / 0.1));
        for (let t = 0; t < n; t++) dense.push([a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n]);
      }
      for (const q of dense) {
        if (!pointInRings(q[0], q[1], pl.overhangRings)) continue; // on solid
        // distance to the anchor boundary or to earlier arcs must be within one wave step (+ grid tolerance)
        const toAnchor = Math.min(...pl.anchorRings.flatMap((r) => r.map((v, i) => distToSegment(q, v, r[(i + 1) % r.length]))));
        if (toAnchor <= step + 0.02) continue;
        if (!near(q, step * 1.5)) worst++;
      }
      dense.forEach(add);
    }
    assert.equal(worst, 0, `${worst} wave points have no printed neighbour within 1.5·Δd`);
  });

  test('first front is tacked to the anchor; in point mode arcs that reach the anchor run ≤ leadIn onto it', () => {
    const first = pl.arcs.filter((a) => a.k === pl.arcs[0].k);
    const toAnchor = (q: Vec2) => Math.min(...pl.anchorRings.flatMap((r) => r.map((v, i) => distToSegment(q, v, r[(i + 1) % r.length]))));
    for (const a of first) for (const q of a.pts) assert.ok(toAnchor(q) <= step + 0.02 || !pointInRings(q[0], q[1], pl.overhangRings), `first front point ${q} not tacked`);
    if (seedMode === 'edge') return; // straight fronts end on the free sides; only the rim ties them
    let clamped = 0;
    for (const arc of pl.arcs) for (const end of [arc.pts[0], arc.pts[arc.pts.length - 1]]) {
      if (pointInRings(end[0], end[1], pl.overhangRings)) continue;
      clamped++;
      const depth = Math.min(...pl.overhangRings.flatMap((r) => r.map((v, i) => distToSegment(end, v, r[(i + 1) % r.length]))));
      assert.ok(depth <= p.leadIn + 1e-3, `end ${end} is ${depth} mm into the anchor`);
    }
    assert.ok(clamped > 0, 'some arcs end on solid');
    // the first arcs (nearest the anchor) start and end on solid
    const firstArcs = pl.arcs.filter((a) => a.k === pl.arcs[0].k);
    for (const a of firstArcs) for (const e of [a.pts[0], a.pts[a.pts.length - 1]]) assert.ok(!pointInRings(e[0], e[1], pl.overhangRings), 'first arc must clamp at both ends');
  });

  test('coverage: every point of the overhang is within half a wave step (+ grid tolerance) of a bead centre', () => {
    const segs: [Vec2, Vec2][] = [];
    let prev: Vec2 | null = null;
    for (const m of pl.moves) { const q: Vec2 = [m.x, m.y]; if (m.kind !== 'travel' && prev) segs.push([prev, q]); prev = q; }
    const [x0, y0, x1, y1] = sc.overhangRect;
    let gaps = 0, total = 0;
    for (let x = x0 + w / 2 + 0.05; x < x1 - w / 2; x += 0.37) for (let y = y0 + 0.05; y < y1 - w / 2; y += 0.37) {
      if (dist([x, y], sc.hole.c) < sc.hole.r + w / 2 + 0.05) continue;
      total++;
      let d = Infinity;
      for (const [a, b] of segs) {
        if (Math.min(a[0], b[0]) - x > 1 || x - Math.max(a[0], b[0]) > 1 || Math.min(a[1], b[1]) - y > 1 || y - Math.max(a[1], b[1]) > 1) continue;
        d = Math.min(d, distToSegment([x, y], a, b));
      }
      if (d > step / 2 + 0.03 && d > w / 2) gaps++;
    }
    assert.ok(total > 5000);
    assert.equal(gaps, 0, `${gaps}/${total} sample points uncovered`);
  });

  test('volumetric extrusion: E reproduces sheet volume Δd·h·length, and the sheet fills the overhang area', () => {
    let wave = 0, e = 0;
    let prev: Vec2 | null = null;
    for (const m of pl.moves) {
      const q: Vec2 = [m.x, m.y];
      if (prev && (m.kind === 'wave' || m.kind === 'link')) {
        const len = dist(prev, q);
        wave += len; e += m.e;
        const expected = (step * p.sheetHeight * m.flow * len) / filamentArea(p);
        assert.ok(Math.abs(m.e - expected) < 1e-9);
        assert.ok(m.flow >= p.flowFloor * p.flowRatio - 1e-12 && m.flow <= p.flowRatio + 1e-12);
      }
      prev = q;
    }
    const sheetArea = wave * step; // area covered by beads at spacing Δd
    const overhangArea = pl.stats.overhangArea;
    // sheet also runs leadIn onto the anchor, and the outermost half bead belongs to the rim
    assert.ok(sheetArea > 0.92 * overhangArea && sheetArea < 1.35 * overhangArea, `sheet ${sheetArea} vs overhang ${overhangArea}`);
    assert.ok(e > 0);
  });

  test('few travels: continuous toolpath except where the front splits round the hole', () => {
    assert.ok(pl.stats.travels <= 20, `${pl.stats.travels} travels over ${pl.stats.levels} levels`);
    assert.ok(pl.stats.linkLength > 0);
  });

  test('G-code: fan on, relative E, feedrates in mm/min, travels retract and hop', () => {
    const g = emitMoves(pl.moves, p, { z: 10.2, restoreFan: 128 });
    assert.match(g[0], /^M106 P0 S255/);
    assert.equal(g[g.length - 1], 'M106 P0 S128');
    assert.ok(g.some((l) => l === `G1 Z${10.2 + p.zHop}`.replace(/(\.\d*?)0+$/, '$1') || l.startsWith('G1 Z10.6')));
    const f = g.find((l) => /^G1 X.* E.* F/.test(l))!;
    assert.match(f, new RegExp(`F${p.waveSpeed * 60}$`));
    for (const l of g) assert.match(l, /^(G[01] |M10[67]|;TYPE)/);
    for (const l of g.filter((l) => l.startsWith('G0'))) assert.ok(!/E/.test(l));
  });
});

test('point seeding gives curved (hoop) fronts, edge seeding gives near-straight ones', () => {
  // mean curvature = total turning angle / wave length
  const curv = (pl: RegionPlan) => {
    let turn = 0, len = 0;
    for (const a of pl.arcs) for (let i = 1; i < a.pts.length; i++) {
      len += dist(a.pts[i - 1], a.pts[i]);
      if (i + 1 < a.pts.length) {
        const u = [a.pts[i][0] - a.pts[i - 1][0], a.pts[i][1] - a.pts[i - 1][1]], v = [a.pts[i + 1][0] - a.pts[i][0], a.pts[i + 1][1] - a.pts[i][1]];
        turn += Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]));
      }
    }
    return turn / len;
  };
  const [pt, ed] = results.map((r) => r.layer.plans[0]);
  assert.ok(curv(pt) > 2 * curv(ed), `point ${curv(pt)} vs edge ${curv(ed)}`);
});
