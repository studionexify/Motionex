/**
 * Reverse-calculation math assertions for NexSpiro G-code.
 *
 * LOCKED SPEC. Tolerances below are part of the specification: do not widen, delete or skip an assertion to
 * force a pass. A failure means the slicing kernel (or its declared inputs) is wrong.
 *
 * Pure functions only (no I/O). Input is the stream of `GMove`s produced by gcodeParser.ts.
 */

// ---------------------------------------------------------------------------------------------------------
// Locked tolerances
// ---------------------------------------------------------------------------------------------------------
export const TOL = Object.freeze({
  /** Max relative |dE_actual - dE_expected| / dE_expected (2 %). */
  volumetric: 0.02,
  /** Per-segment checks need a segment long enough that 3-decimal coordinate rounding stays << 2 %. Shorter
   * segments are not skipped: they are summed with their neighbours (same feature, same layer) and checked
   * against the same 2 % bound. */
  minSegmentLen: 0.2,
  /** Retraction debt allowed at the start of an extruding segment (mm of filament). */
  retractDebt: 0.05,
  /** Radial amplitude tolerance for harmonic signature (fraction of expected amplitude), plus 0.01 mm. */
  amplitude: 0.05,
  /** Fraction of expected zero-crossings that must be present for a true criss-cross weave. */
  crossingFraction: 0.9,
  /** Minimum RMS difference between adjacent weave layers, as a fraction of the wave amplitude. */
  weaveRmsFraction: 0.5,
  /** Absolute slack on envelope dimensions beyond half a line width (mm). */
  envelope: 0.05,
  /** Numerical slack on angle comparisons (rad). */
  angle: 1e-9,
  /**
   * Measurement floor, not a tolerance: G-code prints E with 5 decimals, so every printed move carries up to
   * +/-5e-6 mm of rounding. A segment (or a run of k short segments summed) whose worst-case rounding k*5e-6
   * exceeds 0.5 % of its expected E cannot be judged at 2 % from the file alone; it is counted in
   * metrics.belowResolution, never silently dropped.
   */
  eQuantum: 5e-6,
  eQuantumShare: 0.005,
  /** Coordinates print with 3 decimals: worst-case length error of one segment is 1e-3 mm (same 0.5 % share; this is where minSegmentLen = 0.2 comes from). */
  coordQuantum: 1e-3,
  /** Z-weave: Pearson correlation of adjacent-layer Z offsets must be at most this (anti-phase). */
  zWeaveCorrelation: -0.8,
});

// ---------------------------------------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------------------------------------
export interface GMove {
  type: 'G0' | 'G1' | 'G2' | 'G3';
  /** Absolute position AFTER the move (mm). */
  x: number; y: number; z: number;
  /** Filament delta for this move (mm), regardless of M82/M83/G92 (parser normalises to relative). */
  e: number;
  f: number;
  /** e > 0 and the move changes XYZ (a pure-E move is a (de)retraction, not an extrusion). */
  isExtruding: boolean;
  layerIndex: number;
  /** Arc centre offsets from the start point (G2/G3). */
  i?: number; j?: number;
  /** `;TYPE:` comment in force. */
  feature?: string;
  /** `;HEIGHT:` comment in force (mm). */
  layerHeight?: number;
  /** First move after a filament swap (T<n>): freshly loaded filament, so retraction debt starts again at zero. */
  toolReset?: boolean;
  /** 1-based source line, for diagnostics. */
  line: number;
}

export interface Failure { assertion: string; line?: number; layer?: number; message: string; actual?: number; expected?: number }
export interface AssertionResult {
  name: string;
  pass: boolean;
  failures: Failure[];
  /** Headline metrics for the report (maxRelErr, residual, thetaMaxDeg, ...). */
  metrics: Record<string, number>;
}

const MAX_FAILURES = 25;
const result = (name: string, failures: Failure[], metrics: Record<string, number>): AssertionResult =>
  ({ name, pass: failures.length === 0, failures: failures.slice(0, MAX_FAILURES), metrics: { ...metrics, failureCount: failures.length } });

// ---------------------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------------------
export interface Pos { x: number; y: number; z: number }

/** Planar sweep of an arc move (signed, rad; negative = clockwise). Start == end means a full circle. */
export function arcSweep(start: Pos, m: GMove): { sweep: number; radius: number } {
  const i = m.i ?? 0, j = m.j ?? 0;
  const radius = Math.hypot(i, j);
  const cx = start.x + i, cy = start.y + j;
  const a0 = Math.atan2(start.y - cy, start.x - cx);
  const a1 = Math.atan2(m.y - cy, m.x - cx);
  let d = a1 - a0;
  const cw = m.type === 'G2';
  if (cw) { while (d >= 0) d -= 2 * Math.PI; } else { while (d <= 0) d += 2 * Math.PI; }
  if (Math.hypot(m.x - start.x, m.y - start.y) < 1e-6) d = cw ? -2 * Math.PI : 2 * Math.PI;
  return { sweep: d, radius };
}

