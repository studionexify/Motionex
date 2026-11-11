// Outline smoothing for sliced layers: removes the facets of a coarse mesh from each layer's outline without touching
// the mesh. Points within `radius` (mm of outline length) of each other are averaged; vertices that turn by more than
// `cornerDeg` are kept exactly, so real corners stay sharp. Convex curves shrink by about radius²/(6·curve radius).
import { SCALE } from './clipper';
import type { Path, Paths } from './types';

export function smoothPaths(paths: Paths, radius: number, cornerDeg = 35): Paths {
  if (!(radius > 0)) return paths;
  return paths.map((p) => smoothLoop(p, radius, cornerDeg));
}

function smoothLoop(path: Path, radius: number, cornerDeg: number): Path {
  const n0 = path.length;
  if (n0 < 4) return path;
  const cosCorner = Math.cos((cornerDeg * Math.PI) / 180);
  const px = path.map((p) => p.X / SCALE), py = path.map((p) => p.Y / SCALE);
  // resample: keep every original point, add points so no segment is longer than radius / 2
  const step = radius / 2;
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < n0; i++) {
    const j = (i + 1) % n0;
    xs.push(px[i]); ys.push(py[i]);
    const d = Math.hypot(px[j] - px[i], py[j] - py[i]);
    const k = Math.floor(d / step);
    for (let q = 1; q <= k && d - q * step > step * 0.25; q++) {
      const t = (q * step) / d;
      xs.push(px[i] + (px[j] - px[i]) * t); ys.push(py[i] + (py[j] - py[i]) * t);
    }
  }
  const n = xs.length;
  if (n < 8) return path;
  const seg = xs.map((x, i) => Math.hypot(xs[(i + 1) % n] - x, ys[(i + 1) % n] - ys[i]));
  // a corner is where the outline, seen at the scale of `radius`, turns by more than cornerDeg (so noise is not mistaken for a corner)
  const reach = (i: number, dir: number) => {
    let len = 0, j = i;
    for (let k = 0; k < n && len < radius; k++) { len += dir > 0 ? seg[j] : seg[(j + n - 1) % n]; j = (j + dir + n) % n; }
    return j;
  };
  const fixed = xs.map((_, i) => {
    const b = reach(i, -1), f = reach(i, 1);
    const ux = xs[i] - xs[b], uy = ys[i] - ys[b], vx = xs[f] - xs[i], vy = ys[f] - ys[i];
    const l = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    return l > 0 && (ux * vx + uy * vy) / l < cosCorner;
  });
  const ox = new Array<number>(n), oy = new Array<number>(n);
  const w = Math.max(1, Math.round(radius / step)); // neighbours on each side that fit in the window
  for (let i = 0; i < n; i++) {
    if (fixed[i]) { ox[i] = xs[i]; oy[i] = ys[i]; continue; }
    let sx = xs[i], sy = ys[i], c = 1;
    for (let dir = -1; dir <= 1; dir += 2) {
      let len = 0;
      for (let k = 1; k <= w * 2; k++) {
        const j = (i + dir * k + n * 4) % n;
        len += dir > 0 ? seg[(j + n - 1) % n] : seg[j];
        if (len > radius) break;
        sx += xs[j]; sy += ys[j]; c++;
        if (fixed[j]) break; // a corner ends the window (and counts as its end point)
      }
    }
    ox[i] = sx / c; oy[i] = sy / c;
  }
  return ox.map((x, i) => ({ X: Math.round(x * SCALE), Y: Math.round(oy[i] * SCALE) }));
}
