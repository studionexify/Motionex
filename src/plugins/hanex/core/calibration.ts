// Hanex calibration prints: complete, self-contained G-code files for a real printer.
//
// Each print is a row of specimens (a solid pillar with an unsupported tab on top) that differ in
// one Hanex setting. The specimens are described as stacks of prisms and sliced here with a small
// built-in slicer (walls + rectilinear infill), so the Hanex layer goes through exactly the same
// detect → plan → emit path a real model's layers will.
import { clipLines, difference, intersection, offset, union } from '../../../engine/clipper';
import type { Paths } from '../../../engine/types';
import { bboxOf, toPath, toPaths, toRings, type Ring, type Vec2 } from './geom';
import { emitMoves } from './gcode';
import { planLayer } from './layer';
import { validateProfile, type HanexProfile, type SeedMode } from './profile';
import { circleRing, rectRing, reverse, translate } from './shapes';

export interface Prism { rings: Ring[]; z0: number; z1: number }

export interface Specimen { label: string; value: string | number; prisms: Prism[]; profile: HanexProfile }

export interface CalibPrinter {
  name: string;
  bedX: number;
  bedY: number;
  nozzleTemp: number;
  bedTemp: number;
  layerHeight: number;
  /** Part fan for normal printing (0–255); the Hanex profile's fan is used during waves. */
  partFan: number;
  firstLayerSpeed: number;
  wallSpeed: number;
  infillSpeed: number;
  travelSpeed: number;
  retractLength: number;
  retractSpeed: number;
  /** Replaces the generic start G-code when set ({bed}, {nozzle} are substituted). */
  startGcode?: string;
  endGcode?: string;
}

export const DEFAULT_PRINTER: CalibPrinter = {
  name: 'Generic 220 × 220 (Marlin/Klipper)',
  bedX: 220, bedY: 220, nozzleTemp: 215, bedTemp: 60, layerHeight: 0.2, partFan: 255,
  firstLayerSpeed: 20, wallSpeed: 35, infillSpeed: 60, travelSpeed: 150, retractLength: 0.8, retractSpeed: 35,
};

export interface TestPrint {
  id: string;
  title: string;
  /** What the print measures. */
  purpose: string;
  /** Profile field the winning specimen sets (null for pass/fail validation prints). */
  field: keyof HanexProfile | null;
  specimens: Specimen[];
  /** How to judge the specimens. */
  judge: string[];
}

// ---------------------------------------------------------------- specimen geometry

const PILLAR_H = 6, TAB_T = 1.2;

/** Pillar W × D × (H + tab) with a tab protruding in +Y from z = H, optionally with a round hole. */
export function tabSpecimen(o: { w?: number; d?: number; tabW?: number; tabD?: number; holeR?: number } = {}): Prism[] {
  const w = o.w ?? 20, d = o.d ?? 12, tabW = o.tabW ?? w - 4, tabD = o.tabD ?? 15;
  const x0 = (w - tabW) / 2;
  const tab: Ring[] = [rectRing(x0, d, x0 + tabW, d + tabD)];
  if (o.holeR) tab.push(reverse(circleRing([w / 2, d + tabD / 2], o.holeR)));
  return [
    { rings: [rectRing(0, 0, w, d)], z0: 0, z1: PILLAR_H + TAB_T },
    { rings: tab, z0: PILLAR_H, z1: PILLAR_H + TAB_T },
  ];
}

/**
 * Tab whose underside rises at (faceAngle − 90)° away from the wall (faceAngle = 90 is a flat ceiling).
 * One prism per layer: at height z above the wall top the tab reaches (z − H)/tan(rise).
 */
export function angleSpecimen(faceAngleDeg: number, layerH: number, o: { w?: number; d?: number; tabD?: number } = {}): Prism[] {
  const w = o.w ?? 20, d = o.d ?? 12, tabD = o.tabD ?? 15, tabW = w - 4, x0 = 2;
  const rise = ((faceAngleDeg - 90) * Math.PI) / 180;
  const height = rise > 0 ? tabD * Math.tan(rise) : 0;
  const prisms: Prism[] = [{ rings: [rectRing(0, 0, w, d)], z0: 0, z1: PILLAR_H + height + TAB_T }];
  const n = Math.max(1, Math.ceil(height / layerH));
  for (let j = 0; j < n; j++) {
    const zt = PILLAR_H + (j + 1) * layerH;
    const reach = rise > 0 ? Math.min(tabD, (zt - PILLAR_H) / Math.tan(rise)) : tabD;
    prisms.push({ rings: [rectRing(x0, d, x0 + tabW, d + reach)], z0: PILLAR_H + j * layerH, z1: PILLAR_H + height + TAB_T });
  }
  return prisms;
}