/** True 3-D length of a move: sqrt(dX^2 + dY^2 + dZ^2) for lines, sqrt(arc^2 + dZ^2) for helical arcs. */
export function length3D(start: Pos, m: GMove): number {
  const dz = m.z - start.z;
  if (m.type === 'G2' || m.type === 'G3') {
    const { sweep, radius } = arcSweep(start, m);
    return Math.hypot(Math.abs(sweep) * radius, dz);
  }
  return Math.sqrt((m.x - start.x) ** 2 + (m.y - start.y) ** 2 + dz ** 2);
}

/** Visit moves with the position preceding each one. Position starts at the first fully-specified state. */
export function* withStart(moves: GMove[]): Generator<{ m: GMove; start: Pos; k: number }> {
  let p: Pos = { x: NaN, y: NaN, z: NaN };
  for (let k = 0; k < moves.length; k++) {
    const m = moves[k];
    yield { m, start: p, k };
    p = { x: m.x, y: m.y, z: m.z };
  }
}

// ---------------------------------------------------------------------------------------------------------
// 1. 3-D volumetric extrusion conservation (E-axis reverse check)
// ---------------------------------------------------------------------------------------------------------
export interface VolumetricOptions {
  filamentDiameter: number;
  /** Extrusion width W for a move (mm). Required: width cannot be recovered from G-code alone. */
  width: (m: GMove) => number;
  /** Local layer height h_local at the move (mm). Default: the `;HEIGHT:` in force. */
  hLocal?: (m: GMove, start: Pos) => number;
  /** flowMultiplier for the move. Default 1. */
  flow?: (m: GMove) => number;
  /**
   * Cross-section model for the extruded bead.
   *  'rect'    : A = W * h                           (spec formula)
   *  'stadium' : A = (W - h) * h + pi * (h/2)^2      (rounded-edge bead used by Orca/Prusa-style slicers, W > h)
   *  'circle'  : A = pi * (W/2)^2                    (thick bridge: round bead of diameter W)
   * The model is a property of the module under test and is declared by the runner, never tuned to a result.
   */
  crossSection: 'rect' | 'stadium' | 'circle';
}

export function beadArea(model: 'rect' | 'stadium' | 'circle', W: number, h: number): number {
  if (model === 'circle') return Math.PI * (W / 2) ** 2;
  if (model === 'rect' || W <= h) return W * h;
  return (W - h) * h + Math.PI * (h / 2) ** 2;
}

/** dE_expected = dL * A(W, h_local) * flow / (pi (d/2)^2), dL being the true 3-D length. */
export function expectedE(dL: number, W: number, h: number, flow: number, model: 'rect' | 'stadium' | 'circle', d: number): number {
  return (dL * beadArea(model, W, h) * flow) / (Math.PI * (d / 2) ** 2);
}

