// #9 Anisotropic Gray–Scott Turing infill. A reaction–diffusion pair on a grid over the object
//   ∂u/∂t = ∇·(D_u∇u) − uv² + F(1 − u),   ∂v/∂t = ∇·(D_v∇v) + uv² − (F + k)v
// with D = D₀(I + β d⊗d), d the stress direction (or the outline tangent when no stress field is on),
// grows a labyrinth of ribs stretched along the load paths. Diffusion is halved round the bolt holes
// (a shorter wavelength: denser ribs at the hubs). The state carries from layer to layer, so the ribs
// stack into continuous trabecular walls; each layer prints the v = ½ contours.
import { clipLines, SCALE } from '../../clipper';
import type { Paths } from '../../types';
import { rng } from '../grid';
import { isolines, maskDistance, rasterize, type RasterRegion } from '../offsets';
import type { SessionCtx, TechModule } from '../session';
import { designDensity, stressOf } from './fea';

/** Wavelength (cells) of the labyrinth for D_u = 0.2, D_v = 0.1 at F ≈ 0.037, k ≈ 0.06. */
export const GS_WAVELENGTH = 9;

export interface GsState { nx: number; ny: number; ox: number; oy: number; h: number; u: Float32Array; v: Float32Array; layer: number; steps: number }

export function gsInit(nx: number, ny: number, ox: number, oy: number, h: number, seed: number): GsState {
  const n = nx * ny, u = new Float32Array(n).fill(1), v = new Float32Array(n);
  const rnd = rng(seed);
  for (let q = 0; q < Math.max(4, n / 60); q++) {
    const ci = Math.floor(rnd() * nx), cj = Math.floor(rnd() * ny);
    for (let j = cj - 2; j <= cj + 2; j++) for (let i = ci - 2; i <= ci + 2; i++) if (i >= 0 && j >= 0 && i < nx && j < ny) { u[i + nx * j] = 0.5; v[i + nx * j] = 0.25 + 0.05 * rnd(); }
  }
  return { nx, ny, ox, oy, h, u, v, layer: -1, steps: 0 };
}

/**
 * Explicit steps of the anisotropic Gray–Scott system on the masked cells (outside: u = 1, v = 0).
 * dir gives the anisotropy axis (unit) per cell and scale a diffusion multiplier.
 */
export function gsStep(st: GsState, mask: Uint8Array, steps: number, F: number, k: number, beta: number, dirX: Float32Array, dirY: Float32Array, scale: Float32Array) {
  const { nx, ny } = st;
  const Du = 0.2, Dv = 0.1;
  const dt = Math.min(1, 0.2 / (Du * (1 + beta)));
  const n = nx * ny;
  // diffusion tensor per cell, D = m(I + β d⊗d)
  const dxx = new Float32Array(n), dyy = new Float32Array(n), dxy = new Float32Array(n);
  const inner: number[] = [];
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const p = i + nx * j;
    if (!mask[p]) continue;
    inner.push(p);
    const x = dirX[p], y = dirY[p], m = scale[p];
    dxx[p] = (1 + beta * x * x) * m; dyy[p] = (1 + beta * y * y) * m; dxy[p] = 0.5 * beta * x * y * m; // ×2 / 4 of the cross stencil
  }
  const cells = Int32Array.from(inner);
  let u = st.u, v = st.v;
  // outside the region: u = 1, v = 0 (cells off the mask, and the grid border)
  for (let p = 0; p < n; p++) if (!mask[p] || p < nx || p >= n - nx || p % nx === 0 || p % nx === nx - 1) { u[p] = 1; v[p] = 0; }
  let u2 = Float32Array.from(u), v2 = Float32Array.from(v);
  for (let s = 0; s < steps; s++) {
    for (let c = 0; c < cells.length; c++) {
      const p = cells[c];
      const a = dxx[p], b = dyy[p], x = dxy[p];
      const uc = u[p], vc = v[p];
      const lu = a * (u[p + 1] - 2 * uc + u[p - 1]) + b * (u[p + nx] - 2 * uc + u[p - nx]) + x * (u[p + nx + 1] - u[p - nx + 1] - u[p + nx - 1] + u[p - nx - 1]);
      const lv = a * (v[p + 1] - 2 * vc + v[p - 1]) + b * (v[p + nx] - 2 * vc + v[p - nx]) + x * (v[p + nx + 1] - v[p - nx + 1] - v[p + nx - 1] + v[p - nx - 1]);
      const uvv = uc * vc * vc;
      let nu = uc + dt * (Du * lu - uvv + F * (1 - uc)), nv = vc + dt * (Dv * lv + uvv - (F + k) * vc);
      u2[p] = nu < 0 ? 0 : nu > 1 ? 1 : nu;
      v2[p] = nv < 0 ? 0 : nv > 1 ? 1 : nv;
    }
    const tu = u; u = u2; u2 = tu;
    const tv = v; v = v2; v2 = tv;
  }
  st.u = u; st.v = v; st.steps += steps;
}

