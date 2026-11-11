// Flushing volumes between filament colours. Going from a dark to a light colour needs far more
// purge than the reverse; strongly saturated colours bleed more than neutral ones.
const rgb = (hex: string) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) || 0) / 255);
const lum = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const sat = ([r, g, b]: number[]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };

/** Estimated purge (mm³) to change from colour `a` to colour `b`. */
export function flushVolume(a: string, b: string): number {
  if (a.toLowerCase() === b.toLowerCase()) return 0;
  const A = rgb(a), B = rgb(b);
  const dl = lum(B) - lum(A); // brighter target needs more purge
  const dist = Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) / Math.sqrt(3);
  const v = 110 + 420 * Math.max(0, dl) + 180 * dist + 120 * sat(A) * Math.max(0, dl + 0.2);
  return Math.round(Math.min(900, Math.max(100, v)) / 5) * 5;
}

export function autoFlushMatrix(colors: string[]): number[][] {
  return colors.map((a, i) => colors.map((b, j) => (i === j ? 0 : flushVolume(a, b))));
}

/** Matrix used for slicing: manual values where set (and sized right), times the multiplier. */
export function effectiveFlush(colors: string[], manual: number[][] | null, mult: number): number[][] {
  const auto = autoFlushMatrix(colors);
  return auto.map((row, i) => row.map((v, j) => Math.round((manual?.[i]?.[j] ?? v) * (mult || 1))));
}