export function checkVolumetricConservation(moves: GMove[], o: VolumetricOptions): AssertionResult {
  const name = 'volumetric-extrusion-conservation';
  const failures: Failure[] = [];
  let maxRel = 0, checkedMm = 0, checkedSeg = 0, belowRes = 0;
  let debt = 0; // filament currently retracted (mm)
  let accA = 0, accE = 0, accKey = '', accLine = 0, accLen = 0, accN = 0; // run accumulator for sub-minSegmentLen segments
  const flush = () => {
    if (accLen > 0 && accE > 0 && (accN * TOL.eQuantum > TOL.eQuantumShare * accE || accN * TOL.coordQuantum > TOL.eQuantumShare * accLen)) belowRes++;
    else if (accLen > 0 && accE > 0) {
      const rel = Math.abs(accA - accE) / accE;
      maxRel = Math.max(maxRel, rel);
      checkedMm += accLen; checkedSeg++;
      if (rel > TOL.volumetric) failures.push({ assertion: name, line: accLine, message: `run dE ${accA.toFixed(5)} vs expected ${accE.toFixed(5)} (${(rel * 100).toFixed(2)} %) [${accKey}]`, actual: accA, expected: accE });
    }
    accA = accE = accLen = accN = 0;
  };

  for (const { m, start, k } of withStart(moves)) {
    for (const [key, v] of [['x', m.x], ['y', m.y], ['z', m.z], ['e', m.e], ['f', m.f]] as const) {
      if (!Number.isFinite(v)) failures.push({ assertion: name, line: m.line, message: `non-finite ${key}=${v}` });
    }
    if (m.toolReset) debt = 0;
    const hasXYZ = Number.isFinite(start.x) && (m.x !== start.x || m.y !== start.y || m.z !== start.z);
    if (m.e < 0) {
      debt -= m.e;
      if (hasXYZ && m.isExtruding) failures.push({ assertion: name, line: m.line, message: 'negative E flagged as extruding' });
      continue;
    }
    if (m.e > 0 && !hasXYZ) { debt -= m.e; continue; } // de-retract / prime
    if (!m.isExtruding || m.e <= 0) { flush(); continue; }
    if (!Number.isFinite(start.x)) continue; // first positioned move: no start point to measure from

    if (debt > TOL.retractDebt) failures.push({ assertion: name, line: m.line, layer: m.layerIndex, message: `extrusion with ${debt.toFixed(3)} mm of filament still retracted` });
    debt = Math.min(debt, 0) < 0 ? 0 : debt; // restart-extra over-prime is absorbed, not carried

    const dL = length3D(start, m);
    const h = o.hLocal ? o.hLocal(m, start) : (m.layerHeight ?? NaN);
    const W = o.width(m);
    const flow = o.flow ? o.flow(m) : 1;
    if (!(h > 0) || !(W > 0)) { failures.push({ assertion: name, line: m.line, message: `unknown geometry W=${W} h=${h}` }); continue; }
    const eExp = expectedE(dL, W, h, flow, o.crossSection, o.filamentDiameter);

    if (dL >= TOL.minSegmentLen && TOL.eQuantum > TOL.eQuantumShare * eExp) { flush(); belowRes++; }
    else if (dL >= TOL.minSegmentLen) {
      flush();
      const rel = Math.abs(m.e - eExp) / eExp;
      maxRel = Math.max(maxRel, rel); checkedMm += dL; checkedSeg++;
      if (rel > TOL.volumetric) failures.push({ assertion: name, line: m.line, layer: m.layerIndex, message: `dE ${m.e.toFixed(5)} vs expected ${eExp.toFixed(5)} (${(rel * 100).toFixed(2)} %), dL3D=${dL.toFixed(4)} [${m.feature ?? '?'}]`, actual: m.e, expected: eExp });
    } else {
      const key = `${m.feature}|${m.layerIndex}|${W}|${h}`;
      if (key !== accKey) { flush(); accKey = key; accLine = m.line; }
      accA += m.e; accE += eExp; accLen += dL; accN++;
    }
    void k;
  }
  flush();
  return result(name, failures, { maxRelErrPct: maxRel * 100, checkedMm, checkedSegments: checkedSeg, belowResolution: belowRes });
}

/** Any NaN / Infinity / negative-Z token or un-retracted negative extrusion state over the whole program. */
export function checkFiniteAndSafe(moves: GMove[], rawText?: string): AssertionResult {
  const name = 'finite-and-bed-safe';
  const failures: Failure[] = [];
  let minZ = Infinity;
  if (rawText && /NaN|Infinity|undefined/.test(rawText.split('\n').filter((l) => !l.startsWith(';')).join('\n'))) {
    failures.push({ assertion: name, message: 'NaN/Infinity/undefined token in program text' });
  }
  for (const m of moves) {
    for (const v of [m.x, m.y, m.z, m.e]) if (!Number.isFinite(v)) { failures.push({ assertion: name, line: m.line, message: 'non-finite coordinate or E' }); break; }
    if (m.isExtruding) {
      minZ = Math.min(minZ, m.z);
      if (m.z < 0) failures.push({ assertion: name, line: m.line, layer: m.layerIndex, message: `extrusion below bed: Z=${m.z}`, actual: m.z, expected: 0 });
    }
  }
  return result(name, failures, { minExtrusionZ: Number.isFinite(minZ) ? minZ : 0 });
}

// ---------------------------------------------------------------------------------------------------------
// 2. Inverse geometric & parametric signatures
// ---------------------------------------------------------------------------------------------------------
export interface Pt3 { x: number; y: number; z: number; layer: number }

/** Reconstruct the 3-D point cloud of every extrusion end point. */
export function reconstructPointCloud(moves: GMove[]): Pt3[] {
  const out: Pt3[] = [];
  for (const { m } of withStart(moves)) if (m.isExtruding) out.push({ x: m.x, y: m.y, z: m.z, layer: m.layerIndex });
  return out;
}

export interface EnvelopeExpect {
  /** Expected footprint radius of the outermost toolpath centreline surface (mm). Omit to skip. */
  radius?: number;
  center?: { x: number; y: number };
  /** Expected total height of the extruded geometry (top of last bead, mm). */
  height?: number;
  layerHeight?: number;
  /** Expected number of layers (exact). */
  layers?: number;
  /** Extrusion width of the outer wall (mm), used for the half-width envelope allowance. */
  lineWidth: number;
}

