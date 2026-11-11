// Cut connectors: Plug (pin on the upper part, socket in the lower), Dowel
// (sockets in both parts plus a separate pin) and Snap (a split pin with a bulge that clicks into its socket).
// Geometry is built in cut-plane space: the plane is z = 0, the upper part is z > 0.
import * as THREE from 'three';
import { weld, type IndexedMesh } from '../engine/mesh';

export type ConnectorType = 'plug' | 'dowel' | 'snap';
export type ConnectorStyle = 'prism' | 'frustum';
export type ConnectorShape = 'triangle' | 'square' | 'hexagon' | 'circle';

export interface ConnectorSettings {
  type: ConnectorType;
  style: ConnectorStyle;
  shape: ConnectorShape;
  /** Width across the connector (mm). */
  size: number;
  /** Length of the pin (mm); a dowel is twice this, half in each part. */
  depth: number;
  /** Extra clearance of the socket, % of size and of depth. */
  tolSize: number;
  tolDepth: number;
  /** Snap: bulge as a share of the radius, and the slit width as a share of the size. */
  bulge: number;
  space: number;
}

export const DEFAULT_CONNECTOR: ConnectorSettings = {
  type: 'plug', style: 'prism', shape: 'circle', size: 5, depth: 5, tolSize: 0, tolDepth: 0, bulge: 0.15, space: 0.3,
};

const SEGMENTS: Record<ConnectorShape, number> = { triangle: 3, square: 4, hexagon: 6, circle: 32 };
/** Frustum connectors taper to this share of their base width. */
const FRUSTUM_TOP = 0.6;

function toIndexed(g: THREE.BufferGeometry): IndexedMesh {
  const ng = g.index ? g.toNonIndexed() : g;
  return weld(new Float32Array(ng.getAttribute('position').array as ArrayLike<number>));
}

/** A prism or frustum along +z from z0 to z1 (r0 at z0, r1 at z1), centred on (x, y). */
function prism(shape: ConnectorShape, x: number, y: number, z0: number, z1: number, r0: number, r1: number): THREE.BufferGeometry {
  const n = SEGMENTS[shape];
  // a square's flat sides along the axes
  const g = new THREE.CylinderGeometry(r1, r0, z1 - z0, n, 1, false, shape === 'square' ? Math.PI / 4 : 0);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, (z0 + z1) / 2);
  return g;
}

function merge(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = gs.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = parts.reduce((a, g) => a + g.getAttribute('position').count * 3, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const g of parts) { const a = g.getAttribute('position').array as Float32Array; out.set(a, o); o += a.length; }
  const r = new THREE.BufferGeometry();
  r.setAttribute('position', new THREE.BufferAttribute(out, 3));
  return r;
}

/** Snap pin: shaft, a bulge near the tip, a slit through the middle so the halves flex. Returns pin and slit. */
function snapPin(c: ConnectorSettings, x: number, y: number, dir: 1 | -1, grow: number) {
  const r = (c.size / 2) * grow, L = c.depth * grow;
  const rb = r * (1 + c.bulge);
  const z = (t: number) => dir * L * t;
  const lo = (a: number, b: number) => [Math.min(a, b), Math.max(a, b)] as const;
  const seg = (t0: number, t1: number, r0: number, r1: number) => {
    const [a, b] = lo(z(t0), z(t1));
    return dir > 0 ? prism(c.shape, x, y, a, b, r0, r1) : prism(c.shape, x, y, a, b, r1, r0);
  };
  const pin = merge([seg(-0.02, 0.6, r, r), seg(0.6, 0.8, r, rb), seg(0.8, 1, rb, r * 0.8)]);
  const slitW = c.size * c.space * 0.5;
  const slit = new THREE.BoxGeometry(slitW, c.size * 2, L * 0.6);
  slit.translate(x, y, z(0.7));
  return { pin, slit };
}

