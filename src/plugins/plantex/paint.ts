// Multi-filament colouring: texture layers with their own filament paint the body triangles that lie in
// their raised / recessed area (per-triangle colour paint, the same data the colour brush writes).
import type { IndexedMesh } from '../../engine/mesh';
import type { PlantexSpec } from './model';
import { bodyFn } from './shape';
import { layerValue, type Mask } from './textures';

/**
 * Colour paint for a body mesh in build coordinates (axis at the origin, base at z = 0), or undefined when
 * no layer has its own filament. Values: 0 = object filament, k = slot k − 1.
 */
export function paintBody(mesh: IndexedMesh, spec: PlantexSpec, masks: (key: string) => Mask | undefined): Uint8Array | undefined {
  const layers = spec.textures.filter((t) => t.enabled && t.filament >= 0 && t.filament !== spec.filaments.body && t.mode !== 'cut');
  if (!layers.length) return undefined;
  const body = bodyFn(spec);
  const H = body.height;
  let rRef = 0;
  for (let k = 0; k <= 8; k++) rRef += body.radius(0, (H * k) / 8) / 9;
  const v = mesh.vertices, ix = mesh.indices;
  const out = new Uint8Array(ix.length / 3);
  const wall = spec.vaseMode ? 0.5 : Math.max(0.8, spec.wall);
  const lm = layers.map((L) => (L.kind === 'pattern' && L.patternKey ? masks(L.patternKey) : undefined));
  let any = false;
  for (let t = 0; t < out.length; t++) {
    const a3 = ix[t * 3] * 3, b3 = ix[t * 3 + 1] * 3, c3 = ix[t * 3 + 2] * 3;
    const x = (v[a3] + v[b3] + v[c3]) / 3, y = (v[a3 + 1] + v[b3 + 1] + v[c3 + 1]) / 3, z = (v[a3 + 2] + v[b3 + 2] + v[c3 + 2]) / 3;
    if (z <= 0.05 || z >= H - 0.05) continue;
    const a = Math.atan2(y, x);
    // outer face (and the outer half of hole edges) only
    if (Math.hypot(x, y) < body.radius(a, z) - wall * 0.5) continue;
    const u = (((a / (2 * Math.PI)) % 1) + 1) % 1;
    for (let k = 0; k < layers.length; k++) {
      const L = layers[k];
      if (layerValue(L, u, z, H, rRef, lm[k]) > 0.5) { out[t] = L.filament + 1; any = true; }
    }
  }
  return any ? out : undefined;
}