// ---------------------------------------------------------------- the suite

export function calibrationSuite(base: HanexProfile, printer: CalibPrinter = DEFAULT_PRINTER): TestPrint[] {
  const sp = (label: string, value: string | number, prisms: Prism[], patch: Partial<HanexProfile>): Specimen =>
    ({ label, value, prisms, profile: { ...structuredClone(base), sheetHeight: printer.layerHeight, ...patch } });
  const ladder = <K extends keyof HanexProfile>(field: K, values: HanexProfile[K][], fmt: (v: HanexProfile[K]) => string) =>
    values.map((v) => sp(fmt(v), v as string | number, tabSpecimen(), { [field]: v } as Partial<HanexProfile>));
  return [
    {
      id: 'HNX-01', title: 'Overlap ladder', field: 'overlap',
      purpose: 'How much each new arc must overlap the previous one to fuse sideways instead of curling down.',
      specimens: ladder('overlap', [0.4, 0.5, 0.6, 0.7], (v) => `${Math.round(v * 100)}%`),
      judge: [
        'Look at the underside of each tab.',
        'Too little overlap: visible gaps or separate strands between arcs, or arcs that drooped away from the previous one.',
        'Too much overlap: ridged, wavy underside with blobs (the bead has nowhere to go), and the top of the tab bulges.',
        'Pick the lowest overlap with a closed, flat underside.',
      ],
    },
    {
      id: 'HNX-02', title: 'Wave speed ladder', field: 'waveSpeed',
      purpose: 'Fastest arc speed at which the bead is still laid in place rather than dragged.',
      specimens: ladder('waveSpeed', [1.5, 3, 5, 8], (v) => `${v} mm/s`),
      judge: [
        'Too fast: arcs pulled into straight chords, stringy or detached bead, droop growing towards the tab tip.',
        'Pick the fastest specimen that looks like the slowest one.',
      ],
    },
    {
      id: 'HNX-03', title: 'Flow ladder', field: 'flowRatio',
      purpose: 'Extrusion multiplier for the wave sheet (volumetric model Δd·h per mm of arc).',
      specimens: ladder('flowRatio', [0.85, 1.0, 1.15, 1.3], (v) => `×${v}`),
      judge: [
        'Under-extruded: translucent / see-through sheet, arcs not touching.',
        'Over-extruded: ridges and blobs, the nozzle ploughs through earlier arcs, the sheet sags under its own weight.',
        'Pick the lowest flow giving an opaque sheet; measure tab thickness with calipers (should be the pillar-to-top height minus pillar height).',
      ],
    },
    {
      id: 'HNX-04', title: 'Cooling ladder', field: 'fan',
      purpose: 'Fan PWM that sets each arc fast enough to carry the next, without cracking layers apart (PETG, ABS, ASA).',
      specimens: ladder('fan', [100, 160, 210, 255], (v) => `fan ${v}`),
      judge: [
        'Too little fan: arcs sag and the sheet is wavy.',
        'Too much fan (ABS/ASA): the tab cracks off the pillar or curls up at the corners.',
        'Pick the lowest fan with a flat sheet.',
      ],
    },
    {
      id: 'HNX-05', title: 'Reference scenario (50 × 30 mm overhang, Ø10 hole)', field: null,
      purpose: 'Validates diffraction round a hole and the full-size spec case.',
      specimens: [sp('reference', 'ref', referencePrisms(), {})],
      judge: [
        'The hole must be round and open, with the arcs bending round it (no strands across it).',
        'Behind the hole the two fronts must meet without a gap.',
        'Underside flat to within 0.3 mm (straight edge / feeler gauge).',
      ],
    },
    {
      id: 'HNX-06', title: 'Seeding: point vs edge', field: 'seedMode',
      purpose: 'Curved fronts from a point source against straight fronts from the whole anchor edge.',
      specimens: (['point', 'edge'] as SeedMode[]).map((m) => sp(m, m, tabSpecimen({ tabD: 20 }), { seedMode: m })),
      judge: [
        'Compare droop at the tab tip and along the free sides.',
        'Pick the mode with less droop. "point" is expected to win on wide tabs.',
      ],
    },
    {
      id: 'HNX-07', title: 'Face-angle ladder (90°, 92.5°, 95°, 97.5°)', field: null,
      purpose: 'Rising undersides: each layer adds a free band b = h / tan(φ − 90°) that Hanex waves onto the previous layer\'s sheet.',
      specimens: [90, 92.5, 95, 97.5].map((a) => sp(`${a}°`, a, angleSpecimen(a, printer.layerHeight), {})),
      judge: [
        'All four should print with a smooth stepped underside.',
        'If the steeper (higher-angle) ones fail first, the print head is hitting the fresh band: note the first failing angle and report it — it bounds the face angle this toolhead can do.',
      ],
    },
    {
      id: 'HNX-08', title: 'Cantilever reach (12 × 40 mm tab)', field: null,
      purpose: 'How far a sheet can reach from its anchor before the accumulated droop shows.',
      specimens: [sp('reach 40 mm', 40, tabSpecimen({ w: 16, tabW: 12, tabD: 40 }), {})],
      judge: ['Measure droop at 10, 20, 30 and 40 mm from the pillar with a straight edge. Report the numbers.'],
    },
  ];
}