export function checkEnvelope(pts: Pt3[], e: EnvelopeExpect): AssertionResult {
  const name = 'bounding-envelope';
  const failures: Failure[] = [];
  const m: Record<string, number> = {};
  if (!pts.length) return result(name, [{ assertion: name, message: 'no extrusion points' }], m);
  const slack = e.lineWidth / 2 + TOL.envelope;
  if (e.radius !== undefined && e.center) {
    let rMax = 0;
    for (const p of pts) rMax = Math.max(rMax, Math.hypot(p.x - e.center.x, p.y - e.center.y));
    m.rMax = rMax;
    // the outer wall centreline sits half a bead inside the surface: R - W/2 - tol <= rMax <= R + tol
    if (rMax > e.radius + TOL.envelope || rMax < e.radius - slack - TOL.envelope) failures.push({ assertion: name, message: `max radius ${rMax.toFixed(3)} outside [${(e.radius - slack - TOL.envelope).toFixed(3)}, ${(e.radius + TOL.envelope).toFixed(3)}]`, actual: rMax, expected: e.radius });
  }
  if (e.height !== undefined) {
    let zMax = -Infinity;
    for (const p of pts) zMax = Math.max(zMax, p.z);
    m.zMax = zMax;
    const lh = e.layerHeight ?? 0;
    if (Math.abs(zMax - e.height) > lh / 2 + TOL.envelope) failures.push({ assertion: name, message: `top Z ${zMax.toFixed(3)} vs expected height ${e.height} (+/- ${(lh / 2 + TOL.envelope).toFixed(3)})`, actual: zMax, expected: e.height });
  }
  if (e.layers !== undefined) {
    const n = new Set(pts.map((p) => p.layer)).size;
    m.layers = n;
    if (n !== e.layers) failures.push({ assertion: name, message: `layer count ${n} vs expected ${e.layers}`, actual: n, expected: e.layers });
  }
  return result(name, failures, m);
}

/** Polar radius r(theta) of one layer about `center`, resampled on a uniform grid of N angles. */
export function radialProfile(pts: Pt3[], center: { x: number; y: number }, N = 720): Float64Array | null {
  if (pts.length < 8) return null;
  const pol = pts.map((p) => ({ a: Math.atan2(p.y - center.y, p.x - center.x), r: Math.hypot(p.x - center.x, p.y - center.y) }));
  pol.sort((a, b) => a.a - b.a);
  const out = new Float64Array(N);
  let k = 0;
  for (let n = 0; n < N; n++) {
    const a = -Math.PI + ((n + 0.5) / N) * 2 * Math.PI;
    while (k < pol.length - 1 && pol[k + 1].a < a) k++;
    const p0 = k < pol.length ? pol[k] : pol[pol.length - 1];
    const p1 = k + 1 < pol.length ? pol[k + 1] : { a: pol[0].a + 2 * Math.PI, r: pol[0].r };
    const q0 = p0.a <= a ? p0 : { a: pol[pol.length - 1].a - 2 * Math.PI, r: pol[pol.length - 1].r };
    const q1 = p0.a <= a ? p1 : p0;
    const t = q1.a === q0.a ? 0 : (a - q0.a) / (q1.a - q0.a);
    out[n] = q0.r + (q1.r - q0.r) * Math.min(1, Math.max(0, t));
  }
  return out;
}

/** Discrete Fourier coefficient magnitude of harmonic k of r(theta): returns {amp, phase} for r ~ mean + amp cos(k th - phase). */
export function harmonic(r: Float64Array, k: number): { amp: number; phase: number } {
  const N = r.length;
  let re = 0, im = 0;
  for (let n = 0; n < N; n++) { const th = ((n + 0.5) / N) * 2 * Math.PI; re += r[n] * Math.cos(k * th); im += r[n] * Math.sin(k * th); }
  return { amp: (2 / N) * Math.hypot(re, im), phase: Math.atan2(im, re) };
}

export interface SpiroExpect {
  center: { x: number; y: number };
  lobes: number;
  /** Peak radial amplitude of the lobed modulation (mm). */
  amplitude: number;
  meanRadius?: number;
  /** Layers to analyse (default: all with enough points). */
  layers?: number[];
}

