// Thick-thread preview data, shared by every plugin that draws quick previews on the model.
// A plugin hands over its threads as beads (start, end, width, height, colour) at the real line size,
// so the 3D view shows the strand as it looks when printed: layers touch with no gap, and every in-and-out
// move shows as a real bulge. The overhang check is worked out here, ahead of time, from how far each
// thread sits from the layer under it: threads that reach too far out sag, and those that reach much
// further drip. No slicing is needed.

/** Share of the line width a thread can sit out from the layer below and still be held up. */
export const SAFE_REACH = 0.5;
/** Share of the line width where the thread starts to droop clearly. */
export const DROOP_REACH = 1;
/** Share of the line width where hot plastic runs off in a drip. */
export const DRIP_REACH = 1.6;
/** Reaches beyond this (mm) are bridges, not overhangs: the check leaves them alone. */
const FAR_MM = 4;

export interface ThreadData {
  /** Bead ends, x y z per bead. z is the top of the bead. */
  start: Float32Array;
  end: Float32Array;
  /** Width and height per bead (mm). */
  wh: Float32Array;
  /** rgb per bead, 0..1. */
  color: Float32Array;
  /** Drips: x y z length radius per drip. z is the top of the drip. */
  drips: Float32Array;
  /** rgb per drip, 0..1 (already warmed to look hot). */
  dripColor: Float32Array;
}

export interface DroolReport {
  /** Furthest a thread sits from the layer under it (mm). */
  worstMm: number;
  /** Reach that is still safe (mm) and the reach where drips start (mm), for this line width. */
  safeMm: number;
  dripMm: number;
  beads: number;
  /** Beads that sag, and beads that reach far enough to drip. */
  sagging: number;
  dripping: number;
  drips: number;
  /** Long travels that leave a string behind. */
  strings: number;
  /** True when the view was thinned to stay fast. */
  thinned: boolean;
  level: 'ok' | 'sag' | 'drip';
}

export interface PluginPreview {
  /** Quick lines for the model: every segment, drawn when the thread view is off. */
  positions: Float32Array;
  colors: Float32Array;
  /** Real-size beads, drawn instead of the lines when the thread view is on. */
  threads?: ThreadData;
  /** Markers (pauses, lift-offs) drawn as lines on top of the threads. */
  markers?: { positions: Float32Array; colors: Float32Array };
  drool?: DroolReport;
}

export const emptyDrool = (w = 0.42): DroolReport => ({ worstMm: 0, safeMm: SAFE_REACH * w, dripMm: DRIP_REACH * w, beads: 0, sagging: 0, dripping: 0, drips: 0, strings: 0, thinned: false, level: 'ok' });

/**
 * How far a thread slumps (as a share of the layer height) for a reach r, given as a share of the line width.
 * Nothing up to the safe reach, a little sag to the droop reach, then more and more.
 */
export function sagShare(r: number): number {
  if (r <= SAFE_REACH) return 0;
  if (r <= DROOP_REACH) return 0.35 * ((r - SAFE_REACH) / (DROOP_REACH - SAFE_REACH));
  if (r <= DRIP_REACH) return 0.35 + 0.65 * ((r - DROOP_REACH) / (DRIP_REACH - DROOP_REACH));
  return 1 + Math.min(2, r - DRIP_REACH);
}

/** Distance from a point to the nearest segment (x0 y0 x1 y1 …), through a coarse grid. */
export function segmentField(segs: ArrayLike<number>, cell: number): (x: number, y: number) => number {
  const grid = new Map<string, number[]>();
  for (let k = 0; k < segs.length; k += 4) {
    const x0 = Math.floor(Math.min(segs[k], segs[k + 2]) / cell), x1 = Math.floor(Math.max(segs[k], segs[k + 2]) / cell);
    const y0 = Math.floor(Math.min(segs[k + 1], segs[k + 3]) / cell), y1 = Math.floor(Math.max(segs[k + 1], segs[k + 3]) / cell);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const key = `${gx}|${gy}`; const l = grid.get(key); if (l) l.push(k); else grid.set(key, [k]);
    }
  }
  return (x: number, y: number) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    let best = Infinity;
    for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iy = gy - 1; iy <= gy + 1; iy++) {
      for (const k of grid.get(`${ix}|${iy}`) ?? []) {
        const ax = segs[k], ay = segs[k + 1], dx = segs[k + 2] - ax, dy = segs[k + 3] - ay;
        const L2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
        best = Math.min(best, Math.hypot(x - ax - u * dx, y - ay - u * dy));
      }
    }
    return best;
  };
}