export interface ConnectorMeshes {
  /** Added to the upper part (plug / snap pins). */
  addUpper: IndexedMesh[];
  /** Subtracted from the upper / lower parts (sockets). */
  subUpper: IndexedMesh[];
  subLower: IndexedMesh[];
  /** Cut from the pin itself (snap slit). */
  subPin: IndexedMesh[];
  /** Separate objects (dowels), cut-plane space. */
  loose: IndexedMesh[];
}

export function connectorMeshes(points: { x: number; y: number }[], c: ConnectorSettings): ConnectorMeshes {
  const out: ConnectorMeshes = { addUpper: [], subUpper: [], subLower: [], subPin: [], loose: [] };
  const top = c.style === 'frustum' ? FRUSTUM_TOP : 1;
  const gs = 1 + c.tolSize / 100, gd = 1 + c.tolDepth / 100;
  const r = c.size / 2, eps = 0.02;
  for (const { x, y } of points) {
    if (c.type === 'plug') {
      // pin hangs from the upper part's cut face into the lower part
      out.addUpper.push(toIndexed(prism(c.shape, x, y, -c.depth, eps, r * top, r)));
      out.subLower.push(toIndexed(prism(c.shape, x, y, -c.depth * gd, eps, r * top * gs, r * gs)));
    } else if (c.type === 'dowel') {
      // dowels are always prisms (a tapered dowel could not go into both sockets)
      const h = c.depth * gd;
      out.subLower.push(toIndexed(prism(c.shape, x, y, -h, eps, r * gs, r * gs)));
      out.subUpper.push(toIndexed(prism(c.shape, x, y, -eps, h, r * gs, r * gs)));
      out.loose.push(toIndexed(prism(c.shape, x, y, -c.depth, c.depth, r, r)));
    } else {
      const { pin, slit } = snapPin(c, x, y, -1, 1);
      out.addUpper.push(toIndexed(pin));
      out.subPin.push(toIndexed(slit));
      out.subLower.push(toIndexed(snapPin(c, x, y, -1, gs).pin));
    }
  }
  return out;
}

/**
 * Tongue and groove (dovetail cut): a dovetail prism running across the whole cut, its flaps leaning
 * out at `flapsAngle` from the cut plane so the two parts slide together along the groove and cannot pull apart.
 */
export interface GrooveSettings {
  depth: number; width: number;
  /** Angle between the flaps and the cut plane (°); 90 gives a straight-sided key. */
  flapsAngle: number;
  /** Direction of the groove about the plane normal (°). */
  angle: number;
  /** Clearance of the groove: added to its depth and to each side (mm). */
  depthTol: number; widthTol: number;
}
export const DEFAULT_GROOVE: GrooveSettings = { depth: 3, width: 12, flapsAngle: 60, angle: 0, depthTol: 0.1, widthTol: 0.1 };

/** The dovetail key in cut-plane space (plane z = 0, lower part below), `length` long, grown by `grow` per side. */
export function grooveMesh(g: GrooveSettings, length: number, grow = 0, growDepth = 0): IndexedMesh {
  const d = g.depth + growDepth, out = 1 / Math.tan((Math.max(1, Math.min(90, g.flapsAngle)) * Math.PI) / 180);
  const top = g.width / 2 + grow, bot = g.width / 2 + grow + d * out;
  const eps = 0.02;
  // trapezoid in X-Z, extruded along Y
  const prof: [number, number][] = [[-bot, -d], [bot, -d], [top, eps], [-top, eps]];
  const shape = new THREE.Shape(prof.map(([x, z]) => new THREE.Vector2(x, z)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false });
  geo.translate(0, 0, -length / 2);
  // rotateX(90°) maps (x, y, z) to (x, -z, y): the profile's height becomes Z, the extrusion runs along Y
  geo.rotateX(Math.PI / 2);
  geo.rotateZ((g.angle * Math.PI) / 180);
  return toIndexed(geo);
}