/** Mask of the state grid inside the region polygons. */
function gridMask(st: GsState, region: Paths): Uint8Array {
  const r = rasterize(region, st.h, 0);
  const mask = new Uint8Array(st.nx * st.ny);
  if (!r) return mask;
  for (let j = 0; j < st.ny; j++) for (let i = 0; i < st.nx; i++) {
    const x = st.ox + i * st.h, y = st.oy + j * st.h;
    const a = Math.round((x - r.ox) / r.h), b = Math.round((y - r.oy) / r.h);
    if (a >= 0 && b >= 0 && a < r.nx && b < r.ny && r.mask[a + r.nx * b]) mask[i + st.nx * j] = 1;
  }
  return mask;
}

export const turingInfill: TechModule = {
  id: 'turing_infill',
  infill(s: SessionCtx, o, region, c) {
    const r = s.report('turing_infill');
    const a = s.parts[o];
    const density = designDensity(s, c.density);
    // rib spacing w/ρ: two contours per wavelength
    const cell = Math.max(0.25, ((2 * c.width) / density / GS_WAVELENGTH) * s.pnum('turing_infill', 'scale'));
    const st = s.memo(`gs:${o}`, () => {
      const nx = Math.ceil((a.sdf.max[0] - a.sdf.min[0]) / cell) + 3, ny = Math.ceil((a.sdf.max[1] - a.sdf.min[1]) / cell) + 3;
      return gsInit(Math.min(nx, 400), Math.min(ny, 400), a.sdf.min[0] - cell, a.sdf.min[1] - cell, Math.max(cell, (a.sdf.max[0] - a.sdf.min[0] + 3 * cell) / 400, (a.sdf.max[1] - a.sdf.min[1] + 3 * cell) / 400), 1234 + o);
    });
    const mask = gridMask(st, region);
    let count = 0;
    for (const m of mask) count += m;
    if (count < 16) return undefined;
    const n = st.nx * st.ny, dirX = new Float32Array(n), dirY = new Float32Array(n), scale = new Float32Array(n).fill(1);
    const ps = s.on('fea_stress') || s.on('spinor_fields') ? stressOf(s, o) : null;
    const tmp = [0, 0, 0, 0, 0, 0];
    const z = c.z - c.h / 2;
    // outline tangent from the distance-to-edge gradient when there is no stress field
    const rr: RasterRegion = { nx: st.nx, ny: st.ny, ox: st.ox, oy: st.oy, h: st.h, mask };
    const dist = ps ? null : maskDistance(rr);
    for (let j = 0; j < st.ny; j++) for (let i = 0; i < st.nx; i++) {
      const p = i + st.nx * j;
      if (!mask[p]) continue;
      const x = st.ox + i * st.h, y = st.oy + j * st.h;
      let th = 0;
      if (ps && ps.field.at(x, y, z, tmp)) th = 0.5 * Math.atan2(2 * tmp[5], tmp[0] - tmp[1]);
      else if (dist) {
        const gx = (dist[Math.min(p + 1, n - 1)] - dist[Math.max(p - 1, 0)]), gy = (dist[Math.min(p + st.nx, n - 1)] - dist[Math.max(p - st.nx, 0)]);
        th = Math.atan2(gy, gx) + Math.PI / 2;
      }
      dirX[p] = Math.cos(th); dirY[p] = Math.sin(th);
      for (const b of a.bosses) if (z >= b.z0 - 1 && z <= b.z1 + 1 && Math.hypot(x - b.cx, y - b.cy) <= b.r + Math.max(2.5 * b.r, 3)) scale[p] = 0.5;
    }
    // first layer grows the pattern, later layers continue it
    if (st.layer !== c.layer) {
      gsStep(st, mask, st.steps === 0 ? 2000 : 50, s.pnum('turing_infill', 'F'), s.pnum('turing_infill', 'k'), s.pnum('turing_infill', 'aniso'), dirX, dirY, scale);
      st.layer = c.layer;
    }
    const phi = new Float64Array(n);
    for (let p = 0; p < n; p++) phi[p] = mask[p] ? st.v[p] : 0;
    const loops = isolines(rr, phi, 0.2).filter((l) => l.length >= 8);
    const lines: Paths = loops.map((l) => { const p = []; for (let k = 0; k <= l.length; k += 2) { const q = k % l.length; p.push({ X: Math.round(l[q] * SCALE), Y: Math.round(l[q + 1] * SCALE) }); } return p; });
    const clipped = clipLines(lines, region);
    r.stats = { cell_mm: +st.h.toFixed(2), reaction_steps: st.steps, ribs: (Number(r.stats?.ribs) || 0) + clipped.length, anisotropy_axis: ps ? 'stress' : 'outline' };
    return clipped.map((p) => ({ pts: p.flatMap((q) => [q.X / SCALE, q.Y / SCALE]), closed: false, width: c.width }));
  },
};