/** Spirographic / oscillating signature: dominant harmonic = lobes, amplitude within TOL.amplitude. */
export function checkSpiroSignature(pts: Pt3[], e: SpiroExpect): AssertionResult {
  const name = 'spirographic-signature';
  const failures: Failure[] = [];
  const byLayer = new Map<number, Pt3[]>();
  for (const p of pts) (byLayer.get(p.layer) ?? byLayer.set(p.layer, []).get(p.layer)!).push(p);
  let worstAmpErr = 0, analysed = 0;
  for (const [layer, lp] of byLayer) {
    if (e.layers && !e.layers.includes(layer)) continue;
    const r = radialProfile(lp, e.center);
    if (!r) continue;
    analysed++;
    let best = 0, bestK = 0;
    for (let k = 1; k <= Math.max(24, e.lobes * 3); k++) { const a = harmonic(r, k).amp; if (a > best) { best = a; bestK = k; } }
    if (bestK !== e.lobes) failures.push({ assertion: name, layer, message: `dominant harmonic ${bestK} != lobe count ${e.lobes}`, actual: bestK, expected: e.lobes });
    const amp = harmonic(r, e.lobes).amp;
    const err = Math.abs(amp - e.amplitude);
    worstAmpErr = Math.max(worstAmpErr, err);
    if (err > TOL.amplitude * e.amplitude + 0.01) failures.push({ assertion: name, layer, message: `amplitude ${amp.toFixed(4)} vs expected ${e.amplitude} (tol ${(TOL.amplitude * e.amplitude + 0.01).toFixed(4)})`, actual: amp, expected: e.amplitude });
    if (e.meanRadius !== undefined) {
      let mean = 0; for (const v of r) mean += v; mean /= r.length;
      if (Math.abs(mean - e.meanRadius) > TOL.amplitude * e.amplitude + 0.05) failures.push({ assertion: name, layer, message: `mean radius ${mean.toFixed(3)} vs ${e.meanRadius}`, actual: mean, expected: e.meanRadius });
    }
  }
  if (!analysed) failures.push({ assertion: name, message: 'no analysable layers' });
  return result(name, failures, { layersAnalysed: analysed, worstAmplitudeErrMm: worstAmpErr });
}

export interface WeaveExpect {
  center: { x: number; y: number };
  /** Wave periods per revolution of the weave modulation. */
  lobes: number;
  amplitude: number;
}

/**
 * True interlocking weave: adjacent layers' radial waves must CROSS each other (>= 2*lobes sign changes of
 * r_k - r_{k+1}, within TOL.crossingFraction) and differ materially (RMS >= TOL.weaveRmsFraction * amplitude);
 * layers k and k+2 must coincide (alternating phase, period 2). Identical stacked waves give 0 crossings.
 */
export function checkWeaveAlternation(pts: Pt3[], e: WeaveExpect): AssertionResult {
  const name = 'weave-phase-alternation';
  const failures: Failure[] = [];
  const byLayer = new Map<number, Pt3[]>();
  for (const p of pts) (byLayer.get(p.layer) ?? byLayer.set(p.layer, []).get(p.layer)!).push(p);
  const idx = [...byLayer.keys()].sort((a, b) => a - b);
  const prof = idx.map((l) => ({ l, r: radialProfile(byLayer.get(l)!, e.center) })).filter((p): p is { l: number; r: Float64Array } => p.r !== null);
  let minCross = Infinity, minRms = Infinity, maxPeriod2 = 0, pairs = 0;
  const detrend = (r: Float64Array) => { let m = 0; for (const v of r) m += v; m /= r.length; return r.map((v) => v - m); };
  for (let a = 0; a + 1 < prof.length; a++) {
    const A = detrend(prof[a].r), B = detrend(prof[a + 1].r);
    let cross = 0, ss = 0, prev = 0;
    for (let n = 0; n < A.length; n++) {
      const d = A[n] - B[n];
      ss += d * d;
      const s = Math.abs(d) < 1e-9 ? 0 : Math.sign(d);
      if (s !== 0 && prev !== 0 && s !== prev) cross++;
      if (s !== 0) prev = s;
    }
    pairs++;
    const rms = Math.sqrt(ss / A.length);
    minCross = Math.min(minCross, cross); minRms = Math.min(minRms, rms);
    const need = Math.floor(2 * e.lobes * TOL.crossingFraction);
    if (cross < need) failures.push({ assertion: name, layer: prof[a].l, message: `layers ${prof[a].l}/${prof[a + 1].l} cross ${cross}x, need >= ${need}: stacked identical/parallel waves, not a weave`, actual: cross, expected: 2 * e.lobes });
    if (rms < TOL.weaveRmsFraction * e.amplitude) failures.push({ assertion: name, layer: prof[a].l, message: `layers ${prof[a].l}/${prof[a + 1].l} RMS difference ${rms.toFixed(4)} < ${(TOL.weaveRmsFraction * e.amplitude).toFixed(4)}`, actual: rms, expected: TOL.weaveRmsFraction * e.amplitude });
    if (a + 2 < prof.length) {
      const C = detrend(prof[a + 2].r);
      let s2 = 0; for (let n = 0; n < A.length; n++) s2 += (A[n] - C[n]) ** 2;
      const rms2 = Math.sqrt(s2 / A.length);
      maxPeriod2 = Math.max(maxPeriod2, rms2);
      if (rms2 > (1 - TOL.weaveRmsFraction) * e.amplitude) failures.push({ assertion: name, layer: prof[a].l, message: `layers ${prof[a].l}/${prof[a + 2].l} should repeat (period-2 alternation) but RMS=${rms2.toFixed(4)}`, actual: rms2, expected: 0 });
    }
  }
  if (pairs === 0) failures.push({ assertion: name, message: 'fewer than two analysable layers' });
  return result(name, failures, { minCrossings: Number.isFinite(minCross) ? minCross : 0, minAdjacentRms: Number.isFinite(minRms) ? minRms : 0, maxPeriod2Rms: maxPeriod2 });
}

