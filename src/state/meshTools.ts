// Surface edit actions on scene objects: chamfer / fillet of picked edges, smooth subdivision, smoothing.
// Each is one undo step. Per-triangle paint is carried across the edit.
import { openEdgeCount } from '../engine/mesh';
import { repairMesh, type RepairReport, type RepairResult } from '../engine/repair';
import { bevelEdges, refineMesh, remapTriArray, remeshEven, smoothMesh, subdivide, type EditResult, type EdgePair, type SmoothOptions, type SubdivOptions } from '../engine/meshedit';
import { exactify } from '../engine/exactify';
import { buildTopology, edgeChain, EDGE_SHARP } from '../engine/topology';
import { dropToBed, edgeSelHistory, useStore, worldBounds, type ObjectPaint, type SceneObject } from './store';

function remapPaint(p: ObjectPaint | undefined, src: Uint32Array): ObjectPaint | undefined {
  if (!p) return p;
  const out: ObjectPaint = {};
  for (const k of ['support', 'seam', 'color', 'motion', 'adv'] as const) if (p[k]) out[k] = remapTriArray(p[k], src);
  return out;
}

/** Swap an object's mesh for an edit result, keeping paint and keeping the object on the bed if it was on it. */
function commit(id: string, r: EditResult, label: string) {
  const s = useStore.getState();
  const before = s.objects.find((o) => o.id === id);
  if (!before) return;
  const grounded = Math.abs(worldBounds(before).min[2]) < 1e-3;
  edgeSelHistory.set(s.objects, s.edgeSel); // checkpoint() stores this very array, so Undo can restore the picked edges
  s.updateObjects((o): SceneObject => {
    const next: SceneObject = { ...o, mesh: r.mesh, openEdges: openEdgeCount(r.mesh), paint: remapPaint(o.paint, r.triSource) };
    return grounded ? dropToBed(next) : next;
  }, [id]);
  s.set({ edgeSel: null, toast: { kind: 'info', text: label } });
}

/** A crease an Edges click may pick. On CAD imports that is the boundary between two CAD faces, not the tessellation inside a curved face. */
function isFeature(o: SceneObject, t: ReturnType<typeof buildTopology>, e: number): boolean {
  if (t.kind[e] !== EDGE_SHARP) return false;
  const g = o.mesh.groupKind === 'cad' ? o.mesh.faceGroups : undefined;
  return !g || g[t.edgeTris[e * 2]] !== g[t.edgeTris[e * 2 + 1]];
}

/** All crease edges of an object, as the current edge selection. */
export function selectCreaseEdges(objectId: string) {
  const s = useStore.getState();
  const o = s.objects.find((x) => x.id === objectId);
  if (!o) return;
  const t = buildTopology(o.mesh, s.edgeAngle);
  const edges: EdgePair[] = [];
  for (let e = 0; e < t.edgeCount; e++) if (isFeature(o, t, e)) edges.push([t.edgeV[e * 2], t.edgeV[e * 2 + 1]]);
  s.set({ edgeSel: edges.length ? { objectId, edges } : null });
}

/** Chamfer (segments = 1) or fillet (segments > 1) the picked edges. Returns a message when nothing could be done. */
export function bevelSelectedEdges(size: number, segments: number): string | null {
  const s = useStore.getState();
  const sel = s.edgeSel;
  const o = sel && s.objects.find((x) => x.id === sel.objectId);
  if (!sel || !o) return 'Pick some edges first.';
  const r = bevelEdges(o.mesh, sel.edges, size, segments);
  if (!r) return 'These edges cannot be bevelled (open or non-manifold edges, or size too small).';
  const what = segments > 1 ? 'Filleted' : 'Chamfered';
  const clamp = r.size < size - 1e-6 ? ` (size reduced to ${r.size.toFixed(2)} mm to fit the surrounding faces)` : '';
  const skip = r.skipped ? `, ${r.skipped} skipped (open edges, or squeezed by tiny triangles)` : '';
  commit(o.id, r, `${what} ${r.applied} edge${r.applied === 1 ? '' : 's'}${skip}${clamp}.`);
  return null;
}

export function subdivideObject(id: string, opts: SubdivOptions): void {
  const o = useStore.getState().objects.find((x) => x.id === id);
  if (!o) return;
  const r = subdivide(o.mesh, opts);
  commit(id, r, `Smoothed body: ${(r.mesh.indices.length / 3).toLocaleString()} triangles.`);
}

