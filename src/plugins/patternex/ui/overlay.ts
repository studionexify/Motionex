// Patternex in the 3D view: pattern outlines on the model while preparing, placement by click/drag,
// and region / transition / bleed / swap overlays in the preview.
import * as THREE from 'three';
import type { SceneObject } from '../../../state/store';
import { objectMatrix } from '../../../state/store';
import { frameOf, fromPattern, toPattern, type V3, type WorldPlacement } from '../projection';
import { newPlacement } from '../model';
import type { PatternexReport } from '../engine';
import { addPattern, patternInkKey, toWorldPlacements, type ObjPlacement } from './state';
import { brushPattern } from '../tools/layout';
import { inkActions } from '../library/apply';
import { printerById } from '../../../profiles/printers';
import { px, changed } from './PatternexPanel';
import { useStore } from '../../../state/store';
import { autoChanges } from '../../../profiles/changer';

const disposeGroup = (g: THREE.Group) => {
  for (const c of [...g.children]) {
    g.remove(c);
    const m = c as THREE.Mesh;
    m.geometry?.dispose();
    (m.material as THREE.Material | undefined)?.dispose?.();
  }
};

/** Max ring points drawn per placement (keeps dragging interactive for big SVGs). */
const DRAW_CAP = 20_000;

/** Outlines of every visible placement, projected onto its object (world coordinates). */
export function syncPlacementOverlay(group: THREE.Group, objects: SceneObject[]): void {
  disposeGroup(group);
  const objs = objects.map((o) => ({ id: o.id, matrix: objectMatrix(o).elements }));
  const world = toWorldPlacements(px.placements, objs);
  for (const wp of world) {
    const pat = px.patterns.find((p) => p.id === wp.pattern_id);
    if (!pat) continue;
    const f = frameOf(wp, pat);
    const lift = 0.08;
    const total = pat.shapes.reduce((n, s) => n + s.polygon_rings.reduce((a, r) => a + r.length, 0), 0);
    const step = Math.max(1, Math.ceil(total / DRAW_CAP));
    for (const s of pat.shapes) {
      const pts: number[] = [];
      for (const r of s.polygon_rings) {
        const n = r.length;
        for (let k = 0; k < n; k += step) {
          const a = r[k], b = r[Math.min(n, k + step) % n];
          for (const q of [a, b]) {
            const p = fromPattern(f, q[0], q[1]);
            // lift off the surface so the lines are not hidden in it
            const nx = f.kind === 'planar' ? f.axis : radial(f.origin, f.axis, p);
            pts.push(p[0] + nx[0] * lift, p[1] + nx[1] * lift, p[2] + nx[2] * lift);
          }
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const sel = wp.id === px.selected;
      const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: s.fill_color === '#ffffff' && !sel ? '#dddddd' : s.fill_color, transparent: true, opacity: sel ? 1 : 0.75 }));
      line.renderOrder = 5;
      group.add(line);
    }
    // handles on the selected placement: a ring to rotate (Shift + drag) and scale (Alt + drag)
    if (wp.id === px.selected && !wp.locked) {
      const [x0, y0, x1, y1] = pat.bounds;
      const r = Math.hypot(x1 - x0, y1 - y0) / 2;
      const pts: number[] = [];
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      for (let k = 0; k < 64; k++) for (const a of [k, k + 1]) {
        const t = (a / 64) * Math.PI * 2;
        const q = fromPattern(f, (pat.origin?.[0] ?? cx) + Math.cos(t) * r * 1.08, (pat.origin?.[1] ?? cy) + Math.sin(t) * r * 1.08);
        pts.push(...q);
      }
      // rotation tick along the pattern's +X
      const a = fromPattern(f, (pat.origin?.[0] ?? cx) + r * 1.08, pat.origin?.[1] ?? cy), b = fromPattern(f, (pat.origin?.[0] ?? cx) + r * 1.3, pat.origin?.[1] ?? cy);
      pts.push(...a, ...b);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const ring = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#2563EB', transparent: true, opacity: 0.7, depthTest: false }));
      ring.renderOrder = 7;
      group.add(ring);
    }
    // anchor marker
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), new THREE.MeshBasicMaterial({ color: wp.id === px.selected ? '#2563EB' : '#A1A1AA' }));
    dot.position.set(...wp.position_xyz);
    group.add(dot);
  }
}

function radial(o: V3, a: V3, p: V3): V3 {
  const d: V3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const h = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
  const r: V3 = [d[0] - a[0] * h, d[1] - a[1] * h, d[2] - a[2] * h];
  const l = Math.hypot(...r) || 1;
  return [r[0] / l, r[1] / l, r[2] / l];
}

