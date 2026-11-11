// Plantex → Renex: the design's printed parts at full quality, assembled (pot standing in its saucer,
// self-watering insert inside), with the soil line, rim and saucer so Renex can add soil, plants and water.
import * as THREE from 'three';
import { useStore } from '../../state/store';
import { filamentById } from '../../profiles/filaments';
import { finishFor } from '../../renex/materials';
import { printSettingsFromConfig } from '../../renex/config';
import { soupOf, type RenexSceneSource, type SourcePart } from '../../renex/source';
import type { PlantexSpec } from './model';
import { buildParts, pt } from './ui/state';

/** Inner radius of the body at height z (mm), from the profile points (r is the outer radius). */
function innerRadiusAt(spec: PlantexSpec, z: number): number {
  const pts = [...spec.profile].sort((a, b) => a.z - b.z);
  const f = Math.max(0, Math.min(1, z / Math.max(1, spec.height)));
  let r = pts[pts.length - 1]?.r ?? 50;
  for (let i = 0; i < pts.length - 1; i++) if (f >= pts[i].z && f <= pts[i + 1].z) { const t = (f - pts[i].z) / Math.max(1e-6, pts[i + 1].z - pts[i].z); r = pts[i].r + (pts[i + 1].r - pts[i].r) * t; break; }
  if (f < (pts[0]?.z ?? 0)) r = pts[0]?.r ?? r;
  return Math.max(5, r - spec.wall);
}

export function plantexRenexSource(): RenexSceneSource {
  const spec = pt.spec;
  const s = useStore.getState();
  const slot = (k: number) => {
    const f = s.filaments[k] ?? s.filaments[0];
    const prof = filamentById(f.presetId);
    return { hex: f.color, type: prof?.type ?? 'PLA', name: prof?.name ?? 'PLA' };
  };
  const built = buildParts(spec, false);
  const warnings: string[] = [];
  const planter = spec.kind === 'planter' && !spec.vaseMode;
  // assembly: saucer on the table, pot standing on the saucer floor (and its ribs), insert on the pot floor
  const saucerLift = planter && spec.saucer.enabled ? spec.saucer.floor + (spec.saucer.ribs > 0 ? 1.6 : 0) : 0;
  const parts: SourcePart[] = built.map((p) => {
    const soup = soupOf(p.result.mesh.vertices, p.result.mesh.indices);
    const z = p.key === 'body' ? saucerLift : p.key === 'insert' ? saucerLift + Math.max(0.8, spec.floor) : 0;
    const f = slot(p.filament);
    const paintSlots = p.paint ? [...new Set(p.paint)].filter((c) => c > 0) : [];
    const paintHex: string[] = [];
    for (const c of paintSlots) paintHex[c - 1] = slot(c - 1).hex;
    return {
      key: p.key, name: p.label, printSoup: soup,
      assembled: new THREE.Matrix4().makeTranslation(0, 0, z),
      exploded: new THREE.Vector3(0, 0, p.key === 'body' ? spec.saucer.height + 20 : p.key === 'insert' ? spec.height + 60 : 0),
      hex: f.hex, finish: finishFor(f.type, f.name), colourName: f.hex, materialName: f.name,
      paint: p.paint && paintSlots.length ? p.paint : undefined, paintHex: paintSlots.length ? paintHex : undefined,
    };
  });
  for (const p of built) warnings.push(...p.result.warnings);
  const rimZ = saucerLift + spec.height;
  // soil sits ~8% of the height (min 10 mm) under the rim; in a self-watering planter it fills the insert
  const soilDrop = Math.max(10, spec.height * 0.08);
  const soilZLocal = spec.height - soilDrop;
  let soilRadius = innerRadiusAt(spec, soilZLocal);
  if (planter && spec.selfWater.enabled) soilRadius = Math.max(5, soilRadius - spec.selfWater.gap - spec.selfWater.wall);
  const saucerR = planter && spec.saucer.enabled ? innerRadiusAt(spec, 0) + spec.wall + spec.saucer.gap : 0;
  return {
    source: 'plantex', title: spec.name, parts, print: printSettingsFromConfig(), warnings,
    planter: {
      kind: planter ? 'planter' : 'vase', soilZ: saucerLift + soilZLocal, soilRadius,
      rimZ, rimRadius: innerRadiusAt(spec, spec.height) + spec.wall,
      saucer: saucerR ? { z: spec.saucer.floor, radius: saucerR + spec.saucer.flare * 0.3, depth: Math.max(1, spec.saucer.height - spec.saucer.floor) } : undefined,
    },
  };
}
