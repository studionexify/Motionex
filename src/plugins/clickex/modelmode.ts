// Clickex 3D model mode: turn any closed model into a clicker.
//   split  the model is cut in two; the top comes off as the button (tongue-and-groove hides the gap)
//   top    a round button is cut out of the model's top; the rest of the model is the base
//   stand  the whole model is the button, standing on a clicker base
// The model is carved with mesh booleans (three-bvh-csg); the switch parts come from the same geometry as
// the flat clickers. Buttons here print upright (the model stays the right way up) and want supports.
import * as THREE from 'three';
import { Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { difference, union } from '../../engine/clipper';
import { cutAtZ0 } from '../../engine/meshops';
import { meshBounds, meshVolume, repairTJunctions, weld, type IndexedMesh } from '../../engine/mesh';
import { sliceMesh } from '../../engine/slice';
import type { Paths } from '../../engine/types';
import { buildClicker, heightsOf, type BuiltClicker, type Part } from './build';
import { baseShapePaths } from './catalog';
import { boundsMm, circlePath, crossPaths, grow, meshOfShells, pole, prism, rectPath, shrink, translatePaths, type Shell } from './geom';
import type { ClickexSpec } from './model';
import { effectiveSwitch, findSwitchIn, pocketSize, type Plan } from './plan';

const PLA = 1.24e-3;

const toGeometry = (m: IndexedMesh) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.vertices, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  return g;
};

export function csg(a: IndexedMesh, b: IndexedMesh, op: 'difference' | 'intersection'): IndexedMesh {
  const ev = new Evaluator();
  ev.attributes = ['position'];
  ev.useGroups = false;
  const A = new Brush(toGeometry(a)), B = new Brush(toGeometry(b));
  A.updateMatrixWorld(); B.updateMatrixWorld();
  const g = ev.evaluate(A, B, op === 'difference' ? SUBTRACTION : INTERSECTION).geometry;
  const ng = g.index ? g.toNonIndexed() : g;
  return repairTJunctions(weld(new Float32Array(ng.getAttribute('position').array as ArrayLike<number>)));
}

const solid = (paths: Paths, z0: number, z1: number): IndexedMesh => meshOfShells([{ soup: prism(paths, z0, z1), slot: 0 }]).mesh;

export function merge(...ms: IndexedMesh[]): IndexedMesh {
  const v: number[] = [], ix: number[] = [];
  for (const m of ms) { const base = v.length / 3; for (const x of m.vertices) v.push(x); for (const i of m.indices) ix.push(i + base); }
  return { vertices: new Float32Array(v), indices: Uint32Array.from(ix) };
}

export function translateMesh(m: IndexedMesh, dx: number, dy: number, dz: number): IndexedMesh {
  const v = new Float32Array(m.vertices);
  for (let i = 0; i < v.length; i += 3) { v[i] += dx; v[i + 1] += dy; v[i + 2] += dz; }
  return { vertices: v, indices: m.indices };
}

export interface ModelAsset { name: string; mesh: IndexedMesh }

/** Scale about the origin and drop onto z = 0, centred in XY. */
export function scaledModel(asset: ModelAsset, percent: number): IndexedMesh {
  const k = percent / 100, v = new Float32Array(asset.mesh.vertices);
  for (let i = 0; i < v.length; i++) v[i] *= k;
  const b = meshBounds(v);
  for (let i = 0; i < v.length; i += 3) { v[i] -= (b.min[0] + b.max[0]) / 2; v[i + 1] -= (b.min[1] + b.max[1]) / 2; v[i + 2] -= b.min[2]; }
  return { vertices: v, indices: asset.mesh.indices };
}

export const modelSize = (m: IndexedMesh): [number, number, number] => { const b = meshBounds(m.vertices); return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]; };