function referencePrisms(): Prism[] {
  return [
    { rings: [rectRing(0, 0, 60, 20)], z0: 0, z1: PILLAR_H + TAB_T },
    { rings: [rectRing(5, 20, 55, 50), reverse(circleRing([30, 35], 5))], z0: PILLAR_H, z1: PILLAR_H + TAB_T },
  ];
}

// ---------------------------------------------------------------- mini slicer + writer

const n = (x: number, d = 3) => { const s = x.toFixed(d); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s; };

function sliceAt(prisms: Prism[], z: number): Paths {
  const live = prisms.filter((p) => p.z0 < z && z < p.z1);
  return live.length ? union(live.flatMap((p) => toPaths(p.rings))) : [];
}

const beadArea = (w: number, h: number) => (w - h) * h + (Math.PI * h * h) / 4;

export interface BuiltPrint { gcode: string; report: { id: string; title: string; specimens: { label: string; value: string | number; layers: number; arcs: number; travels: number; volume: number; warnings: string[] }[]; problems: string[] } }

/** Lay the specimens out on the bed, slice, plan Hanex layers and write a complete G-code file. */
export function buildTestPrint(tp: TestPrint, printer: CalibPrinter = DEFAULT_PRINTER): BuiltPrint {
  const problems: string[] = [];
  const gap = 10;
  // place specimens left to right, centred on the bed
  const boxes = tp.specimens.map((s) => bboxOf(s.prisms.flatMap((p) => p.rings)));
  const totalW = boxes.reduce((a, b) => a + (b.x1 - b.x0), 0) + gap * (boxes.length - 1);
  const depth = Math.max(...boxes.map((b) => b.y1 - b.y0));
  let x = (printer.bedX - totalW) / 2;
  const y = (printer.bedY - depth) / 2;
  const placed = tp.specimens.map((s, i) => {
    const b = boxes[i], dx = x - b.x0, dy = y - b.y0;
    x += b.x1 - b.x0 + gap;
    return { ...s, prisms: s.prisms.map((p) => ({ ...p, rings: p.rings.map((r) => translate(r, dx, dy)) })) };
  });
  if (x - gap > printer.bedX - 5 || depth > printer.bedY - 10) problems.push(`does not fit on a ${printer.bedX} × ${printer.bedY} bed`);
  for (const s of placed) for (const e of validateProfile(s.profile)) problems.push(`${s.label}: ${e}`);

  const h = printer.layerHeight;
  const top = Math.max(...placed.flatMap((s) => s.prisms.map((p) => p.z1)));
  const layers = Math.round(top / h);
  const fd = placed[0].profile.filamentDiameter, Af = Math.PI * (fd / 2) ** 2;
  const out: string[] = [];
  const header = [
    `; ${tp.id} — ${tp.title}`, `; generated by Nexspiro Hanex`, `; printer: ${printer.name}`,
    `; purpose: ${tp.purpose}`, `; profile field: ${tp.field ?? '(validation print)'}`,
    `; specimens left → right (front view, tabs pointing to the back):`,
    ...placed.map((s, i) => `;   ${i + 1}. ${s.label}`),
    ...tp.judge.map((j) => `; judge: ${j}`),
  ];
  out.push(...header);
  const start = printer.startGcode ?? [
    'M140 S{bed}', 'M104 S{nozzle}', 'M190 S{bed}', 'M109 S{nozzle}', 'G28', 'G90', 'M83', 'G92 E0',
    'G1 Z2 F600', 'G1 X5 Y10 F6000', 'G1 Z0.3 F600', `G1 X5 Y${n(Math.min(printer.bedY - 10, 120))} E12 F1200`, 'G1 X5.5 F1200', 'G1 X5.5 Y10 E12 F1200', 'G1 Z1 F600',
  ].join('\n');
  out.push(start.replaceAll('{bed}', String(printer.bedTemp)).replaceAll('{nozzle}', String(printer.nozzleTemp)));
  out.push('M83 ; relative E', 'G90');

  let cx = 5.5, cy = 10, cz = 1;
  let lastF = -1;
  const F = (v: number) => { const s = v !== lastF ? ` F${n(v * 60, 0)}` : ''; lastF = v; return s; };
  const travel = (q: Vec2, z: number) => {
    const far = Math.hypot(q[0] - cx, q[1] - cy) > 3;
    if (far && printer.retractLength) out.push(`G1 E-${n(printer.retractLength, 4)} F${n(printer.retractSpeed * 60, 0)}`);
    out.push(`G0 X${n(q[0])} Y${n(q[1])}${z !== cz ? ` Z${n(z)}` : ''} F${n(printer.travelSpeed * 60, 0)}`);
    lastF = -1;
    if (far && printer.retractLength) out.push(`G1 E${n(printer.retractLength, 4)} F${n(printer.retractSpeed * 60, 0)}`);
    cx = q[0]; cy = q[1]; cz = z;
  };
  const line = (pts: Vec2[], w: number, speed: number, closed: boolean) => {
    if (pts.length < 2) return;
    const seq = closed ? [...pts, pts[0]] : pts;
    if (Math.hypot(seq[0][0] - cx, seq[0][1] - cy) > 1e-6) travel(seq[0], cz);
    for (let i = 1; i < seq.length; i++) {
      const len = Math.hypot(seq[i][0] - seq[i - 1][0], seq[i][1] - seq[i - 1][1]);
      if (len < 1e-6) continue;
      out.push(`G1 X${n(seq[i][0])} Y${n(seq[i][1])} E${n((beadArea(w, h) * len) / Af, 5)}${F(speed)}`);
      cx = seq[i][0]; cy = seq[i][1];
    }
  };
  const infill = (region: Paths, spacing: number, angle: number, w: number, speed: number) => {
    if (!region.length) return;
    const rings = toRings(region), b = bboxOf(rings);
    const c: Vec2 = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2], R = Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2 + 1;
    const d: Vec2 = [Math.cos(angle), Math.sin(angle)], nn: Vec2 = [-d[1], d[0]];
    const raw: Ring[] = [];
    for (let t = -R, i = 0; t <= R; t += spacing, i++) {
      const a: Vec2 = [c[0] + nn[0] * t - d[0] * R, c[1] + nn[1] * t - d[1] * R], e: Vec2 = [c[0] + nn[0] * t + d[0] * R, c[1] + nn[1] * t + d[1] * R];
      raw.push(i % 2 ? [e, a] : [a, e]);
    }
    const segs = toRings(clipLines(raw.map(toPath), region));
    // order: zig-zag by offset along the normal, nearest end first
    segs.sort((p, q) => (p[0][0] * nn[0] + p[0][1] * nn[1]) - (q[0][0] * nn[0] + q[0][1] * nn[1]));
    for (const s of segs) {
      const pts = Math.hypot(s[s.length - 1][0] - cx, s[s.length - 1][1] - cy) < Math.hypot(s[0][0] - cx, s[0][1] - cy) ? s.slice().reverse() : s;
      line(pts, w, speed, false);
    }
  };

  const stats = placed.map((s) => ({ label: s.label, value: s.value, layers: 0, arcs: 0, travels: 0, volume: 0, warnings: [] as string[] }));
  let sheetBelow = new Set<number>();
  for (let li = 0; li < layers; li++) {
    const z = (li + 1) * h, mid = z - h / 2;
    out.push(';LAYER_CHANGE', `;Z:${n(z)}`, `;HEIGHT:${n(h)}`);
    out.push(li === 0 ? 'M107' : `M106 P0 S${printer.partFan}`);
    travel([cx, cy], z);
    const sheetNow = new Set<number>();
    placed.forEach((s, si) => {
      const p = s.profile, w = p.lineWidth;
      const cur = sliceAt(s.prisms, mid);
      if (!cur.length) return;
      const below = li ? sliceAt(s.prisms, mid - h) : cur;
      const hx = li ? planLayer(cur, below, p, [cx, cy]) : { plans: [], floating: [], warnings: [] };
      const air = union(hx.plans.flatMap((pl) => toPaths(pl.overhangRings)));
      const solidPart = air.length ? difference(cur, air) : cur;
      const overSheet = sheetBelow.has(si);
      const slow = li === 0 ? printer.firstLayerSpeed : overSheet ? Math.min(printer.wallSpeed, 15) : printer.wallSpeed;
      // walls
      for (const k of [1, 0]) for (const r of toRings(offset(solidPart, -(w / 2 + k * w * 0.95)))) line(r, w, k === 0 ? slow * 0.8 : slow, true);
      // infill: solid within 3 layers of a bottom or top surface, else 25 %
      const near = [1, 2, 3].flatMap((i) => [difference(cur, sliceAt(s.prisms, mid + i * h)), li - i >= 0 ? difference(cur, sliceAt(s.prisms, mid - i * h)) : cur]);
      const solidZone = intersection(union(near.flat()), solidPart);
      const fillArea = offset(solidPart, -(w / 2 + w * 0.95 + w * 0.4));
      const solid = intersection(fillArea, offset(solidZone, w));
      const sparse = difference(fillArea, solid);
      const ang = ((li % 2 ? 45 : -45) * Math.PI) / 180;
      infill(solid, w * 0.95, ang, w, li === 0 ? printer.firstLayerSpeed : overSheet ? 15 : printer.infillSpeed);
      infill(sparse, w / 0.25, ang, w, printer.infillSpeed);
      // Hanex waves last, onto the walls just printed
      for (const pl of hx.plans) {
        if (!pl.moves.length) continue;
        out.push(`; Hanex region: ${pl.seedMode} seeding, ${pl.stats.arcs} arcs, Δd ${n(pl.step)} mm`);
        const lines = emitMoves(pl.moves, p, { z, restoreFan: printer.partFan });
        out.push(...lines);
        const last = pl.moves[pl.moves.length - 1];
        cx = last.x; cy = last.y; lastF = -1;
        stats[si].layers++; stats[si].arcs += pl.stats.arcs; stats[si].travels += pl.stats.travels; stats[si].volume += pl.stats.volume;
        sheetNow.add(si);
      }
      stats[si].warnings.push(...hx.warnings.map((m) => `z ${n(z)}: ${m}`));
    });
    sheetBelow = sheetNow;
  }
  const end = printer.endGcode ?? ['M107', 'M104 S0', 'M140 S0', 'G91', 'G1 E-2 F1800', 'G1 Z10 F600', 'G90', `G0 X5 Y${n(printer.bedY - 10)} F6000`, 'M84'].join('\n');
  out.push(end);
  for (const s of stats) if (!s.layers) problems.push(`${s.label}: no Hanex layer was generated`);
  return { gcode: out.join('\n') + '\n', report: { id: tp.id, title: tp.title, specimens: stats, problems } };
}