export interface ContinuityExpect {
  /** Largest allowed gap (mm) between the end of one extrusion and the start of the next within the span. */
  maxJump: number;
  /** 'monotonic': dZ >= 0 on every extrusion; 'periodic': |dZ| <= maxZStepPerMm * dXY. */
  zMode: 'monotonic' | 'periodic';
  maxZStepPerMm?: number;
  /** Restrict to this layer index range (inclusive) - e.g. skip the solid base layers of a vase. */
  fromLayer?: number; toLayer?: number;
}

/** C0 continuity: no travel jumps inside the span, positions chain, Z progression as declared. */
export function checkContinuity(moves: GMove[], c: ContinuityExpect): AssertionResult {
  const name = 'c0-continuity';
  const failures: Failure[] = [];
  let maxGap = 0, started = false, last: Pos | null = null, count = 0;
  for (const { m, start } of withStart(moves)) {
    if (m.layerIndex < (c.fromLayer ?? -Infinity) || m.layerIndex > (c.toLayer ?? Infinity)) { started = false; last = null; continue; }
    if (!m.isExtruding) {
      if (started && Number.isFinite(start.x)) {
        const jump = Math.hypot(m.x - start.x, m.y - start.y, m.z - start.z);
        if (jump > c.maxJump) { failures.push({ assertion: name, line: m.line, layer: m.layerIndex, message: `travel jump ${jump.toFixed(3)} mm inside continuous span`, actual: jump, expected: c.maxJump }); }
        maxGap = Math.max(maxGap, jump);
      }
      continue;
    }
    count++;
    if (started && last) {
      const gap = Math.hypot(start.x - last.x, start.y - last.y, start.z - last.z);
      maxGap = Math.max(maxGap, gap);
      if (gap > c.maxJump) failures.push({ assertion: name, line: m.line, layer: m.layerIndex, message: `discontinuity ${gap.toFixed(3)} mm between extrusions`, actual: gap, expected: c.maxJump });
    }
    if (Number.isFinite(start.x)) {
      const dz = m.z - start.z, dxy = Math.hypot(m.x - start.x, m.y - start.y);
      if (c.zMode === 'monotonic' && dz < -1e-6) failures.push({ assertion: name, line: m.line, layer: m.layerIndex, message: `Z decreased by ${(-dz).toFixed(4)} in monotonic span`, actual: dz, expected: 0 });
      if (c.zMode === 'periodic' && c.maxZStepPerMm !== undefined && Math.abs(dz) > c.maxZStepPerMm * Math.max(dxy, 1e-9) + 1e-6) failures.push({ assertion: name, line: m.line, layer: m.layerIndex, message: `Z step ${dz.toFixed(4)} over ${dxy.toFixed(4)} mm exceeds ${c.maxZStepPerMm}/mm`, actual: dz / Math.max(dxy, 1e-9), expected: c.maxZStepPerMm });
    }
    started = true; last = { x: m.x, y: m.y, z: m.z };
  }
  return result(name, failures, { maxGapMm: maxGap, extrusionsChecked: count });
}

// ---------------------------------------------------------------------------------------------------------
// 3. Non-planar nozzle clearance & bed safety
// ---------------------------------------------------------------------------------------------------------
/**
 * A pure-vertical extrusion (XY fixed, Z changes) is a plunge, not a ramp: theta = 90 deg by construction. It is
 * exempt from the slope limit ONLY if the void it enters is clear: no previously printed plastic lies inside the
 * nozzle cone over the plunge height (radius at height d above the tip = tipRadius + d * tan(coneAngle) + margin
 * + half a bead), and the dive is no deeper than the tip length less the margin.
 */
export interface PlungeOptions {
  tipRadius: number;
  /** Cone angle from vertical (deg), as in ToolheadProfile.nozzle.cone_angle_deg. */
  coneAngleDeg: number;
  tipLen: number;
  margin: number;
  /** Half the bead width of the plastic around the void (mm). */
  beadHalfWidth: number;
}

const SAMPLE = 0.3, CELL = 1;
const cellKey = (ix: number, iy: number) => ix * 100003 + iy;