/** Rotate an asset 90° about an axis (to stand a model up). */
export function rotateAsset(asset: ModelAsset, axis: 'x' | 'y' | 'z'): ModelAsset {
  const v = new Float32Array(asset.mesh.vertices);
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i], y = v[i + 1], z = v[i + 2];
    if (axis === 'x') { v[i + 1] = -z; v[i + 2] = y; } else if (axis === 'y') { v[i] = z; v[i + 2] = -x; } else { v[i] = -y; v[i + 1] = x; }
  }
  const b = meshBounds(v);
  for (let i = 0; i < v.length; i += 3) { v[i] -= (b.min[0] + b.max[0]) / 2; v[i + 1] -= (b.min[1] + b.max[1]) / 2; v[i + 2] -= b.min[2]; }
  return { name: asset.name, mesh: { vertices: v, indices: asset.mesh.indices } };
}

/** Button hardware under a plug: stub that enters the housing, wider part above, cross socket. */
function bossShells(spec: ClickexSpec, x: number, y: number, angle: number, z0: number, ceil: number, stub: number): Shell[] {
  const sw = effectiveSwitch(spec);
  const socket = crossPaths(x, y, sw.armLen + spec.fit.bossTol, sw.armWid + spec.fit.bossTol, angle);
  const out: Shell[] = [{ soup: prism(difference([circlePath(x, y, spec.fit.bossD / 2, 40)], socket), z0, Math.min(z0 + stub, ceil + 0.3)), slot: 0 }];
  if (z0 + stub < ceil - 0.05) out.push({ soup: prism(difference([circlePath(x, y, spec.fit.bossD / 2 + 1.2, 40)], socket), z0 + stub, ceil + 0.3), slot: 0 });
  return out;
}

function part(key: 'base' | 'button', name: string, mesh: IndexedMesh, color: string, extra: Partial<Part> = {}): Part {
  return { key, name, mesh, slots: new Uint8Array(mesh.indices.length / 3), palette: [color.toLowerCase()], ...extra };
}

/** Negative space for the switch below a top plane `zTop` (the shoulder): pocket, plate hole, well. */
function switchCuts(spec: ClickexSpec, x: number, y: number, angle: number, zTop: number) {
  const sw = effectiveSwitch(spec), tol = spec.fit.switchTol;
  const plateTop = zTop - 1, plateBottom = plateTop - sw.plate;
  const wellD = Math.max(1, sw.belowPlate - sw.plate) + sw.pins + 0.6;
  const well = solid([rectPath(x, y, sw.clipSpan + 0.2 + tol, sw.clipSpan + 0.2 + tol, angle)], plateBottom - wellD, plateBottom);
  const hole = solid([rectPath(x, y, sw.cutout + tol, sw.cutout + tol, angle)], plateBottom - 0.3, plateTop + 0.3);
  const pocket = solid([rectPath(x, y, pocketSize(spec), pocketSize(spec), angle)], plateTop, zTop + 0.5);
  return { well, hole, pocket, plateTop, plateBottom, wellBottom: plateBottom - wellD };
}

function emptyResult(spec: ClickexSpec, msg: string): BuiltClicker {
  const H = heightsOf(spec);
  return { parts: [], switches: [], heights: H, report: { warnings: [msg], fits: false, size: [0, 0, 0], baseGrams: 0, buttonGrams: 0, engage: H.engage, minSize: null, triangles: 0 } };
}

