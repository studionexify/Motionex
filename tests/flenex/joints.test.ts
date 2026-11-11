import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { boolean, bounds, cylinder, initKernel, minDistance, pieces, transform, volume } from '../../src/plugins/flenex/csg';
import { buildFlexi, cutFrame, newCut } from '../../src/plugins/flenex/flexi';
import { defaultJoint, type JointKind } from '../../src/plugins/flenex/joints';
import { fitFor } from '../../src/plugins/flenex/fit';
import { openEdgeCount } from '../../src/engine/mesh';

beforeAll(initKernel);

/** Piece A is the one below the cut plane. */
const lower = (ps: ReturnType<typeof pieces>['meshes']) => ps.slice().sort((a, b) => bounds(a).max[2] - bounds(b).max[2]);

function rotateAbout(m: ReturnType<typeof cylinder>, pivot: THREE.Vector3, axis: THREE.Vector3, deg: number) {
  const M = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new THREE.Matrix4().makeRotationAxis(axis.clone().normalize(), (deg * Math.PI) / 180))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  return transform(m, M);
}

describe('print-in-place joints', () => {
  for (const kind of ['ball', 'hinge', 'swivel'] as JointKind[]) for (const r of [9, 14]) {
    it(`${kind} in a Ø${2 * r} rod: closed, two pieces, clearance kept, moves through its range`, () => {
      const fit = fitFor(0.4);
      const body = cylinder(r, r, -45, 45, 48);
      const res = buildFlexi(body, [newCut('1', [0.3, 0.2, 0], [0, 0, 1], defaultJoint(kind))], fit);
      expect(res.reports[0].ok).toBe(true);
      expect(openEdgeCount(res.mesh)).toBe(0);
      expect(res.pieces.length).toBe(2);
      const [A, B] = lower(res.pieces);
      expect(volume(A)).toBeGreaterThan(0);
      expect(minDistance(A, B)).toBeGreaterThan(fit.clearance - 0.03);
      // articulate piece A about the joint pivot, to the range of motion the joint reports
      const info = res.reports[0].info!;
      const M = cutFrame(res.reports[0].centre, [0, 0, 1], 0);
      const pivot = new THREE.Vector3(...info.pivot).applyMatrix4(M);
      const axes: THREE.Vector3[] = info.axis
        ? [new THREE.Vector3(...info.axis).transformDirection(M)]
        : [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 1, 0)];
      const rom = kind === 'swivel' ? 80 : info.rom - 1.5; // swivel: twist about the spine
      for (const ax of axes) for (const sign of [1, -1]) {
        const moved = rotateAbout(A, pivot, ax, sign * rom);
        const hit = boolean(moved, B, 'intersection');
        expect(volume(hit), `${kind} ${sign * rom}° about ${ax.toArray().map((x) => x.toFixed(1))}`).toBeLessThan(0.05);
      }
    });
  }

  it('reports a section that is too thin instead of building a broken joint', () => {
    const res = buildFlexi(cylinder(1.6, 1.6, -20, 20, 24), [newCut('1', [0, 0, 0], [0, 0, 1])], fitFor(0.4));
    expect(res.reports[0].ok).toBe(false);
    expect(res.reports[0].warnings.length).toBeGreaterThan(0);
  });

  it('follows the nozzle: a 0.6 mm nozzle gets wider gaps', () => {
    expect(fitFor(0.6).clearance).toBeGreaterThan(fitFor(0.4).clearance);
    expect(fitFor(0.2).clearance).toBeLessThan(fitFor(0.4).clearance);
  });
});

describe('more cut types', () => {
  const kinds: [JointKind, number, boolean][] = [['chain', 2, true], ['dowel', 2, false], ['snap', 2, false], ['dovetail', 2, false], ['plain', 2, false], ['universal', 3, true]];
  for (const [kind, count, moves] of kinds) for (const r of [11, 16]) {
    it(`${kind} in a Ø${2 * r} rod: closed, ${count} pieces, clearance kept${moves ? ', moves' : ''}`, () => {
      const fit = fitFor(0.4);
      const res = buildFlexi(cylinder(r, r, -60, 60, 48), [newCut('1', [0.2, 0.1, 0], [0, 0, 1], defaultJoint(kind))], fit);
      const rep = res.reports[0];
      expect(rep.ok, rep.warnings.join('|')).toBe(true);
      expect(openEdgeCount(res.mesh)).toBe(0);
      expect(res.pieces.length).toBe(count);
      const ps = lower(res.pieces);
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        if (kind === 'universal' && i === 0 && j === 2) continue;
        // only touching-range neighbours are compared for assembly joints (they are fits, not gaps)
        const d = minDistance(ps[i], ps[j]);
        expect(d, `${kind} pieces ${i}/${j}`).toBeGreaterThan(Math.min(kind === 'plain' ? fit.gap - 0.05 : 0.1, fit.clearance - 0.03));
      }
      if (kind === 'universal') {
        const info = rep.info!, M = cutFrame(rep.centre, [0, 0, 1], 0);
        const [A, Mid, B] = ps;
        const rot = info.rom - 2;
        for (const sign of [1, -1]) {
          const p1 = new THREE.Vector3(...info.pivot).applyMatrix4(M), a1 = new THREE.Vector3(...info.axis!).transformDirection(M);
          expect(volume(boolean(rotateAbout(A, p1, a1, sign * rot), boolean(Mid, B, 'union'), 'intersection')), 'hinge 1').toBeLessThan(0.05);
          const p2 = new THREE.Vector3(...info.pivot2!).applyMatrix4(M), a2 = new THREE.Vector3(...info.axis2!).transformDirection(M);
          expect(volume(boolean(rotateAbout(B, p2, a2, sign * rot), boolean(Mid, A, 'union'), 'intersection')), 'hinge 2').toBeLessThan(0.05);
        }
      }
    });
  }
});

describe('thin sections fall back to a ball joint', () => {
  for (const [kind, r] of [['universal', 6], ['chain', 3.9]] as [JointKind, number][]) {
    it(`${kind} in a thin Ø${2 * r} rod becomes a working ball & socket`, () => {
      const fit = fitFor(0.4);
      const res = buildFlexi(cylinder(r, r, -40, 40, 36), [newCut('1', [0, 0, 0], [0, 0, 1], defaultJoint(kind))], fit);
      const rep = res.reports[0];
      expect(rep.ok).toBe(true);
      expect(rep.info!.kind).toBe('ball');
      expect(rep.info!.fellBack).toBe(kind);
      expect(rep.warnings.join(' ')).toMatch(/ball & socket is used here instead/);
      expect(openEdgeCount(res.mesh)).toBe(0);
      expect(res.pieces.length).toBe(2);
      expect(minDistance(res.pieces[0], res.pieces[1])).toBeGreaterThan(fit.clearance - 0.03);
    });
  }
  it('a thick rod still gets the universal joint', () => {
    const res = buildFlexi(cylinder(16, 16, -60, 60, 40), [newCut('1', [0, 0, 0], [0, 0, 1], defaultJoint('universal'))], fitFor(0.4));
    expect(res.reports[0].info!.kind).toBe('universal');
    expect(res.reports[0].info!.fellBack).toBeUndefined();
  });
});