let dragId: string | null = null;
/** Drag mode: move (snap to faces), rotate (Shift) or scale (Alt), or paint a brush stroke. */
let dragMode: 'move' | 'rotate' | 'scale' | 'paint' = 'move';
let dragStart: { angle: number; dist: number; rotation: number; scale: [number, number] } | null = null;
const keys = { shift: false, alt: false };
if (typeof window !== 'undefined') {
  const on = (e: KeyboardEvent | PointerEvent) => { keys.shift = e.shiftKey; keys.alt = e.altKey; };
  window.addEventListener('keydown', on, true); window.addEventListener('keyup', on, true); window.addEventListener('pointerdown', on, true);
}

/** Object-local frame of a placement (pattern ↔ object-local coordinates). */
const localFrame = (p: ObjPlacement) => {
  const pat = px.patterns.find((x) => x.id === p.pattern_id);
  return pat ? frameOf({ ...p, object: 0 } as WorldPlacement, pat) : null;
};
/** Angle (rad) and distance of a local point around the placement anchor, in the placement's plane. */
function polarOf(p: ObjPlacement, local: THREE.Vector3): { angle: number; dist: number } {
  const f = localFrame(p);
  if (!f) return { angle: 0, dist: 1 };
  const d: V3 = [local.x - p.position_xyz[0], local.y - p.position_xyz[1], local.z - p.position_xyz[2]];
  const a = d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2], b = d[0] * f.v[0] + d[1] * f.v[1] + d[2] * f.v[2];
  return { angle: Math.atan2(b, a), dist: Math.hypot(a, b) };
}

