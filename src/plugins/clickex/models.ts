// Built-in sample 3D models: solids of revolution (closed, watertight) about 35 mm across, drawn here.
import { weld, type IndexedMesh } from '../../engine/mesh';

export interface SampleModel { id: string; name: string; make(): IndexedMesh }

type Profile = [number, number][];

/** Revolve a profile (radius, height) from the bottom pole to the top pole; `lobes` ripples the radius. */
function lathe(profile: Profile, n = 72, lobes = 0, depth = 0): IndexedMesh {
  const out: number[] = [];
  const ring = (k: number): [number, number, number][] => Array.from({ length: n }, (_, j) => {
    const a = (j / n) * Math.PI * 2, [r, z] = profile[k], rr = r * (1 + depth * Math.cos(lobes * a));
    return [rr * Math.cos(a), rr * Math.sin(a), z];
  });
  for (let k = 0; k + 1 < profile.length; k++) {
    const A = ring(k), B = ring(k + 1);
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      out.push(...A[j], ...A[j1], ...B[j1], ...A[j], ...B[j1], ...B[j]);
    }
  }
  return weld(new Float32Array(out));
}

const arc = (cx: number, cz: number, rx: number, rz: number, a0: number, a1: number, n = 16): Profile =>
  Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [Math.max(0, cx + rx * Math.cos(a)), cz + rz * Math.sin(a)] as [number, number]; });

export const SAMPLE_MODELS: SampleModel[] = [
  { id: 'pumpkin', name: 'Pumpkin', make: () => lathe([[0, 0], [10, 0], ...arc(0, 14, 17.5, 14, -Math.PI / 2 + 0.5, Math.PI / 2 - 0.1, 20), [3, 28.2], [3.2, 31], [0, 31]], 96, 8, 0.07) },
  { id: 'dome', name: 'Dome', make: () => lathe([[0, 0], [17.5, 0], ...arc(0, 0, 17.5, 22, 0, Math.PI / 2, 24).slice(1)]) },
  { id: 'mushroom', name: 'Mushroom', make: () => lathe([[0, 0], [7, 0], [5.5, 6], [5.2, 16], [6, 18], [17, 18], ...arc(0, 18, 17.5, 15, 0, Math.PI / 2, 20).slice(1)]) },
  { id: 'pawn', name: 'Pawn', make: () => lathe([[0, 0], [13, 0], [13, 2.5], [9, 4], [5.5, 9], [4.5, 16], [8, 18], [8, 20], [4.5, 21.5], ...arc(0, 28, 7, 7, -Math.PI / 2.4, Math.PI / 2, 14).slice(1)]) },
  { id: 'cupcake', name: 'Cupcake', make: () => lathe([[0, 0], [9, 0], [14, 12], [15.5, 13], [14, 16], [11, 19], [8, 23], [4.5, 27], [0, 31]]) },
  { id: 'knob', name: 'Knob', make: () => lathe([[0, 0], [21, 0], [21, 22], [19, 25], [16, 27], [0, 27]], 96) },
  { id: 'gem', name: 'Gem', make: () => lathe([[0, 0], [8, 0], [16, 12], [12, 22], [0, 30]], 8) },
];

export const sampleModel = (id: string): IndexedMesh => (SAMPLE_MODELS.find((m) => m.id === id) ?? SAMPLE_MODELS[0]).make();
