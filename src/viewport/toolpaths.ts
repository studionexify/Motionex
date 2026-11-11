// GPU toolpath renderer: one instanced box per extrusion move, built in the vertex shader.
import * as THREE from 'three';
import { AUX_STRIDE, MOVE_STRIDE } from '../engine/gcode';
import { FEATURE_ORDER, type FeatureType, type SliceOutput } from '../engine/types';
import type { ColorScheme } from '../state/store';

export const FEATURE_COLORS: Record<FeatureType, string> = {
  inner_wall: '#2ECC71',
  outer_wall: '#FF6B35',
  overhang_wall: '#1E56A0',
  sparse_infill: '#B8332A',
  internal_solid_infill: '#9B51E0',
  top_surface: '#EB5757',
  bottom_surface: '#8E44AD',
  bridge: '#2D9CDB',
  internal_bridge: '#56CCF2',
  gap_infill: '#FFFFFF',
  ironing: '#F2C94C',
  skirt: '#27AE60',
  brim: '#27AE60',
  support: '#219653',
  support_interface: '#0652DD',
  prime_tower: '#6FCF97',
  wave_overhang: '#00BFA5',
  travel: '#1976D2',
};

/** "Wave area" view: the plain print in light grey, the wall texture in one accent colour by its strength. */
export const WAVE_PLAIN = '#C9CDD3';
export const WAVE_ACCENT = '#0EA58F';

const RAMP = ['#1A237E', '#1E5BD6', '#00BCD4', '#4CAF50', '#FFEB3B', '#FF9800', '#F44336'].map((c) => new THREE.Color(c));
export const RAMP_CSS = 'linear-gradient(90deg,#1A237E,#1E5BD6,#00BCD4,#4CAF50,#FFEB3B,#FF9800,#F44336)';

function ramp(t: number, out: THREE.Color) {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  return out.copy(RAMP[i]).lerp(RAMP[i + 1], x - i);
}