/** The colour of hot plastic, mixed into drips. */
const HOT: readonly number[] = [1, 0.42, 0.12];
const hash = (a: number, b: number) => { const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return s - Math.floor(s); };

export class ThreadBuilder {
  private S: number[] = []; private E: number[] = []; private WH: number[] = []; private C: number[] = [];
  private D: number[] = []; private DC: number[] = [];
  private cur: number[] = [];
  private prev: ((x: number, y: number) => number) | null = null;
  private pitch = 1;
  private sinceDrip = 0;
  private rep: DroolReport;
  /** Spacing between drips along a thread (mm). */
  private readonly dripGap: number;

  constructor(readonly lineWidth: number, readonly layerHeight: number, private warp: ((x: number, y: number, z: number) => [number, number]) | null = null, private maxBeads = 200_000, private maxDrips = 2500) {
    this.rep = emptyDrool(lineWidth);
    this.dripGap = Math.max(2, lineWidth * 5);
  }

  get beads() { return this.S.length / 3; }
  get full() { return this.beads >= this.maxBeads; }

  /** Forget the layer below: the next layer starts a new stack (new object, or a gap in the stack). */
  newStack(): void { this.endLayer(); this.prev = null; }

  /** Start the next layer up. `pitch` = how many real layers this one stands for (thinned previews). */
  layer(pitch = 1): void {
    this.endLayer();
    this.pitch = Math.max(1, pitch); this.sinceDrip = 0;
  }
  private endLayer(): void {
    if (this.cur.length) this.prev = segmentField(this.cur, 2);
    this.cur = [];
  }

  /**
   * One bead from a to b (z = centre of the bead). The check measures how far its middle sits from the
   * layer below, and sags the bead and adds a drip when that reach is too big. Returns the bead's number
   * (-1 when the view is full), so a caller can colour it later.
   */
  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, rgb: ArrayLike<number>, wScale = 1, check = true): number {
    if (this.full) { this.rep.thinned = true; return -1; }
    if (this.warp) { [ax, ay] = this.warp(ax, ay, az); [bx, by] = this.warp(bx, by, bz); }
    const w = this.lineWidth, h = this.layerHeight * this.pitch;
    this.cur.push(ax, ay, bx, by);
    let sag = 0, ws = wScale;
    if (check && this.prev) {
      const d = this.prev((ax + bx) / 2, (ay + by) / 2) / this.pitch;
      if (d < FAR_MM) {
        this.rep.worstMm = Math.max(this.rep.worstMm, d);
        const r = d / w, k = sagShare(r);
        if (k > 0) {
          this.rep.sagging++;
          sag = k * h;
          ws *= Math.max(0.55, 1 - 0.25 * k);
          if (r > DRIP_REACH) {
            this.rep.dripping++;
            this.sinceDrip += Math.hypot(bx - ax, by - ay);
            if (this.sinceDrip >= this.dripGap && this.D.length / 5 < this.maxDrips * 24) {
              this.sinceDrip = 0;
              const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
              const len = Math.min(7, 0.8 + (r - DRIP_REACH) * 2.5) * (0.75 + 0.5 * hash(mx, my));
              this.D.push(mx, my, mz - h / 2 - sag, len, w * (0.45 + 0.15 * hash(my, mx)));
              this.DC.push(rgb[0] + (HOT[0] - rgb[0]) * 0.55, rgb[1] + (HOT[1] - rgb[1]) * 0.55, rgb[2] + (HOT[2] - rgb[2]) * 0.55);
              this.rep.drips++;
            }
          }
        }
      }
    }
    this.S.push(ax, ay, az + h / 2 - sag); this.E.push(bx, by, bz + h / 2 - sag);
    this.WH.push(w * ws, h); this.C.push(rgb[0], rgb[1], rgb[2]);
    return this.beads - 1;
  }

  /** A string left by a long travel: a thin thread that hangs between the two ends. */
  string(ax: number, ay: number, az: number, bx: number, by: number, bz: number, rgb: ArrayLike<number>): void {
    if (this.warp) { [ax, ay] = this.warp(ax, ay, az); [bx, by] = this.warp(bx, by, bz); }
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 2.5 || this.full) return;
    this.rep.strings++;
    const n = 6, drop = Math.min(1.5, len * 0.12), thin = 0.35;
    const p = (t: number): [number, number, number] => [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t - 4 * drop * t * (1 - t)];
    const h = this.layerHeight * thin;
    for (let i = 0; i < n; i++) {
      const a = p(i / n), b = p((i + 1) / n);
      this.S.push(a[0], a[1], a[2] + h / 2); this.E.push(b[0], b[1], b[2] + h / 2);
      this.WH.push(this.lineWidth * thin, h); this.C.push(rgb[0], rgb[1], rgb[2]);
    }
  }

  finish(): { threads: ThreadData; report: DroolReport } {
    this.endLayer();
    const r = this.rep;
    r.beads = this.beads;
    r.level = r.dripping ? 'drip' : r.sagging ? 'sag' : 'ok';
    // too many drips to draw: keep an even spread over the whole part, not just the first layers
    const n = this.D.length / 5, keep = Math.min(n, this.maxDrips), D: number[] = [], DC: number[] = [];
    for (let k = 0; k < keep; k++) {
      const i = Math.floor((k * n) / keep);
      D.push(...this.D.slice(i * 5, i * 5 + 5)); DC.push(...this.DC.slice(i * 3, i * 3 + 3));
    }
    return {
      threads: { start: Float32Array.from(this.S), end: Float32Array.from(this.E), wh: Float32Array.from(this.WH), color: Float32Array.from(this.C), drips: Float32Array.from(D), dripColor: Float32Array.from(DC) },
      report: r,
    };
  }
}