/** theta = atan2(|dZ|, hypot(dX, dY)) <= thetaMax on every extrusion; Z >= 0 on every extrusion; clear-void plunges exempt. */
export function checkRampAngle(moves: GMove[], thetaMaxDeg: number, plunge?: PlungeOptions): AssertionResult {
  const name = 'nonplanar-ramp-angle';
  const failures: Failure[] = [];
  const thetaMax = (thetaMaxDeg * Math.PI) / 180;
  let worst = 0, minZ = Infinity, plunges = 0, plungeMinClear = Infinity;
  const hash = new Map<number, number[]>();
  const tanA = plunge ? Math.tan((plunge.coneAngleDeg * Math.PI) / 180) : 0;
  let moveId = 0;
  const insert = (x: number, y: number, z: number) => {
    const k = cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
    const a = hash.get(k);
    if (a) a.push(x, y, z, moveId); else hash.set(k, [x, y, z, moveId]);
  };
  // strands that start or end exactly where a draw begins are the ones the head is joined to: they are not obstacles to it
  const pk = (x: number, y: number, z: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
  const touching = new Map<string, Set<number>>();
  const touch = (x: number, y: number, z: number) => { const k = pk(x, y, z); (touching.get(k) ?? touching.set(k, new Set()).get(k)!).add(moveId); };
  const deposit = (m: GMove, st: Pos) => {
    if (!plunge || !m.isExtruding || !Number.isFinite(st.x)) return;
    const L = Math.hypot(m.x - st.x, m.y - st.y, m.z - st.z), n = Math.max(1, Math.ceil(L / SAMPLE));
    moveId++; touch(st.x, st.y, st.z); touch(m.x, m.y, m.z);
    for (let i = 1; i <= n; i++) { const t = i / n; insert(st.x + (m.x - st.x) * t, st.y + (m.y - st.y) * t, st.z + (m.z - st.z) * t); }
  };
  // The strand the nozzle is continuing (the previous move) joins the hash one move late: the head came from it.
  let pending: { m: GMove; st: Pos } | null = null;
  let worstAt = '';
  /** Smallest margin (mm, negative = plastic inside the cone) of the nozzle cone along a steep move; Infinity if clear of everything. */
  const coneClear = (m: GMove, st: Pos, o: PlungeOptions): number => {
    const L = Math.hypot(m.x - st.x, m.y - st.y, m.z - st.z), n = Math.max(1, Math.ceil(L / SAMPLE));
    const reach = o.tipRadius + o.tipLen * tanA + o.margin + o.beadHalfWidth + CELL;
    let clear = Infinity;
    const j0 = touching.get(pk(st.x, st.y, st.z)), j1 = touching.get(pk(m.x, m.y, m.z));
    const joined = { has: (id: number) => !!(j0?.has(id) || j1?.has(id)) };
    for (let i = 0; i <= n; i++) {
      const t = i / n, nx = st.x + (m.x - st.x) * t, ny = st.y + (m.y - st.y) * t, nz = st.z + (m.z - st.z) * t;
      const c0x = Math.floor((nx - reach) / CELL), c1x = Math.floor((nx + reach) / CELL), c0y = Math.floor((ny - reach) / CELL), c1y = Math.floor((ny + reach) / CELL);
      for (let ix = c0x; ix <= c1x; ix++) for (let iy = c0y; iy <= c1y; iy++) {
        const a = hash.get(cellKey(ix, iy));
        if (!a) continue;
        for (let q = 0; q < a.length; q += 4) {
          const dz = a[q + 2] - nz;
          // plastic at the tip's own level is the surface the head rests on (a base layer, a node), not a cone obstacle
          if (dz < 0.05 || dz > o.tipLen || joined.has(a[q + 3])) continue;
          const c = Math.hypot(a[q] - nx, a[q + 1] - ny) - (o.tipRadius + dz * tanA + o.margin + o.beadHalfWidth);
          if (c < clear) { clear = c; worstAt = `nozzle (${nx.toFixed(2)}, ${ny.toFixed(2)}, ${nz.toFixed(2)}) vs plastic (${a[q].toFixed(2)}, ${a[q + 1].toFixed(2)}, ${a[q + 2].toFixed(2)})`; }
        }
      }
    }
    return clear;
  };
  for (const { m, start } of withStart(moves)) {
    try {
    if (!m.isExtruding || !Number.isFinite(start.x)) continue;
    if (pending) { deposit(pending.m, pending.st); pending = null; }
    minZ = Math.min(minZ, m.z);
    if (m.z < 0) failures.push({ assertion: name, line: m.line, layer: m.layerIndex, message: `Z=${m.z} below bed`, actual: m.z, expected: 0 });
    const theta = Math.atan2(Math.abs(m.z - start.z), Math.hypot(m.x - start.x, m.y - start.y));
    if (plunge && theta > thetaMax + TOL.angle) {
      // a draw steeper than the slope limit (a plunge is the vertical case) is allowed only through a void the nozzle cone clears
      plunges++;
      const depth = Math.abs(m.z - start.z);
      if (depth > plunge.tipLen - plunge.margin + 1e-6) {
        failures.push({ assertion: name, line: m.line, layer: m.layerIndex, message: `plunge ${depth.toFixed(2)} mm deeper than the tip allows (${(plunge.tipLen - plunge.margin).toFixed(2)} mm)`, actual: depth, expected: plunge.tipLen - plunge.margin });
        continue;
      }
      const clear = coneClear(m, start, plunge);
      plungeMinClear = Math.min(plungeMinClear, clear);
      if (clear < 0) failures.push({ assertion: name, line: m.line, layer: m.layerIndex, message: `steep draw into a void that is not clear: plastic ${(-clear).toFixed(3)} mm inside the nozzle cone [${worstAt}]`, actual: clear, expected: 0 });
      continue;
    }
    if (theta > worst) worst = theta;
    if (theta > thetaMax + TOL.angle) failures.push({ assertion: name, line: m.line, layer: m.layerIndex, message: `ramp ${(theta * 180 / Math.PI).toFixed(2)} deg > limit ${thetaMaxDeg} deg`, actual: (theta * 180) / Math.PI, expected: thetaMaxDeg });
    } finally { if (m.isExtruding) pending = { m, st: start }; }
  }
  return result(name, failures, { maxThetaDeg: (worst * 180) / Math.PI, minExtrusionZ: Number.isFinite(minZ) ? minZ : 0, plunges, plungeMinClearanceMm: Number.isFinite(plungeMinClear) ? plungeMinClear : 0 });
}

/**
 * Z-modulated (egg-crate) weave: the signal lives in Z, not XY. For each pair of adjacent layers (from `fromLayer`),
 * the Z offsets of the beads about their layer's own mean Z, sampled on a common XY grid, must be anti-correlated
 * (Pearson r <= TOL.zWeaveCorrelation) and non-trivial (std >= minAmplitude), i.e. neighbouring beads interlock.
 */
export function checkZWeaveAntiPhase(pts: Pt3[], o: { fromLayer: number; cell: number; minAmplitude: number }): AssertionResult {
  const name = 'z-weave-antiphase';
  const failures: Failure[] = [];
  const byLayer = new Map<number, Pt3[]>();
  for (const p of pts) if (p.layer >= o.fromLayer) (byLayer.get(p.layer) ?? byLayer.set(p.layer, []).get(p.layer)!).push(p);
  const grids = new Map<number, Map<string, number>>();
  for (const [l, lp] of byLayer) {
    const base = lp.map((p) => p.z).sort((a, b) => a - b)[Math.floor(lp.length / 2)];
    const g = new Map<string, { s: number; n: number }>();
    for (const p of lp) { const k = `${Math.round(p.x / o.cell)},${Math.round(p.y / o.cell)}`; const c = g.get(k) ?? { s: 0, n: 0 }; c.s += p.z - base; c.n++; g.set(k, c); }
    grids.set(l, new Map([...g].map(([k, c]) => [k, c.s / c.n])));
  }
  const layers = [...grids.keys()].sort((a, b) => a - b);
  let worstR = -1, minStd = Infinity, pairs = 0;
  for (let a = 0; a + 1 < layers.length; a++) {
    if (layers[a + 1] !== layers[a] + 1) continue;
    const A = grids.get(layers[a])!, B = grids.get(layers[a + 1])!;
    const xs: number[] = [], ys: number[] = [];
    for (const [k, v] of A) { const w = B.get(k); if (w !== undefined) { xs.push(v); ys.push(w); } }
    if (xs.length < 30) continue;
    pairs++;
    const mean = (v: number[]) => v.reduce((s, q) => s + q, 0) / v.length;
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    const std = Math.sqrt(sxx / xs.length);
    minStd = Math.min(minStd, std);
    const r = sxy / Math.sqrt(Math.max(sxx * syy, 1e-30));
    worstR = Math.max(worstR, r);
    if (std < o.minAmplitude || r > TOL.zWeaveCorrelation) failures.push({ assertion: name, layer: layers[a], message: `layers ${layers[a]}/${layers[a + 1]}: Z-offset correlation ${r.toFixed(3)} (need <= ${TOL.zWeaveCorrelation}), std ${std.toFixed(4)} (need >= ${o.minAmplitude})`, actual: r, expected: TOL.zWeaveCorrelation });
  }
  if (!pairs) failures.push({ assertion: name, message: 'no adjacent layer pairs with shared XY cells' });
  return result(name, failures, { pairs, worstCorrelation: worstR, minOffsetStd: Number.isFinite(minStd) ? minStd : 0 });
}