export const BEAD_VERT = /* glsl */ `
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec2 aWH;
attribute vec4 aColor;
attribute float aIdx;
attribute vec4 aTurn;
attribute vec2 aJoin;
uniform float uMin;
uniform float uMax;
uniform float uTopStart;
varying vec3 vColor;
varying vec3 vNormal;
varying float vDim;
void main() {
  if (aIdx < uMin || aIdx > uMax || aColor.a < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 d = aEnd - aStart;
  float len = length(d.xy);
  vec3 fwd = len > 1e-6 ? vec3(d.xy / len, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 side = vec3(-fwd.y, fwd.x, 0.0);
  vec3 up = vec3(0.0, 0.0, 1.0);
  // body from start to end; the round end caps reach half a width past each end (normal.x = how far, in half widths)
  float t = position.x;
  // Where the next move carries on through a gentle bend (aJoin: before, after), the two beads meet in a mitred
  // joint instead of overlapping round end caps: the end's cross-section lies along the bend's bisector and the
  // cap is not pushed out. Overlapping caps poked out on the outside of every bend and showed as a thin light
  // line at each joint, which on a curved wall read as vertical stripes. aTurn: joining move directions.
  float joined = t < 0.5 ? aJoin.x : aJoin.y;
  vec2 joinDir = t < 0.5 ? aTurn.xy : aTurn.zw;
  vec2 sf = joined > 0.5 ? normalize(fwd.xy + joinDir) : fwd.xy;
  vec3 sside = vec3(-sf.y, sf.x, 0.0);
  float cap = joined > 0.5 ? 0.0 : 1.0;
  vec3 p = aStart + fwd * (t * len + normal.x * aWH.x * 0.5 * cap) + vec3(0.0, 0.0, d.z * t)
         + sside * (position.y * aWH.x / max(0.5, dot(sf, fwd.xy))) + up * (position.z * aWH.y);
  // at a mitred joint the end dome is folded flat into the bead's centre line, so it draws nothing and can't
  // fight the next bead's surface for the same pixels
  if (joined > 0.5 && abs(normal.x) > 1e-4) p = aStart + fwd * (t * len) + vec3(0.0, 0.0, d.z * t) + up * (-0.5 * aWH.y);
  vec3 n = fwd * normal.x + sside * normal.y + up * normal.z;
  vNormal = normalize(normalMatrix * n);
  vColor = aColor.rgb;
  vDim = 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

export const BEAD_FRAG = /* glsl */ `
varying vec3 vColor;
varying vec3 vNormal;
void main() {
  vec3 L = normalize(vec3(0.35, 0.45, 0.82));
  vec3 L2 = normalize(vec3(-0.6, -0.3, 0.4));
  float diff = max(dot(normalize(vNormal), L), 0.0) * 0.7 + max(dot(normalize(vNormal), L2), 0.0) * 0.25;
  vec3 n = normalize(vNormal);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0) * 0.18;
  gl_FragColor = vec4(vColor * (0.34 + diff) + spec, 1.0);
  #include <colorspace_fragment>
}`;

const lineVert = /* glsl */ `
attribute float aIdx;
uniform float uMin;
uniform float uMax;
varying float vHide;
void main() {
  vHide = (aIdx < uMin || aIdx > uMax) ? 1.0 : 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const lineFrag = /* glsl */ `
uniform vec3 uColor;
varying float vHide;
void main() {
  if (vHide > 0.5) discard;
  gl_FragColor = vec4(uColor, 1.0);
  #include <colorspace_fragment>
}`;

/** One extrusion bead: x ∈ [0,1] along the move, a round cross-section y ∈ [-0.5,0.5], z ∈ [-1,0] with the top
 *  of the bead at move z, and a half-dome at each end. Every normal is the true surface normal, so where the next
 *  bead starts its dome sits inside this one's dome with the same shading: the strand reads as one unbroken line
 *  (flat end caps showed a tick at every joint). normal.x doubles as the cap's reach past the end, in half widths. */
export function unitBead(segs = 12, rings = 4): THREE.BufferGeometry {
  const P: number[] = [], N: number[] = [], I: number[] = [];
  const ring: [number, number][] = []; // cos, sin
  for (let k = 0; k < segs; k++) { const t = (k / segs) * Math.PI * 2; ring.push([Math.cos(t), Math.sin(t)]); }
  for (let k = 0; k < segs; k++) {
    const [c0, s0] = ring[k], [c1, s1] = ring[(k + 1) % segs];
    const o = P.length / 3;
    P.push(0, 0.5 * c0, -0.5 + 0.5 * s0, 1, 0.5 * c0, -0.5 + 0.5 * s0, 1, 0.5 * c1, -0.5 + 0.5 * s1, 0, 0.5 * c1, -0.5 + 0.5 * s1);
    N.push(0, c0, s0, 0, c0, s0, 0, c1, s1, 0, c1, s1);
    I.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  for (const [x, dir] of [[0, -1], [1, 1]] as const) {
    const o = P.length / 3;
    // latitude rings from the body edge (φ = 0) to the tip (φ = π/2)
    for (let r = 0; r <= rings; r++) {
      const phi = (r / rings) * (Math.PI / 2), cp = Math.cos(phi), sp = Math.sin(phi);
      // the first ring sits on the body's end; its tiny forward normal marks it as part of the cap, so a mitred
      // joint folds the whole cap away (the shader folds vertices with normal.x != 0)
      for (const [c, s2] of ring) { P.push(x, 0.5 * c * cp, -0.5 + 0.5 * s2 * cp); N.push(dir * Math.max(sp, 1e-3), c * cp, s2 * cp); }
    }
    for (let r = 0; r < rings; r++) for (let k = 0; k < segs; k++) {
      const a0 = o + r * segs + k, a1 = o + r * segs + ((k + 1) % segs), b0 = a0 + segs, b1 = a1 + segs;
      if (dir > 0) I.push(a0, b0, b1, a0, b1, a1); else I.push(a0, b1, b0, a0, a1, b1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setIndex(I);
  return g;
}

export class ToolpathView {
  group = new THREE.Group();
  private extrude: THREE.Mesh | null = null;
  private travel: THREE.LineSegments | null = null;
  private extrIdx: Uint32Array = new Uint32Array(0); // move index of each instance
  private colorAttr: THREE.InstancedBufferAttribute | null = null;
  private uniforms = { uMin: { value: 0 }, uMax: { value: 0 }, uTopStart: { value: 0 } };
  private lineUniforms = { uMin: { value: 0 }, uMax: { value: 0 }, uColor: { value: new THREE.Color('#4FA3FF') } };
  nozzle: THREE.Mesh;
  result: SliceOutput | null = null;

  constructor() {
    const cone = new THREE.ConeGeometry(1.2, 4, 24);
    cone.rotateX(-Math.PI / 2);
    cone.translate(0, 0, 2);
    this.nozzle = new THREE.Mesh(cone, new THREE.MeshStandardMaterial({ color: '#2563EB', emissive: '#1E3A8A', transparent: true, opacity: 0.85 }));
    this.nozzle.visible = false;
    this.group.add(this.nozzle);
  }

  dispose() {
    for (const o of [this.extrude, this.travel]) if (o) { this.group.remove(o); o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
    this.extrude = null; this.travel = null;
  }

  setResult(r: SliceOutput | null) {
    this.dispose();
    this.result = r;
    if (!r) return;
    const m = r.moves, f = r.moveFeatures, S = MOVE_STRIDE;
    const count = f.length;
    const travelId = FEATURE_ORDER.indexOf('travel');
    let ne = 0, nt = 0;
    for (let i = 1; i < count; i++) (f[i] === travelId ? nt++ : ne++);
    const start = new Float32Array(ne * 3), end = new Float32Array(ne * 3), wh = new Float32Array(ne * 2), idx = new Float32Array(ne);
    const turn = new Float32Array(ne * 4), join = new Float32Array(ne * 2);
    const tPos = new Float32Array(nt * 6), tIdx = new Float32Array(nt * 2);
    this.extrIdx = new Uint32Array(ne);
    let e = 0, t = 0;
    for (let i = 1; i < count; i++) {
      const a = (i - 1) * S, b = i * S;
      if (f[i] === travelId) {
        tPos.set([m[a], m[a + 1], m[a + 2], m[b], m[b + 1], m[b + 2]], t * 6);
        tIdx[t * 2] = i; tIdx[t * 2 + 1] = i;
        t++;
      } else {
        start.set([m[a], m[a + 1], m[a + 2]], e * 3);
        end.set([m[b], m[b + 1], m[b + 2]], e * 3);
        wh[e * 2] = m[b + 3]; wh[e * 2 + 1] = m[b + 4];
        idx[e] = i; this.extrIdx[e] = i;
        // directions of this move and the printed moves joining it (for smooth shading through bends)
        const dir = (p0: number, p1: number): [number, number] | null => { const dx = m[p1] - m[p0], dy = m[p1 + 1] - m[p0 + 1], l = Math.hypot(dx, dy); return l > 1e-6 ? [dx / l, dy / l] : null; };
        const own = dir(a, b) ?? [1, 0];
        const COS = Math.cos((35 * Math.PI) / 180);
        // a joining move: printed, same line kind and height, and turning less than 35°
        const pick = (j: number, from: number, to: number): [number, number] | null => {
          if (j < 1 || j >= count || f[j] === travelId || f[j] !== f[i] || Math.abs(m[j * S + 2] - m[b + 2]) > 1e-3) return null;
          const d = dir(from, to);
          return d && d[0] * own[0] + d[1] * own[1] > COS ? d : null;
        };
        const before = pick(i - 1, (i - 2) * S, a), after = pick(i + 1, b, (i + 1) * S);
        turn.set([...(before ?? own), ...(after ?? own)], e * 4);
        join[e * 2] = before ? 1 : 0; join[e * 2 + 1] = after ? 1 : 0;
        e++;
      }
    }
    const base = unitBead();
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('normal', base.getAttribute('normal'));
    g.setAttribute('aStart', new THREE.InstancedBufferAttribute(start, 3));
    g.setAttribute('aEnd', new THREE.InstancedBufferAttribute(end, 3));
    g.setAttribute('aWH', new THREE.InstancedBufferAttribute(wh, 2));
    g.setAttribute('aIdx', new THREE.InstancedBufferAttribute(idx, 1));
    g.setAttribute('aTurn', new THREE.InstancedBufferAttribute(turn, 4));
    g.setAttribute('aJoin', new THREE.InstancedBufferAttribute(join, 2));
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(ne * 4), 4);
    g.setAttribute('aColor', this.colorAttr);
    g.instanceCount = ne;
    const mat = new THREE.ShaderMaterial({ vertexShader: BEAD_VERT, fragmentShader: BEAD_FRAG, uniforms: this.uniforms });
    this.extrude = new THREE.Mesh(g, mat);
    this.extrude.frustumCulled = false;
    this.group.add(this.extrude);

    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
    lg.setAttribute('aIdx', new THREE.BufferAttribute(tIdx, 1));
    this.travel = new THREE.LineSegments(lg, new THREE.ShaderMaterial({ vertexShader: lineVert, fragmentShader: lineFrag, uniforms: this.lineUniforms }));
    this.travel.frustumCulled = false;
    this.travel.visible = false;
    this.group.add(this.travel);
  }

  /** Recolour by scheme; returns legend range for continuous schemes. */
  colorize(scheme: ColorScheme, hidden: Set<string>, slotColors: string[] = []): { min: number; max: number; unit: string; log?: boolean } | null {
    const r = this.result;
    if (!r || !this.colorAttr) return null;
    const m = r.moves, f = r.moveFeatures, S = MOVE_STRIDE, aux = r.moveAux;
    const arr = this.colorAttr.array as Float32Array;
    const c = new THREE.Color();
    const feats = FEATURE_ORDER.map((k) => new THREE.Color(FEATURE_COLORS[k]));
    // layer time lookup
    let layerOf: Float32Array | null = null;
    if (scheme === 'layer_time' || scheme === 'layer_time_log') {
      layerOf = new Float32Array(f.length);
      for (const L of r.layers) for (let i = L.moveStart; i < L.moveEnd; i++) layerOf[i] = L.time;
    }
    const val = (i: number): number => {
      const b = i * S;
      switch (scheme) {
        case 'speed': return m[b + 5];
        case 'height': return m[b + 4];
        case 'width': return m[b + 3];
        case 'flow': return m[b + 5] * m[b + 3] * m[b + 4];
        case 'layer_time': return layerOf![i];
        case 'layer_time_log': return Math.log(Math.max(0.01, layerOf![i]));
        case 'fan': return aux ? aux[i * AUX_STRIDE] : 0;
        case 'temperature': return aux ? aux[i * AUX_STRIDE + 1] : 0;
        default: return 0;
      }
    };
    let min = Infinity, max = -Infinity;
    if (scheme === 'wave') return this.colorizeWave(hidden);
    if (scheme !== 'feature' && scheme !== 'filament') {
      for (const i of this.extrIdx) { const v = val(i); if (v < min) min = v; if (v > max) max = v; }
    }
    const span = max - min || 1;
    const slots = slotColors.map((c) => new THREE.Color(c));
    for (let k = 0; k < this.extrIdx.length; k++) {
      const i = this.extrIdx[k];
      const feat = FEATURE_ORDER[f[i]];
      if (scheme === 'filament') c.copy(feat === 'prime_tower' ? feats[f[i]] : slots[Math.min(m[i * S + 7], slots.length - 1)] ?? feats[f[i]]);
      else if (scheme === 'feature') c.copy(feats[f[i]]);
      else ramp((val(i) - min) / span, c);
      arr[k * 4] = c.r; arr[k * 4 + 1] = c.g; arr[k * 4 + 2] = c.b;
      arr[k * 4 + 3] = hidden.has(feat) ? 0 : 1;
    }
    this.colorAttr.needsUpdate = true;
    if (scheme === 'feature' || scheme === 'filament') return null;
    const unit = { speed: 'mm/s', height: 'mm', width: 'mm', flow: 'mm³/s', layer_time: 's', layer_time_log: 's', fan: '%', temperature: '°C' }[scheme];
    // the log scale is coloured in log space but labelled in seconds
    if (scheme === 'layer_time_log') return { min: Math.exp(min), max: Math.exp(max), unit, log: true };
    return { min, max, unit };
  }

  /** Everything light grey, the moves a wall texture changed in the accent colour (stronger = more colour). */
  private colorizeWave(hidden: Set<string>): null {
    const r = this.result!, f = r.moveFeatures, wv = r.moveWave;
    const arr = this.colorAttr!.array as Float32Array;
    const plain = new THREE.Color(WAVE_PLAIN), accent = new THREE.Color(WAVE_ACCENT), c = new THREE.Color();
    for (let k = 0; k < this.extrIdx.length; k++) {
      const i = this.extrIdx[k];
      const t = wv ? wv[i] / 255 : 0;
      c.copy(plain).lerp(accent, t > 0 ? 0.35 + 0.65 * t : 0);
      arr[k * 4] = c.r; arr[k * 4 + 1] = c.g; arr[k * 4 + 2] = c.b;
      arr[k * 4 + 3] = hidden.has(FEATURE_ORDER[f[i]]) ? 0 : 1;
    }
    this.colorAttr!.needsUpdate = true;
    return null;
  }

  setRange(lo: number, hi: number, cursor: number) {
    const r = this.result;
    if (!r || !r.layers.length) return;
    const L0 = r.layers[Math.max(0, Math.min(lo, r.layers.length - 1))];
    const L1 = r.layers[Math.max(0, Math.min(hi, r.layers.length - 1))];
    const maxIdx = cursor >= 0 ? Math.min(L1.moveEnd - 1, L1.moveStart + cursor) : L1.moveEnd - 1;
    this.uniforms.uMin.value = L0.moveStart; this.uniforms.uMax.value = maxIdx;
    this.lineUniforms.uMin.value = L0.moveStart; this.lineUniforms.uMax.value = maxIdx;
    if (cursor >= 0 && maxIdx >= 0) {
      const b = maxIdx * MOVE_STRIDE;
      this.nozzle.position.set(r.moves[b], r.moves[b + 1], r.moves[b + 2]);
      this.nozzle.visible = true;
    } else this.nozzle.visible = false;
  }

  showTravel(v: boolean) { if (this.travel) this.travel.visible = v; }
}