export const hasThreads = (t: ThreadData | undefined): t is ThreadData => !!t && t.wh.length > 0;

/** Several thread sets as one; reports are added up and the worst reach kept. */
export function mergeThreads(list: { threads: ThreadData; report: DroolReport }[]): { threads: ThreadData; report: DroolReport } | null {
  if (!list.length) return null;
  const cat = (pick: (t: ThreadData) => Float32Array) => {
    const n = list.reduce((a, x) => a + pick(x.threads).length, 0), o = new Float32Array(n);
    let k = 0; for (const x of list) { const a = pick(x.threads); o.set(a, k); k += a.length; }
    return o;
  };
  const rep = emptyDrool(list[0].report.safeMm / SAFE_REACH);
  for (const { report: r } of list) {
    rep.worstMm = Math.max(rep.worstMm, r.worstMm); rep.beads += r.beads; rep.sagging += r.sagging; rep.dripping += r.dripping;
    rep.drips += r.drips; rep.strings += r.strings; rep.thinned = rep.thinned || r.thinned;
  }
  rep.level = rep.dripping ? 'drip' : rep.sagging ? 'sag' : 'ok';
  return { threads: { start: cat((t) => t.start), end: cat((t) => t.end), wh: cat((t) => t.wh), color: cat((t) => t.color), drips: cat((t) => t.drips), dripColor: cat((t) => t.dripColor) }, report: rep };
}

/** Plain beads for line previews that carry no thread data of their own (every segment becomes one bead). */
export function linesToThreads(positions: Float32Array, colors: Float32Array, lineWidth: number, layerHeight: number): ThreadData {
  const n = Math.floor(positions.length / 6);
  const start = new Float32Array(n * 3), end = new Float32Array(n * 3), wh = new Float32Array(n * 2), color = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) { start[i * 3 + k] = positions[i * 6 + k]; end[i * 3 + k] = positions[i * 6 + 3 + k]; color[i * 3 + k] = (colors[i * 6 + k] + colors[i * 6 + 3 + k]) / 2; }
    start[i * 3 + 2] += layerHeight / 2; end[i * 3 + 2] += layerHeight / 2;
    wh[i * 2] = lineWidth; wh[i * 2 + 1] = layerHeight;
  }
  return { start, end, wh, color, drips: new Float32Array(0), dripColor: new Float32Array(0) };
}
