// Lumonex → Renex: the lamp's printed parts (print orientation + where each sits in the lamp), and the real
// electrical hardware placed where the studio's preview ghosts are: bulb (or LED puck), holder, cord route.
import * as THREE from 'three';
import { finishFor } from '../../renex/materials';
import { printSettingsFromConfig } from '../../renex/config';
import { rigidFit, toBed, type LampInfo, type RenexSceneSource, type SourcePart } from '../../renex/source';
import { assembled, buildLamp, rotateXYZ, type BuiltPart } from './build';
import { bounds } from './geom';
import { bulbById, holderById } from './catalog';
import { bedOf, lx } from './ui/state';

/** Frame of a lathe-built ghost (axis = local +Z through the soup's XY centre, origin at height z0) in the assembly. */
function ghostFrame(p: BuiltPart, z0: number): THREE.Matrix4 {
  const b = bounds(p.soup);
  const local = new THREE.Matrix4().makeTranslation((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, z0);
  const asm = rigidFit(new Float32Array(p.soup), new Float32Array(assembled(p)));
  return asm.multiply(local);
}

export function lumonexRenexSource(): RenexSceneSource {
  const d = { ...lx.design, showBulb: true, quality: lx.design.quality === 'draft' ? 'normal' as const : lx.design.quality };
  const built = buildLamp(d as typeof lx.design, bedOf());
  const parts: SourcePart[] = [];
  const real = built.parts.filter((p) => !p.ghost && p.soup.length);
  // exploded offsets: stack parts by height, like the studio's exploded view
  const order = real.map((p, i) => { const b = bounds(assembled(p)); return { i, z: (b.min[2] + b.max[2]) / 2 }; }).sort((a, b) => a.z - b.z);
  const rank = new Map(order.map((o, r) => [o.i, r]));
  real.forEach((p, i) => {
    const print = toBed(new Float32Array(rotateXYZ([...p.soup], p.printRot)));
    // vertex order is kept by every transform, so one rigid fit recovers print bed → assembly
    const toAsm = rigidFit(print, new Float32Array(assembled(p)));
    parts.push({
      key: p.key, name: p.name, printSoup: print, assembled: toAsm,
      exploded: new THREE.Vector3(0, 0, (rank.get(i) ?? 0) * 45),
      hex: p.hex, finish: finishFor(p.material, p.material), colourName: p.color, materialName: p.material,
    });
  });

  const ghost = (k: string) => built.parts.find((p) => p.key === k && p.soup.length);
  const holderDef = holderById(d.fitting.holder);
  const bulbDef = bulbById(d.bulb);
  const lamp: LampInfo = { kind: d.kind, watts: d.watts, cord: [], cordEnd: 'none', cordDiameter: 6, lit: lx.lit };
  const gb = ghost('ghost-bulb'), gh = ghost('ghost-holder'), gc = ghost('ghost-cord');
  const pad = holderDef.mount === 'pad' || holderDef.mount === 'strip';
  if (gb) {
    const z0 = bounds(gb.soup).min[2];
    if (pad || bulbDef.id.startsWith('puck')) lamp.puck = { diameter: (bulbDef.profile[0]?.[0] ?? 22) * 2, frame: ghostFrame(gb, z0) };
    else lamp.bulb = { profile: bulbDef.profile, frame: ghostFrame(gb, z0), base: holderDef.id.startsWith('b') ? 'bayonet' : holderDef.id.startsWith('e') ? 'screw' : 'none', name: bulbDef.name };
  }
  if (gh) {
    const b = bounds(gh.soup);
    lamp.holder = { body: holderDef.body, length: holderDef.length, above: holderDef.above, kind: holderDef.id.startsWith('b') ? 'bayonet' : 'screw', frame: ghostFrame(gh, b.min[2] + holderDef.length) };
  }
  // cord route: down the lamp's core from the holder, out at the foot, across the table to a switch and plug
  const all = real.map((p) => bounds(assembled(p)));
  const minZ = Math.min(...all.map((b) => b.min[2])), maxR = Math.max(...all.map((b) => Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]), Math.abs(b.min[1]), Math.abs(b.max[1]))));
  const holderAt = lamp.holder ? new THREE.Vector3().setFromMatrixPosition(lamp.holder.frame).add(new THREE.Vector3(0, 0, -(holderDef.length + 4))) : new THREE.Vector3(0, 0, minZ + 20);
  if (d.kind === 'lantern' || d.fitting.holder === 'battery') { lamp.cordEnd = 'none'; }
  else if (d.kind === 'pendant' || d.kind === 'ceiling') {
    if (gc) { const b = bounds(assembled(gc)); lamp.cord = [new THREE.Vector3(0, 0, b.min[2]), new THREE.Vector3(0, 0, b.max[2])]; }
    lamp.cordEnd = 'ceiling';
  } else if (d.kind === 'wall' || d.kind === 'mount') {
    lamp.cord = [holderAt, new THREE.Vector3(0, maxR * 0.2, minZ + 10), new THREE.Vector3(0, maxR + 30, minZ - 30), new THREE.Vector3(0, maxR + 40, minZ - 400)];
    lamp.cordEnd = 'wall';
  } else {
    const out = maxR + 25;
    lamp.cord = [
      holderAt, new THREE.Vector3(0, 0, minZ + 8), new THREE.Vector3(0, out * 0.6, minZ + 4), new THREE.Vector3(0, out, minZ + 3),
      new THREE.Vector3(out * 0.25, out + 120, minZ + 3), new THREE.Vector3(-out * 0.2, out + 300, minZ + 3), new THREE.Vector3(out * 0.4, out + 520, minZ + 3),
    ];
    lamp.cordEnd = 'plug';
    lamp.foot = { centre: new THREE.Vector3(0, 0, minZ), radius: Math.max(20, maxR * 0.7) };
  }
  return { source: 'lumonex', title: d.name, parts, print: printSettingsFromConfig(), warnings: [...built.report.warnings], lamp };
}
