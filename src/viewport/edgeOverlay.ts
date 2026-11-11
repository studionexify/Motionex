// Edge lines drawn over a model: creases, open borders, the outline of painted colour regions and of quad faces,
// plus the edges picked with the Edges tool. Built from the mesh topology (src/engine/topology.ts).
import * as THREE from 'three';
import { hasPolygonFaces } from '../engine/meshedit';
import { buildTopology, EDGE_BORDER, EDGE_NONMANIFOLD, EDGE_SHARP, faceGroupEdges, paintBoundaryEdges } from '../engine/topology';
import type { SceneObject } from '../state/store';

const CREASE = new THREE.Color('#14181c');
const OPEN = new THREE.Color('#ff3b30');
const FACE = new THREE.Color('#5d7a96');

function lines(positions: number[], colors: number[]): THREE.BufferGeometry | null {
  if (!positions.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return g;
}

/**
 * Feature edges of an object. Colour-region outlines take a dark shade of the painted filament colour so they
 * read against the same-coloured surface.
 */
export function featureLines(o: SceneObject, slots: string[], angle: number): THREE.BufferGeometry | null {
  const t = buildTopology(o.mesh, angle);
  const v = o.mesh.vertices;
  const paint = o.paint?.color;
  const chosen = new Map<number, THREE.Color>(); // edge -> colour, later entries win
  if (hasPolygonFaces(o.mesh)) for (const e of faceGroupEdges(t, o.mesh.faceGroups)) chosen.set(e, FACE);
  for (let e = 0; e < t.edgeCount; e++) {
    const k = t.kind[e];
    if (k === EDGE_SHARP) chosen.set(e, CREASE);
    else if (k === EDGE_BORDER || k === EDGE_NONMANIFOLD) chosen.set(e, OPEN);
  }
  for (const e of paintBoundaryEdges(t, paint)) {
    const a = paint![t.edgeTris[e * 2]] ?? 0, b = paint![t.edgeTris[e * 2 + 1]] ?? 0;
    const slot = Math.max(a, b);
    chosen.set(e, new THREE.Color(slots[Math.min(slot - 1, slots.length - 1)] ?? '#888888').multiplyScalar(0.35));
  }
  const pos: number[] = [], col: number[] = [];
  for (const [e, c] of chosen) {
    const a = t.edgeV[e * 2] * 3, b = t.edgeV[e * 2 + 1] * 3;
    pos.push(v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2]);
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  return lines(pos, col);
}

/** Line segments for a list of vertex pairs (selection / hover), in the object's local space. */
export function pairLines(o: SceneObject, edges: [number, number][], color: string): THREE.BufferGeometry | null {
  const v = o.mesh.vertices, c = new THREE.Color(color);
  const pos: number[] = [], col: number[] = [];
  for (const [a, b] of edges) {
    if (a * 3 + 2 >= v.length || b * 3 + 2 >= v.length) continue;
    pos.push(v[a * 3], v[a * 3 + 1], v[a * 3 + 2], v[b * 3], v[b * 3 + 1], v[b * 3 + 2]);
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  return lines(pos, col);
}