let strokeOf: { placement: ObjPlacement; stroke: { pts: [number, number][]; width: number; color: string } } | null = null;
/** Brush: start a stroke on the brush artwork of this face (or a new one). */
function brushDown(o: { id: string }, local: THREE.Vector3, nLocal: THREE.Vector3, faceIndex: number): boolean {
  const near = px.placements.find((p) => p.object_id === o.id && p.id === px.selected && px.patterns.find((x) => x.id === p.pattern_id)?.meta?.kind === 'brush' && p.projection === 'planar'
    && (p.anchor_normal ?? p.projection_axis).reduce((a, v, k) => a + v * nLocal.getComponent(k), 0) > 0.9);
  let pl = near;
  if (!pl) {
    const id = `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const pat = addPattern(px, brushPattern(`brush-${id}`, []));
    pl = { ...newPlacement(id, pat, `${o.id}:${faceIndex}`, local.toArray() as V3, nLocal.toArray() as V3), object_id: o.id, anchor_normal: nLocal.toArray() as V3, depth_mode: 'outer_wall' };
    px.placements.push(pl);
    const ams = autoChanges(printerById(useStore.getState().printerId).machine);
    px.actions.push(...inkActions(id, { ...pat, shapes: [{ polygon_rings: [], fill_color: px.brush.color, fill_rule: 'nonzero' }] }, { [px.brush.color]: Math.min(1, useStore.getState().filaments.length - 1) }, ams));
    px.selected = id;
  }
  const f = localFrame(pl)!;
  strokeOf = { placement: pl, stroke: { pts: [toPattern(f, local.x, local.y, local.z)], width: px.brush.width, color: px.brush.color } };
  rebuildBrush();
  return true;
}
function rebuildBrush() {
  if (!strokeOf) return;
  const p = strokeOf.placement;
  const old = px.patterns.find((x) => x.id === p.pattern_id);
  const prev = old?.meta?.kind === 'brush' ? old.meta.strokes.filter((s) => s !== strokeOf!.stroke) : [];
  addPattern(px, brushPattern(p.pattern_id, [...prev, strokeOf.stroke]));
  // a new colour group needs its region action (inked like the other strokes)
  if (!px.actions.some((a) => a.region_ref.placement_id === p.id && a.region_ref.color_group === strokeOf!.stroke.color)) {
    const ams = autoChanges(printerById(useStore.getState().printerId).machine);
    const pat = px.patterns.find((x) => x.id === p.pattern_id)!;
    px.actions.push(...inkActions(p.id, pat, { [strokeOf.stroke.color]: Math.min(1, useStore.getState().filaments.length - 1) }, ams));
  }
  changed(false);
}
/** The drag changed the placement; `dragCreated`: it was just placed (that press already recorded the undo step). */
let dragMoved = false, dragCreated = false;

/**
 * Place tool: pointer down on an object. Places the armed pattern there, or starts moving the selected
 * placement. Returns true when the event was used.
 */
export function placeDown(objectId: string, pointWorld: THREE.Vector3, normalWorld: THREE.Vector3, faceIndex: number): boolean {
  const s = useStore.getState();
  const o = s.objects.find((x) => x.id === objectId);
  if (!o) return false;
  const inv = objectMatrix(o).invert();
  const local = pointWorld.clone().applyMatrix4(inv);
  const nLocal = normalWorld.clone().transformDirection(inv).normalize();
  if (px.brush.active) { dragId = 'brush'; dragMode = 'paint'; dragMoved = false; dragCreated = false; return brushDown(o, local, nLocal, faceIndex); }
  if (px.armed) {
    const pat = px.patterns.find((p) => p.id === px.armed);
    if (!pat) return false;
    const id = `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const p: ObjPlacement = { ...newPlacement(id, pat, `${objectId}:${faceIndex}`, local.toArray() as V3, nLocal.toArray() as V3), object_id: objectId, anchor_normal: nLocal.toArray() as V3 };
    // keep the pattern a sensible size on small models: fit it inside ~60% of the object
    const size = Math.max(pat.bounds[2] - pat.bounds[0], pat.bounds[3] - pat.bounds[1]);
    const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(o.mesh.vertices, 3));
    const dims = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z].sort((a, b) => a - b);
    const objSize = dims[1] || size; // the middle dimension: a face of a box, not its thinnest side
    // generated artwork (text, codes…) keeps the size the user set
    if (!pat.meta && size > objSize * 0.8) { const k = +(objSize * 0.6 / size).toFixed(3); p.scale_xy = [k, k]; }
    px.placements.push(p);
    // patterns arrive uninked unless inks were chosen in the library; the user inks each region
    // inks picked in the library win; otherwise the inks saved for this pattern; otherwise uninked
    px.actions.push(...inkActions(id, pat, px.armedInks ?? px.savedInks[patternInkKey(pat.id)] ?? {}, autoChanges(printerById(s.printerId).machine)));
    px.armedInks = undefined;
    // finish chosen in Create: relief on every group (base material unless the group is also inked)
    if (px.armedRelief) {
      const relief = px.armedRelief;
      for (const color of new Set(pat.shapes.map((x) => x.fill_color))) {
        const a = px.actions.find((x) => x.region_ref.placement_id === id && x.region_ref.color_group === color);
        if (a) a.relief = { ...relief };
        else px.actions.push({ region_ref: { placement_id: id, color_group: color }, material: { mode: 'keep', slot_index: 0 }, purge: { mode: 'full', change_point_shift_mm: 0 }, motion: null, relief: { ...relief } });
      }
      px.armedRelief = undefined;
    }
    px.selected = id;
    px.armed = null;
    dragId = id; dragMoved = false; dragCreated = true;
    changed();
    return true;
  }
  const sel = px.placements.find((p) => p.id === px.selected);
  if (sel && !sel.locked && sel.object_id === objectId) {
    dragId = sel.id; dragCreated = false;
    if (keys.shift || keys.alt) {
      // rotate / scale about the anchor, measured in the placement's own plane
      dragMode = keys.shift ? 'rotate' : 'scale';
      const pol = polarOf(sel, local);
      dragStart = { ...pol, rotation: sel.rotation, scale: [...sel.scale_xy] as [number, number] };
      dragMoved = false;
      return true;
    }
    dragMode = 'move';
    movePlacement(sel, local, nLocal, faceIndex); dragMoved = true; return true;
  }
  // clicking another placement's object selects the nearest placement on it
  const near = px.placements.filter((p) => p.object_id === objectId).sort((a, b) => dist(a.position_xyz, local) - dist(b.position_xyz, local))[0];
  if (near) { px.selected = near.id; changed(false); return true; }
  return false;
}

const dist = (a: V3, b: THREE.Vector3) => Math.hypot(a[0] - b.x, a[1] - b.y, a[2] - b.z);

function movePlacement(p: ObjPlacement, local: THREE.Vector3, nLocal: THREE.Vector3, faceIndex: number) {
  p.position_xyz = local.toArray() as V3;
  p.anchor_face_ref = `${p.object_id}:${faceIndex}`;
  p.anchor_normal = nLocal.toArray() as V3;
  if (p.projection === 'planar') p.projection_axis = p.anchor_normal;
  changed(false);
}

