// Bulnex Vision: a small on-device model that learns what *this* print looks like and flags frames that
// don't match. Bulnex prints the same thing over and over, so the model trains itself while it runs:
//
//   • Empty-bed model — learned from frames right after a push. A later post-push frame that differs
//     (a part left behind, a stuck brim, debris) is reported as "bed not clear".
//   • Print model — one reference per slice of print progress, learned from the first good cycle(s).
//     Later cycles are compared at the same progress; spaghetti, a detached part or a blob shows up as a
//     cluster of cells that differ, and must persist over several frames before an alert.
//
// Features per grid cell: mean brightness, gradient energy and a 4-bin gradient-orientation histogram,
// computed on a downscaled, brightness-normalised greyscale frame. Statistics are running mean/variance
// (Welford). No network, no cloud: everything runs on the frames in this window.

export const GRID_W = 16, GRID_H = 9;
export const FRAME_W = 96, FRAME_H = 54;
const CELL_W = FRAME_W / GRID_W, CELL_H = FRAME_H / GRID_H;
export const FEATURES = 6;
const CELLS = GRID_W * GRID_H;

/** Greyscale frame, FRAME_W × FRAME_H, values 0..1. */
export type Gray = Float32Array;

/** RGBA pixels (any size) → normalised greyscale FRAME_W × FRAME_H (area average). */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const out = new Float32Array(FRAME_W * FRAME_H);
  const cnt = new Float32Array(FRAME_W * FRAME_H);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(FRAME_H - 1, Math.floor((y * FRAME_H) / h));
    for (let x = 0; x < w; x++) {
      const gx = Math.min(FRAME_W - 1, Math.floor((x * FRAME_W) / w));
      const i = (y * w + x) * 4;
      out[gy * FRAME_W + gx] += (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) / 255;
      cnt[gy * FRAME_W + gx]++;
    }
  }
  let mean = 0;
  for (let i = 0; i < out.length; i++) { out[i] /= Math.max(1, cnt[i]); mean += out[i]; }
  mean /= out.length;
  let sd = 0;
  for (let i = 0; i < out.length; i++) sd += (out[i] - mean) ** 2;
  sd = Math.sqrt(sd / out.length) || 1;
  // brightness / contrast normalisation: the chamber light and daylight change over a long run
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mean) / sd;
  return out;
}

/** Cell features: CELLS × FEATURES. */
export function features(g: Gray): Float32Array {
  const f = new Float32Array(CELLS * FEATURES);
  const n = CELL_W * CELL_H;
  for (let cy = 0; cy < GRID_H; cy++) for (let cx = 0; cx < GRID_W; cx++) {
    const o = (cy * GRID_W + cx) * FEATURES;
    for (let y = cy * CELL_H; y < (cy + 1) * CELL_H; y++) for (let x = cx * CELL_W; x < (cx + 1) * CELL_W; x++) {
      const v = g[y * FRAME_W + x];
      const gx = x > 0 && x < FRAME_W - 1 ? (g[y * FRAME_W + x + 1] - g[y * FRAME_W + x - 1]) / 2 : 0;
      const gy = y > 0 && y < FRAME_H - 1 ? (g[(y + 1) * FRAME_W + x] - g[(y - 1) * FRAME_W + x]) / 2 : 0;
      const mag = Math.hypot(gx, gy);
      f[o] += v / n;
      f[o + 1] += mag / n;
      // orientation bins 0°, 45°, 90°, 135° (unsigned)
      const a = (Math.atan2(gy, gx) + Math.PI) % Math.PI;
      f[o + 2 + (Math.round(a / (Math.PI / 4)) % 4)] += mag / n;
    }
  }
  return f;
}

/** Running per-feature statistics. */
export class CellModel {
  n = 0;
  mean = new Float32Array(CELLS * FEATURES);
  m2 = new Float32Array(CELLS * FEATURES);
  learn(f: Float32Array): void {
    this.n++;
    for (let i = 0; i < f.length; i++) {
      const d = f[i] - this.mean[i];
      this.mean[i] += d / this.n;
      this.m2[i] += d * (f[i] - this.mean[i]);
    }
  }
  /** Per-cell anomaly (largest feature z-score in the cell). */
  zMap(f: Float32Array): Float32Array {
    const z = new Float32Array(CELLS);
    // variance floor: with only a few training frames the variance underestimates normal noise
    const floor = [0.04, 0.01, 0.005, 0.005, 0.005, 0.005];
    for (let c = 0; c < CELLS; c++) {
      let m = 0;
      for (let k = 0; k < FEATURES; k++) {
        const i = c * FEATURES + k;
        const varc = (this.n > 1 ? this.m2[i] / (this.n - 1) : 0) + floor[k];
        m = Math.max(m, Math.abs(f[i] - this.mean[i]) / Math.sqrt(varc));
      }
      z[c] = m;
    }
    return z;
  }
  toJSON() { return { n: this.n, mean: [...this.mean], m2: [...this.m2] }; }
  static from(j: { n: number; mean: number[]; m2: number[] }): CellModel {
    const m = new CellModel(); m.n = j.n; m.mean.set(j.mean); m.m2.set(j.m2); return m;
  }
}