// ---------------------------------------------------------------- results → profile

export interface CalibrationResults {
  overlap?: number;
  waveSpeed?: number;
  flowRatio?: number;
  fan?: number;
  seedMode?: SeedMode;
}

/** New profile with the winning specimen values from the ladders. Throws on a physically invalid result. */
export function applyCalibration(p: HanexProfile, r: CalibrationResults): HanexProfile {
  const next: HanexProfile = { ...structuredClone(p), ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) };
  // rim follows the arcs: keep it no faster than 1.3× the calibrated wave speed
  if (r.waveSpeed !== undefined) next.rimSpeed = Math.min(next.rimSpeed, r.waveSpeed * 1.3);
  const errs = validateProfile(next);
  if (errs.length) throw new Error(`calibrated profile is invalid: ${errs.join('; ')}`);
  return next;
}

// ---------------------------------------------------------------- specimens as meshes (for the plate)

/** Triangle soup of rectangular prisms (axis-aligned 4-vertex outer rings; other rings are skipped). */
export function prismsToSoup(prisms: Prism[]): Float32Array {
  const out: number[] = [];
  for (const p of prisms) {
    const r = p.rings[0];
    if (p.rings.length !== 1 || r.length !== 4) continue;
    const xs = r.map((q) => q[0]), ys = r.map((q) => q[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), z0 = p.z0, z1 = p.z1;
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    for (const t of f) for (const i of t) out.push(...v[i]);
  }
  return new Float32Array(out);
}