export function smoothObject(id: string, opts: SmoothOptions & { paintedOnly?: boolean }): void {
  const o = useStore.getState().objects.find((x) => x.id === id);
  if (!o) return;
  const region = opts.paintedOnly ? paintedRegion(o) : undefined;
  if (opts.paintedOnly && !region) { useStore.getState().set({ toast: { kind: 'warn', text: 'Nothing is painted on this object.' } }); return; }
  commit(id, smoothMesh(o.mesh, { ...opts, region }), opts.paintedOnly ? 'Painted area smoothed.' : 'Surface smoothed.');
}

// ------------------------------------------------------------------ edge picking

/** The edge of triangle `tri` nearest to the local-space point `p`, as a topology edge id. */
export function nearestEdge(o: SceneObject, tri: number, p: [number, number, number], angle: number): number {
  const t = buildTopology(o.mesh, angle);
  const v = o.mesh.vertices;
  let best = -1, bestD = Infinity;
  for (let k = 0; k < 3; k++) {
    const e = t.triEdges[tri * 3 + k];
    const a = t.edgeV[e * 2] * 3, b = t.edgeV[e * 2 + 1] * 3;
    const ex = v[b] - v[a], ey = v[b + 1] - v[a + 1], ez = v[b + 2] - v[a + 2];
    const l2 = ex * ex + ey * ey + ez * ez || 1;
    const u = Math.max(0, Math.min(1, ((p[0] - v[a]) * ex + (p[1] - v[a + 1]) * ey + (p[2] - v[a + 2]) * ez) / l2));
    const d = Math.hypot(p[0] - (v[a] + ex * u), p[1] - (v[a + 1] + ey * u), p[2] - (v[a + 2] + ez * u));
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

/** The run of edges a click on edge `e` selects: its crease chain, or just itself when it is not a crease (or `single`). */
export function edgeRun(o: SceneObject, e: number, angle: number, single = false): EdgePair[] {
  const t = buildTopology(o.mesh, angle);
  const ids = single || !isFeature(o, t, e) ? [e] : edgeChain(o.mesh, t, e, (x) => isFeature(o, t, x));
  return ids.map((x) => [t.edgeV[x * 2], t.edgeV[x * 2 + 1]] as EdgePair);
}

/** Edge tool click: replace the selection with the run under the cursor, or with `add` toggle it in or out. */
export function pickEdge(objectId: string, tri: number, p: [number, number, number], opts: { add?: boolean; single?: boolean } = {}) {
  const s = useStore.getState();
  const o = s.objects.find((x) => x.id === objectId);
  if (!o) return;
  const run = edgeRun(o, nearestEdge(o, tri, p, s.edgeAngle), s.edgeAngle, opts.single);
  const key = (e: EdgePair) => (e[0] < e[1] ? `${e[0]}_${e[1]}` : `${e[1]}_${e[0]}`);
  const cur = s.edgeSel && s.edgeSel.objectId === objectId ? s.edgeSel.edges : [];
  if (!opts.add) { s.set({ edgeSel: { objectId, edges: run } }); return; }
  const have = new Set(cur.map(key));
  const allIn = run.every((e) => have.has(key(e)));
  const drop = new Set(run.map(key));
  const edges = allIn ? cur.filter((e) => !drop.has(key(e))) : [...cur, ...run.filter((e) => !have.has(key(e)))];
  s.set({ edgeSel: edges.length ? { objectId, edges } : null });
}

/** Split long edges so the triangles are of even size (the shape is unchanged). */
export function refineObject(id: string, maxLen: number): void {
  const o = useStore.getState().objects.find((x) => x.id === id);
  if (!o) return;
  const r = refineMesh(o.mesh, maxLen);
  if (!r.splits) { useStore.getState().set({ toast: { kind: 'info', text: `No edge is longer than ${maxLen} mm.` } }); return; }
  commit(id, r, `Refined: ${r.splits.toLocaleString()} edges split, ${(r.mesh.indices.length / 3).toLocaleString()} triangles.`);
}

/** Triangles carrying any paint (colour, support, seam) on an object, as a region flag array; undefined when nothing is painted. */
export function paintedRegion(o: SceneObject): Uint8Array | undefined {
  const tris = o.mesh.indices.length / 3;
  const out = new Uint8Array(tris);
  let any = false;
  for (const k of ['color', 'support', 'seam'] as const) {
    const a = o.paint?.[k];
    if (a) for (let t = 0; t < tris && t < a.length; t++) if (a[t]) { out[t] = 1; any = true; }
  }
  return any ? out : undefined;
}

/** Even remesh to about `target` mm triangles (splits, collapses, flips, relaxes). */
export function remeshObject(id: string, target: number, creaseDeg: number): void {
  const o = useStore.getState().objects.find((x) => x.id === id);
  if (!o) return;
  const r = remeshEven(o.mesh, target, { creaseDeg });
  commit(id, r, `Remeshed: ${(r.mesh.indices.length / 3).toLocaleString()} triangles (${r.splits} splits, ${r.collapses} collapses, ${r.flips} flips).`);
}

/** Hybrid smooth: recognise exact planes, spheres and cylinders and snap them to the true surface; smooth the rest. */
export function exactifyObject(id: string, creaseDeg: number, levels?: number): void {
  const o = useStore.getState().objects.find((x) => x.id === id);
  if (!o) return;
  const r = exactify(o.mesh, { creaseDeg, levels });
  const found = [r.cylinders && `${r.cylinders} cylinder${r.cylinders === 1 ? '' : 's'}`, r.spheres && `${r.spheres} sphere${r.spheres === 1 ? '' : 's'}`, r.planes && `${r.planes} flat face${r.planes === 1 ? '' : 's'}`].filter(Boolean).join(', ');
  const free = r.freeform ? `; ${r.freeform} freeform region${r.freeform === 1 ? '' : 's'} smoothed` : '';
  commit(id, r, `Smooth surface: ${found || 'no exact surfaces found'}${free}. ${(r.mesh.indices.length / 3).toLocaleString()} triangles.`);
}

/** "Fix model": repair the given objects (default: selection, else all) in one undo step and report what was done. */
export function repairObjects(ids?: string[]): void {
  const s = useStore.getState();
  const targets = (ids ?? (s.selected.length ? s.selected : s.objects.map((o) => o.id))).filter((id) => s.objects.some((o) => o.id === id));
  if (!targets.length) { s.set({ toast: { kind: 'info', text: 'Select a model to fix.' } }); return; }
  const results = new Map<string, RepairResult>();
  for (const id of targets) results.set(id, repairMesh(s.objects.find((o) => o.id === id)!.mesh));
  const grounded = new Set(targets.filter((id) => Math.abs(worldBounds(s.objects.find((o) => o.id === id)!).min[2]) < 1e-3));
  edgeSelHistory.set(s.objects, s.edgeSel);
  s.updateObjects((o): SceneObject => {
    const r = results.get(o.id)!;
    const next: SceneObject = { ...o, mesh: r.mesh, openEdges: r.report.openEdgesAfter, paint: remapPaint(o.paint, r.triSource) };
    return grounded.has(o.id) ? dropToBed(next) : next;
  }, targets);
  const lines = targets.map((id) => repairSummary(s.objects.find((o) => o.id === id)!.name, results.get(id)!.report));
  const bad = targets.some((id) => results.get(id)!.report.openEdgesAfter > 0);
  s.set({ edgeSel: null, toast: { kind: bad ? 'warn' : 'info', text: lines.join(' ') } });
}

/** Plain-words summary of a repair, e.g. "Fixed koi_vase: closed 3 holes (48 open edges), removed 2 bad triangles — model is watertight." */
export function repairSummary(name: string, r: RepairReport): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (r.holesFilled) parts.push(`closed ${plural(r.holesFilled, 'hole')} (${plural(r.openEdgesBefore, 'open edge')})`);
  const badTris = r.removedDegenerate + r.removedDuplicate;
  if (badTris) parts.push(`removed ${plural(badTris, 'bad triangle')}`);
  if (r.weldedVerts) parts.push(`merged ${plural(r.weldedVerts, 'duplicate vertex').replace(/vertexs$/, 'vertices')}`);
  if (r.flipped) parts.push(`flipped ${plural(r.flipped, 'inside-out triangle')}`);
  const tail = r.openEdgesAfter ? `${plural(r.openEdgesAfter, 'open edge')} could not be closed` : 'model is watertight';
  if (!parts.length) return r.openEdgesAfter ? `${name}: nothing could be fixed — ${tail}.` : `${name}: no problems found — ${tail}.`;
  return `Fixed ${name}: ${parts.join(', ')} — ${tail}.`;
}