export function buildFromModel(spec: ClickexSpec, model: IndexedMesh | null): BuiltClicker {
  if (!model || !model.indices.length) return emptyResult(spec, 'Add a 3D model (STL, OBJ or 3MF), or pick a sample.');
  const mode = spec.model.cut;
  const H = heightsOf(spec);
  const [mw, md, mh] = modelSize(model);
  const warnings: string[] = [];
  const travel = spec.sw.travel;
  const plugH = H.capTop - H.skirtBottom;      // button height from underside to top
  const ceilLocal = H.ceil - H.skirtBottom;     // blind end of the socket above the button's underside
  const bossLocal = H.bossBottom - H.skirtBottom;
  const cavSize = pocketSize(spec) + 0.2;

  if (mode === 'stand') {
    // a clicker base with the model standing on its button
    const D = Math.max(spec.model.standD, 28);
    const cap = baseShapePaths('circle', D, spec.body.baseRound);
    const plan: Plan = { base: cap, loop: [], art: [], warnings: [], fits: true, minSize: null, grown: null, size: [D, D], units: [{ id: 'u0', cx: 0, cy: 0, angle: 0, cap, art: [] }] };
    const built = buildClicker(spec, plan);
    const btn = built.parts[1];
    const placed = translateMesh(model, 0, 0, H.capTop);
    const mesh = merge(btn.mesh, placed);
    const slots = new Uint8Array(mesh.indices.length / 3);
    slots.set(btn.slots);
    built.parts[1] = { ...btn, name: `${spec.name} button`, mesh, slots, upright: true, supports: true };
    built.report.warnings.push(...warnings, 'The button prints upright with its underside hollow: supports are switched on for it.');
    built.report.size = [+Math.max(D, mw).toFixed(1), +Math.max(D, md).toFixed(1), +(H.capTop + mh).toFixed(1)];
    built.report.buttonGrams = +(meshVolume(mesh) * PLA).toFixed(1);
    return built;
  }

  if (mode === 'split') {
    const zc = Math.min(Math.max(spec.model.splitZ, 4), mh - 4);
    const lower = { vertices: new Float32Array(model.vertices), indices: model.indices };
    for (let i = 2; i < lower.vertices.length; i += 3) lower.vertices[i] -= zc;
    const cut = cutAtZ0(lower);
    if (!cut.below || !cut.above) return emptyResult(spec, 'The split height does not cross the model.');
    const S = sliceMesh(model, [zc + 0.01], 'regular')[0] ?? [];
    const wall = 1.2 + (spec.model.hideGap ? spec.model.lip + 0.8 : 0);
    const pos = findSwitchIn(spec, shrink(S, wall), cavSize);
    if (!pos.fits) warnings.push('The switch does not fit the cut face. Cut where the model is wider, or shrink Wall.');
    const cuts = switchCuts(spec, pos.x, pos.y, pos.angle, zc);
    if (cuts.wellBottom < 1.2) warnings.push(`The base is only ${zc.toFixed(0)} mm tall: it needs about ${(zc - cuts.wellBottom + 1.5).toFixed(0)} mm for the switch. Raise the split height.`);
    if (mh - zc < ceilLocal + 1.6) warnings.push(`The top is only ${(mh - zc).toFixed(0)} mm tall: it needs at least ${(ceilLocal + 1.6).toFixed(0)} mm. Lower the split height.`);
    let base = cut.below;
    for (const c of [cuts.well, cuts.hole, cuts.pocket]) base = csg(base, c, 'difference');
    base = translateMesh(base, 0, 0, zc);
    const lipH = travel + 0.3 + 2;
    const t0 = 1.6, tongue = difference(shrink(S, t0), shrink(S, t0 + spec.model.lip));
    const lipShell = spec.model.hideGap && tongue.length ? meshOfShells([{ soup: prism(tongue, zc - 0.3, zc + lipH), slot: 0 }]).mesh : null;
    if (lipShell) base = merge(base, lipShell);
    // top: cavity for the housing, groove for the tongue, boss with the socket; lifted by the rest gap
    let top = cut.above;
    top = csg(top, solid([rectPath(pos.x, pos.y, cavSize, cavSize, pos.angle)], -0.5, ceilLocal), 'difference');
    if (spec.model.hideGap && tongue.length) {
      const groove = difference(shrink(S, t0 - spec.fit.capClear), shrink(S, t0 + spec.model.lip + spec.fit.capClear));
      top = csg(top, solid(groove, -0.5, lipH - 0.3 + 0.2), 'difference');
    }
    const boss = meshOfShells(bossShells(spec, pos.x, pos.y, pos.angle, bossLocal, ceilLocal, H.stub)).mesh;
    top = translateMesh(merge(top, boss), 0, 0, zc + travel + 0.3);
    const parts = [part('base', `${spec.name} base`, base, spec.colors.base), part('button', `${spec.name} button`, top, spec.colors.button, { upright: true, supports: true })];
    return {
      parts, switches: [{ cx: pos.x, cy: pos.y, angle: pos.angle, plateTop: cuts.plateTop }], heights: { ...H, plateTop: cuts.plateTop, shoulder: zc, total: mh + travel + 0.3 },
      report: { warnings: [...warnings, 'The button prints upright with a hollow underside: supports are switched on for it.'], fits: pos.fits, size: [+mw.toFixed(1), +md.toFixed(1), +(mh + travel + 0.3).toFixed(1)], baseGrams: +(meshVolume(base) * PLA).toFixed(1), buttonGrams: +(meshVolume(top) * PLA).toFixed(1), engage: +H.engage.toFixed(1), minSize: null, triangles: (base.indices.length + top.indices.length) / 3 },
    };
  }

  // top: a round button cut out of the model's top
  const R = spec.model.buttonD / 2;
  const topSlice = sliceMesh(model, [mh - 2], 'regular')[0] ?? [];
  const region = shrink(topSlice, R);
  const centre = region.length ? pole(region, 0.2) : { x: 0, y: 0, d: 0 };
  const cx = spec.sw.auto ? centre.x : boundsMm(topSlice).cx + spec.sw.dx, cy = spec.sw.auto ? centre.y : boundsMm(topSlice).cy + spec.sw.dy;
  const minD = Math.ceil(((cavSize * Math.SQRT2) / 2 + 1) * 2);
  if (spec.model.buttonD < minD) warnings.push(`Button diameter ${spec.model.buttonD} mm is too small for the switch: use at least ${minD} mm.`);
  if (!region.length) warnings.push('The model is narrower than the button at its top. Make Button diameter smaller or pick another cut.');
  const cyl = (r: number, z0: number, z1: number) => solid([circlePath(cx, cy, r, 64)], z0, z1);
  // top of the model inside the button
  let zTop = 0;
  for (let i = 0; i < model.vertices.length; i += 3) if (Math.hypot(model.vertices[i] - cx, model.vertices[i + 1] - cy) <= R) zTop = Math.max(zTop, model.vertices[i + 2]);
  const underside = zTop - plugH, shoulder = underside - travel - 0.3;
  const cuts = switchCuts(spec, cx, cy, spec.sw.angle, shoulder);
  if (cuts.wellBottom < 1.2) warnings.push(`The model is ${mh.toFixed(0)} mm tall but this button needs about ${(zTop - cuts.wellBottom + 1.5).toFixed(0)} mm below the top for the switch. Scale the model up.`);
  const slab = solid([circlePath(cx, cy, R, 64)], underside, zTop + 1);
  let plug = csg(model, slab, 'intersection');
  plug = csg(plug, solid([rectPath(cx, cy, cavSize, cavSize, spec.sw.angle)], underside - 0.5, underside + ceilLocal), 'difference');
  const boss = meshOfShells(bossShells(spec, cx, cy, spec.sw.angle, underside + bossLocal, underside + ceilLocal, H.stub)).mesh;
  plug = merge(plug, boss);
  let base = csg(model, cyl(R + spec.fit.capClear, shoulder, zTop + 2), 'difference');
  for (const c of [cuts.well, cuts.hole, cuts.pocket]) base = csg(base, c, 'difference');
  const parts = [part('base', `${spec.name} base`, base, spec.colors.base), part('button', `${spec.name} button`, plug, spec.colors.button, { upright: true, supports: true })];
  return {
    parts, switches: [{ cx, cy, angle: spec.sw.angle, plateTop: cuts.plateTop }], heights: { ...H, plateTop: cuts.plateTop, shoulder, total: mh },
    report: { warnings: [...warnings, 'The button prints upright with a hollow underside: supports are switched on for it.'], fits: !warnings.length, size: [+mw.toFixed(1), +md.toFixed(1), +mh.toFixed(1)], baseGrams: +(meshVolume(base) * PLA).toFixed(1), buttonGrams: +(meshVolume(plug) * PLA).toFixed(1), engage: +H.engage.toFixed(1), minSize: null, triangles: (base.indices.length + plug.indices.length) / 3 },
  };
}

export { grow, union, translatePaths };