/** Largest 4-connected cluster of cells over the threshold (inside the region of interest). */
export function largestCluster(z: Float32Array, thr: number, roi?: Uint8Array): { size: number; cells: number[] } {
  const seen = new Uint8Array(CELLS);
  let best: number[] = [];
  for (let s = 0; s < CELLS; s++) {
    if (seen[s] || z[s] < thr || (roi && !roi[s])) continue;
    const stack = [s], cells: number[] = [];
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const x = c % GRID_W, y = Math.floor(c / GRID_W);
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
        const k = ny * GRID_W + nx;
        if (!seen[k] && z[k] >= thr && (!roi || roi[k])) { seen[k] = 1; stack.push(k); }
      }
    }
    if (cells.length > best.length) best = cells;
  }
  return { size: best.length, cells: best };
}

export interface Verdict { anomaly: boolean; score: number; cluster: number[]; z: Float32Array; trained: boolean }

export interface VisionOptions {
  /** z-score a cell must exceed. Higher = fewer alerts. */
  threshold: number;
  /** Cells that must differ together. */
  minCells: number;
  /** Consecutive anomalous print frames before an alert. */
  persistence: number;
  /** Frames needed before a model is used. */
  minTraining: number;
}
export const DEFAULT_VISION: VisionOptions = { threshold: 5, minCells: 3, persistence: 4, minTraining: 3 };

/** Progress slices for the print model. */
export const BUCKETS = 20;

export class BulnexVision {
  empty = new CellModel();
  print: CellModel[] = Array.from({ length: BUCKETS }, () => new CellModel());
  /** Cells that show the plate (1) — learned from where the empty bed differs from a printing bed, or all. */
  roi: Uint8Array = new Uint8Array(CELLS).fill(1);
  private streak = 0;
  constructor(public opts: VisionOptions = DEFAULT_VISION) {}

  private judge(model: CellModel, f: Float32Array): Verdict {
    if (model.n < this.opts.minTraining) return { anomaly: false, score: 0, cluster: [], z: new Float32Array(CELLS), trained: false };
    const z = model.zMap(f);
    const c = largestCluster(z, this.opts.threshold, this.roi);
    return { anomaly: c.size >= this.opts.minCells, score: c.size, cluster: c.cells, z, trained: true };
  }

  /** Post-push frame. Learns it when the bed looks empty (or while still training). */
  checkEmpty(g: Gray): Verdict {
    const f = features(g);
    const v = this.judge(this.empty, f);
    if (!v.anomaly) this.empty.learn(f);
    return v;
  }
  /** Teach the empty-bed model explicitly (user pressed "Learn empty bed"). */
  learnEmpty(g: Gray): void { this.empty.learn(features(g)); }

  /** Frame while printing at `progress` (0..1). `learn` = this cycle is a reference cycle. Alerts need persistence. */
  checkPrint(g: Gray, progress: number, learn: boolean): Verdict & { alert: boolean } {
    const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor(progress * BUCKETS)));
    const f = features(g);
    if (learn) { this.print[b].learn(f); return { anomaly: false, score: 0, cluster: [], z: new Float32Array(CELLS), trained: false, alert: false }; }
    const v = this.judge(this.print[b], f);
    this.streak = v.anomaly ? this.streak + 1 : 0;
    // frames that match keep refining the model (slow drift: lighting, filament colour batch)
    if (v.trained && !v.anomaly) this.print[b].learn(f);
    return { ...v, alert: this.streak === this.opts.persistence };
  }
  resetStreak(): void { this.streak = 0; }

  toJSON() { return { empty: this.empty.toJSON(), print: this.print.map((m) => m.toJSON()), roi: [...this.roi] }; }
  static from(j: ReturnType<BulnexVision['toJSON']>, opts?: VisionOptions): BulnexVision {
    const v = new BulnexVision(opts);
    v.empty = CellModel.from(j.empty);
    v.print = j.print.map(CellModel.from);
    v.roi = Uint8Array.from(j.roi);
    return v;
  }
}
