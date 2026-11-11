// RE-PINNED (reverse-verifier remediation): Basic hashes changed only because a first-layer bottom-surface width of 0 now means
// 'same as initial layer' as its tooltip says (checked: reverting that one line restores the old hashes). Advanced hashes changed because
// E now follows true 3-D bead length / local bead height on non-planar paths (see tests/reverse-verifier).
// Advanced mode is its own engine: Basic-engine changes must never alter its G-code. The config fixture
// and these hashes come from main before the Basic settings rework (81187d6); the same config through the same
// technologies must keep producing exactly that G-code.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { slice } from '../../src/engine/slicer';
import { md5 } from '../../src/io/md5';
import { box, cylinder, dome, indexed, tube } from './shapes';

const cfgs = JSON.parse(fs.readFileSync(new URL('./fixtures/legacy-config.json', import.meta.url), 'utf8'));
const run = (m: ReturnType<typeof indexed>, c: Record<string, unknown>, techs: string[], intent = 'aesthetic') =>
  md5(slice([m], c as any, () => {}, { advanced: { intent, printerId: 'x', techs: Object.fromEntries(techs.map((t) => [t, { enabled: true }])), resolution: 'draft' } as any }).gcode);

const CASES: { name: string; run: () => string; hash: string }[] = [
  { name: 'tangent entry seams', run: () => run(indexed(box(90, 90, 0, 30, 30, 8), 'b'), cfgs.p1s, ['tangent_entry']), hash: 'e5bb5118831b38156e4aa3d8e45e764e' },
  { name: 'scarf splice', run: () => run(indexed(cylinder(100, 100, 12, 8), 'c'), cfgs.p1s, ['scarf_splice']), hash: 'fadc2822a6ef5cda422dc2a5c7216996' },
  { name: 'helical thick-vase', run: () => run(indexed(tube(100, 100, 15, 3, 20), 'tube'), cfgs.x1c, ['thick_vase']), hash: '8eeec327b4a624ffaaadb561f825e9e7' },
  { name: 'sub-voxel anti-aliasing', run: () => run(indexed(dome(100, 100, 20, 8, 4), 'd'), cfgs.x1c, ['subvoxel_aa']), hash: '511e0712d81cecbd2c2ae22e4858a13e' },
  { name: 'Eulerian spiral infill', run: () => run(indexed(box(90, 90, 0, 25, 25, 6), 'b'), cfgs.p1s, ['eulerian_spiral'], 'structural'), hash: '9efe70400fc4bd6aef297a7563bf13a3' }, // re-pinned: z_weave E now follows the true 3-D segment length (was 2-D, ~1-28% under-extrusion on sloped beads),
];

describe('Advanced mode is independent of the Basic engine', () => {
  for (const c of CASES) it(`${c.name} — G-code unchanged`, () => { expect(c.run()).toBe(c.hash); });
});
