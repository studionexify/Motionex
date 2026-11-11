// Adaptive pressure advance (OrcaSlicer AdaptivePAInterpolator / AdaptivePAProcessor): a filament's PA measured at
// a few volumetric flows and accelerations ("pa,flow,accel" per line, adaptive_pressure_advance_model) is fitted with
// monotone cubic (PCHIP) curves, PA over flow per acceleration and then over acceleration; at every line type change
// (and with adaptive_pressure_advance_overhangs inside a line type when the flow changes) the PA for the coming flow
// and acceleration is written when it differs. Bridges use adaptive_pressure_advance_bridges when it is set.
import type { FilamentSlot } from './types';
import type { Config } from '../profiles/settings';

/** Monotone piecewise cubic Hermite interpolation; clamped to the end values outside the data. */
export function pchip(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  if (n === 1) return () => ys[0];
  const h = xs.slice(1).map((x, k) => x - xs[k]);
  const d = h.map((hk, k) => (ys[k + 1] - ys[k]) / hk);
  const m = new Array<number>(n).fill(0);
  if (n === 2) { m[0] = m[1] = d[0]; }
  else {
    for (let k = 1; k < n - 1; k++) {
      if (d[k - 1] * d[k] <= 0) m[k] = 0;
      else { const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1]; m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]); }
    }
    const end = (h0: number, h1: number, d0: number, d1: number) => {
      let v = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
      if (Math.sign(v) !== Math.sign(d0)) v = 0; else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(v) > Math.abs(3 * d0)) v = 3 * d0;
      return v;
    };
    m[0] = end(h[0], h[1], d[0], d[1]);
    m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let k = 0;
    while (k < n - 2 && x > xs[k + 1]) k++;
    const t = (x - xs[k]) / h[k], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h[k] * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h[k] * m[k + 1];
  };
}

/** PA model from "pa,flow,accel" lines; null when it has fewer than two flows at any acceleration. */
export function paModel(text: string): ((flow: number, accel: number) => number) | null {
  const byAcc = new Map<number, [number, number][]>();
  for (const line of String(text ?? '').split(/\n|\\n/)) {
    const v = line.split(',').map((s) => Number(s.trim()));
    if (v.length < 3 || v.some((x) => !Number.isFinite(x))) continue;
    const [pa, flow, acc] = v;
    if (!byAcc.has(acc)) byAcc.set(acc, []);
    byAcc.get(acc)!.push([flow, pa]);
  }
  const curves: [number, (x: number) => number][] = [];
  for (const [acc, pts] of [...byAcc].sort((a, b) => a[0] - b[0])) {
    const s = pts.sort((a, b) => a[0] - b[0]).filter((p, k, arr) => k === 0 || p[0] > arr[k - 1][0]);
    if (s.length > 1) curves.push([acc, pchip(s.map((p) => p[0]), s.map((p) => p[1]))]);
  }
  if (!curves.length || curves.every(([, f]) => f(0) === 0 && f(1e6) === 0)) return null;
  return (flow, accel) => {
    const pas = curves.map(([, f]) => f(flow));
    const v = curves.length === 1 ? pas[0] : pchip(curves.map(([a]) => a), pas)(accel);
    return Math.round(v * 1000) / 1000;
  };
}

/** Per tool: PA lines to write when the line type (or, with overhangs on, the flow inside it) changes. */
export class AdaptivePA {
  private models: (((flow: number, accel: number) => number) | null)[];
  private last = NaN;
  private lastTool = -1;
  constructor(private filaments: FilamentSlot[], private cfg: Config, private flavor: string) {
    this.models = filaments.map((fl) => {
      const s = fl.settings ?? {};
      return (s.adaptive_pressure_advance ?? cfg.adaptive_pressure_advance) === true ? paModel(String(s.adaptive_pressure_advance_model ?? cfg.adaptive_pressure_advance_model ?? '')) : null;
    });
  }
  /** Any filament uses it. */
  get on() { return this.models.some((m) => m); }
  /** Within features (overhangs, line width changes) for this tool. */
  overhangs(tool: number) { const s = this.filaments[tool]?.settings ?? {}; return this.models[tool] !== null && (s.adaptive_pressure_advance_overhangs ?? this.cfg.adaptive_pressure_advance_overhangs) === true; }
  /** The PA line for a stretch printed at `flow` mm³/s and `accel` mm/s², or '' when unchanged / not used. */
  line(tool: number, bridge: boolean, flow: number, accel: number): string {
    const model = this.models[tool];
    if (!model) return '';
    const s = this.filaments[tool]?.settings ?? {};
    const bridgePa = Number(s.adaptive_pressure_advance_bridges ?? this.cfg.adaptive_pressure_advance_bridges ?? 0);
    let pa = bridge && bridgePa > 1e-6 ? bridgePa : model(flow, accel);
    if (!(pa >= 0)) pa = this.filaments[tool]?.pressureAdvance ?? 0;
    if (tool === this.lastTool && Math.abs(pa - this.last) < 1e-6) return '';
    this.last = pa; this.lastTool = tool;
    return this.flavor === 'klipper' ? `SET_PRESSURE_ADVANCE ADVANCE=${pa}` : `M900 K${pa}`;
  }
}