/** Drag: snap the placement to the face under the cursor. */
export function placeMove(objectId: string, pointWorld: THREE.Vector3, normalWorld: THREE.Vector3, faceIndex: number): void {
  if (!dragId) return;
  const o = useStore.getState().objects.find((x) => x.id === objectId);
  if (!o) return;
  const inv = objectMatrix(o).invert();
  const local = pointWorld.clone().applyMatrix4(inv);
  if (dragMode === 'paint') {
    if (!strokeOf || strokeOf.placement.object_id !== objectId) return;
    const f = localFrame(strokeOf.placement);
    if (!f) return;
    const q = toPattern(f, local.x, local.y, local.z);
    const last = strokeOf.stroke.pts[strokeOf.stroke.pts.length - 1];
    if (Math.hypot(q[0] - last[0], q[1] - last[1]) < strokeOf.stroke.width * 0.3) return;
    strokeOf.stroke.pts.push(q);
    dragMoved = true;
    rebuildBrush();
    return;
  }
  const p = px.placements.find((x) => x.id === dragId);
  if (!p || p.object_id !== objectId) return;
  if ((dragMode === 'rotate' || dragMode === 'scale') && dragStart) {
    const pol = polarOf(p, local);
    if (dragMode === 'rotate') {
      // the pattern turns with the cursor; 5° steps with Alt held too
      let deg = dragStart.rotation + ((pol.angle - dragStart.angle) * 180) / Math.PI;
      if (keys.alt) deg = Math.round(deg / 5) * 5;
      p.rotation = +(((deg % 360) + 540) % 360 - 180).toFixed(2);
    } else {
      const k = Math.max(0.05, pol.dist / Math.max(dragStart.dist, 1e-3));
      p.scale_xy = [+(dragStart.scale[0] * k).toFixed(4), +(dragStart.scale[1] * k).toFixed(4)];
    }
    dragMoved = true;
    changed(false);
    return;
  }
  movePlacement(p, local, normalWorld.clone().transformDirection(inv).normalize(), faceIndex);
  dragMoved = true;
}

export function placeUp(): boolean {
  if (!dragId) return false;
  dragId = null;
  dragStart = null;
  if (dragMode === 'paint') { strokeOf = null; dragMode = 'move'; changed(true, true); return true; }
  dragMode = 'move';
  // one undo step per gesture: a new placement was recorded on press; a move records on release
  if (dragMoved) changed(true, !dragCreated);
  return true;
}
export const placeDragging = () => dragId !== null;

/** Preview overlays (plate coordinates; the caller positions the group at the plate origin). */
export function syncPreviewOverlay(group: THREE.Group, rep: PatternexReport | undefined, range: [number, number], layerZ: number[], slotColors: string[]): void {
  disposeGroup(group);
  if (!rep) return;
  const ov = px.overlays;
  const [lo, hi] = range;
  const lines = (pts: number[], color: string, opacity = 1) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: false }));
    l.renderOrder = 6;
    group.add(l);
  };
  if (ov.outlines) {
    // region outlines on the top visible layer only, so they read as a cross-section
    const pts: Record<string, number[]> = {};
    for (const o of rep.outlines) {
      if (o.layer !== hi) continue;
      const z = (layerZ[o.layer] ?? 0) + 0.02;
      const col = rep.regions.find((r) => r.id === o.regionId)?.color ?? '#ffffff';
      const arr = (pts[col] ??= []);
      for (const r of o.rings) for (let k = 0; k < r.length; k++) { const a = r[k], b = r[(k + 1) % r.length]; arr.push(a[0], a[1], z, b[0], b[1], z); }
    }
    for (const [col, p] of Object.entries(pts)) lines(p, col);
  }
  if (ov.bleed) {
    const pts: number[] = [];
    for (const b of rep.bleedZones) {
      if (b.layer < lo || b.layer > hi) continue;
      for (let k = 2; k < b.pts.length; k += 2) pts.push(b.pts[k - 2], b.pts[k - 1], b.z + 0.05, b.pts[k], b.pts[k + 1], b.z + 0.05);
    }
    if (pts.length) lines(pts, '#FFB020');
  }
  if (ov.transitions) {
    // a small cross at each change point (start of a bleed zone, or the first move after a change)
    const pts: number[] = [];
    for (const b of rep.bleedZones) {
      if (b.layer < lo || b.layer > hi || b.pts.length < 2) continue;
      const [x, y] = b.pts, z = b.z + 0.05, d = 0.8;
      pts.push(x - d, y, z, x + d, y, z, x, y - d, z, x, y + d, z);
    }
    if (pts.length) lines(pts, '#2563EB');
  }
  if (ov.swaps && rep.swaps.length) {
    // a ring around the print at each manual swap height, in the colour being loaded
    const xs = rep.outlines.flatMap((o) => o.rings.flat().map((p) => p[0])), ys = rep.outlines.flatMap((o) => o.rings.flat().map((p) => p[1]));
    if (xs.length) {
      const x0 = Math.min(...xs) - 3, x1 = Math.max(...xs) + 3, y0 = Math.min(...ys) - 3, y1 = Math.max(...ys) + 3;
      for (const sw of rep.swaps) {
        if (sw.layer < lo || sw.layer > hi) continue;
        const z = sw.z;
        lines([x0, y0, z, x1, y0, z, x1, y0, z, x1, y1, z, x1, y1, z, x0, y1, z, x0, y1, z, x0, y0, z], slotColors[sw.to] ?? '#ffffff', 0.9);
      }
    }
  }
}
