// The 3D workspace (Prepare + Preview share one renderer).
import { useEffect, useRef } from 'react';
import { growFaces, triAdjacency, triNormals } from '../engine/facesets';
import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { featureLines, pairLines } from './edgeOverlay';
import { edgeRun, nearestEdge, pickEdge } from '../state/meshTools';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { flatFaces } from './flatFaces';
import { cutGrooveOverlay, cutPreview } from '../state/tools';
import type { IndexedMesh } from '../engine/mesh';
import { BRUSHES, fillTriangles, gapFill, heightRangeTriangles, meshCache } from '../engine/brush';
import { circleFeature, measure, pickFeature } from '../state/measure';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { printerById } from '../profiles/printers';
import {
  choiceColors, dropToBed, isOutOfBounds, newId, objectPlate, worldBounds, objectMatrix, plateAt, plateOrigin, trsMatrix, useStore,
  type ObjectPaint, type Vec3, type SceneObject, type ScenePart, type Tool,
} from '../state/store';
import { layOnFace, silhouette } from '../state/ops';
import { convexHull, type Pt } from '../engine/arrange';
import { machineConfig } from '../profiles/resolve';
import { allTris, assignMotion, SURFACE_COLORS, trisInScreenPolygon } from '../state/motionPaint';
import { ToolpathView } from './toolpaths';
import { ThreadMesh } from './threads';
import { clearKeepOut, currentConfig } from '../state/slicing';
import { hasThreads, linesToThreads, mergeThreads, type PluginPreview, type ThreadData } from '../plugins/threads';
import { setDrool } from '../plugins/droolState';
import { mx } from '../plugins/motionex/ui/MotionexPanel';
import { cellCentre, pickChanged, pickedOf, pickPoint } from '../plugins/motionex/sculpt/selection';
import { placeDown, placeMove, placeUp, placeDragging, syncPlacementOverlay, syncPreviewOverlay } from '../plugins/patternex/ui/overlay';
import type { PatternexReport } from '../plugins/patternex/engine';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { PLUGINS } from '../plugins/registry';
import { buildPlate, iconTexture, type PlateIcon } from './plate';
import { addPlate, arrange, deletePlate, orientPlate, updatePlate } from '../state/ops';
import { selectPlate } from '../state/objectOps';
import { openPlateSettings } from '../ui/PlateControls';
import { useAdvanced } from '../state/advanced';
import { planeHit, ringRadius, rotateAngle, tickBasis } from './rotateSnap';
import { fieldColor, ZONE_RGB } from '../ui/advanced/colors';

export type ViewName = 'iso' | 'top' | 'bottom' | 'front' | 'left' | 'right' | 'back';
export interface ViewApi {
  setView: (v: ViewName) => void;
  /** Recentre on the active plate, keeping the viewing direction. */
  fit: () => void;
  /** Turn the camera around the target: azimuth about Z and polar (radians). */
  orbit: (dAzimuth: number, dPolar: number) => void;
  emitCamera: () => void;
}
/** cameraListeners get the camera's world-to-view matrix (column-major) after each frame drawn. */
export const viewApi: { current: ViewApi | null; cameraListeners: Set<(m: ArrayLike<number>) => void> } = { current: null, cameraListeners: new Set() };

// neutral viewport background
const THEMES = {
  dark: { zenith: '#202024', nadir: '#131315' },
  light: { zenith: '#F3F4F6', nadir: '#E5E7EB' },
};

const PART_COLORS: Record<string, string> = { negative: '#FF3B30', modifier: '#FFC107', support_enforcer: '#1E88E5', support_blocker: '#E53935' };
/** Motionex weave zones: a modifier (or height band) that says "wave here" or "keep plain". */
const WAVE_ZONE_COLOR = '#14B8A6', PLAIN_ZONE_COLOR = '#94A3B8';
const zoneMode = (ov: Record<string, unknown>) => (ov.wave_mode === 'wave' || ov.wave_mode === 'plain' ? ov.wave_mode : null);
const partColor = (p: ScenePart) => { const z = p.type === 'modifier' ? zoneMode(p.overrides) : null; return z === 'wave' ? WAVE_ZONE_COLOR : z === 'plain' ? PLAIN_ZONE_COLOR : PART_COLORS[p.type]; };
const PAINT = { support: ['#1E88E5', '#E53935'], seam: ['#FFFFFF', '#E53935'], adv: ['#26A69A', '#FF7043', '#5B6770', '#FFFFFF'] };

function backgroundTexture(theme: 'dark' | 'light') {
  const t = THEMES[theme];
  const c = document.createElement('canvas');
  c.width = 16; c.height = 512;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, t.zenith); grad.addColorStop(1, t.nadir);
  g.fillStyle = grad; g.fillRect(0, 0, 16, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Brush in use for a paint layer: the chosen one if that gizmo offers it, else the circle (sphere for motion). */
function brushFor(s: { brushType: string }, layer: string) {
  const list = BRUSHES[layer as 'support'];
  return list?.includes(s.brushType as never) ? (s.brushType as (typeof list)[number]) : layer === 'motion' ? 'sphere' : 'circle';
}

/** Separating-axis test for two convex polygons. */
function convexOverlap(a: Pt[], b: Pt[]) {
  for (const poly of [a, b]) for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    const nx = y0 - y1, ny = x1 - x0;
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (const [x, y] of a) { const d = x * nx + y * ny; amin = Math.min(amin, d); amax = Math.max(amax, d); }
    for (const [x, y] of b) { const d = x * nx + y * ny; bmin = Math.min(bmin, d); bmax = Math.max(bmax, d); }
    if (amax < bmin || bmax < amin) return false;
  }
  return true;
}

function overhangMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', vertexColors: true, roughness: 0.55, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const uniforms = { uOverhang: { value: 0 }, uCos: { value: Math.cos((30 * Math.PI) / 180) }, uOOB: { value: 0 } };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWN;\nvarying vec3 vWP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWN = normalize(mat3(modelMatrix) * objectNormal);\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWN;\nvarying vec3 vWP;\nuniform float uOverhang;\nuniform float uCos;\nuniform float uOOB;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        // overhang heatmap (slope view): blue just past the support threshold angle, red facing straight down
        if (uOverhang > 0.5 && vWP.z > 0.05) { float nz = -normalize(vWN).z; if (nz > uCos) { float t = clamp((nz - uCos) / max(1.0 - uCos, 1e-3), 0.0, 1.0); diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.15, 0.45, 1.0), vec3(1.0, 0.09, 0.15), t), 0.7); } }
        if (uOOB > 0.5) { float s = step(0.5, fract((vWP.x + vWP.y + vWP.z) * 0.25)); diffuseColor.rgb = mix(vec3(1.0, 0.23, 0.19), vec3(0.45, 0.08, 0.08), s); }`);
  };
  return mat;
}

function geometryFor(mesh: SceneObject['mesh'], smoothDeg = 0): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  let flat = g.toNonIndexed();
  g.dispose();
  // smooth shading: normals blend across faces that bend less than `smoothDeg` (geometry itself is unchanged)
  if (smoothDeg > 0) flat = toCreasedNormals(flat, (smoothDeg * Math.PI) / 180);
  else flat.computeVertexNormals();
  flat.setAttribute('color', new THREE.BufferAttribute(new Float32Array(flat.getAttribute('position').count * 3), 3));
  return flat;
}

/** Per-triangle colours: base filament colour + the paint layer relevant to the current tool. */
function paintColors(geo: THREE.BufferGeometry, o: SceneObject, tool: Tool, slots: string[], showMotion = motionShown()) {
  const attr = geo.getAttribute('color') as THREE.BufferAttribute;
  const arr = attr.array as Float32Array;
  const base = new THREE.Color(slots[Math.min(o.filament ?? 0, slots.length - 1)] ?? '#5DBE7A');
  const slotC = slots.map((c) => new THREE.Color(c));
  const tris = arr.length / 9;
  const p: ObjectPaint = o.paint ?? {};
  const motion = isMotionTool(tool);
  const advTool = tool === 'paint_adv';
  const layer = tool === 'paint_support' ? p.support : tool === 'paint_seam' ? p.seam : motion ? p.motion : advTool ? p.adv : undefined;
  const layerC = (tool === 'paint_support' ? PAINT.support : motion ? SURFACE_COLORS : advTool ? PAINT.adv : PAINT.seam).map((c) => new THREE.Color(c));
  const dim = tool === 'paint_support' || tool === 'paint_seam' || motion || advTool ? 0.55 : 1;
  const motionC = SURFACE_COLORS.map((c) => new THREE.Color(c));
  const c = new THREE.Color();
  // Advanced mode: the Zone Inspector heatmap replaces the filament colours
  const heat = heatmapFor(o, tool);
  for (let t = 0; t < tris; t++) {
    const cv = p.color?.[t] ?? 0;
    if (heat) c.setRGB(heat[t * 3], heat[t * 3 + 1], heat[t * 3 + 2]).multiplyScalar(advTool ? 0.75 : 1);
    else c.copy(cv ? slotC[Math.min(cv - 1, slotC.length - 1)] ?? base : base).multiplyScalar(dim);
    const lv = layer?.[t] ?? 0;
    if (lv) c.copy(layerC[(lv - 1) % layerC.length]);
    // Picked surfaces stay coloured with any tool while a surface plugin is installed.
    else if (!motion && showMotion && p.motion?.[t]) c.copy(motionC[(p.motion[t] - 1) % motionC.length]);
    for (let k = 0; k < 3; k++) { arr[t * 9 + k * 3] = c.r; arr[t * 9 + k * 3 + 1] = c.g; arr[t * 9 + k * 3 + 2] = c.b; }
  }
  attr.needsUpdate = true;
}

/** Motion lines drawn on the model: the Prepare toggle, and always in the Motion tab. */
const showsMotion = (s: { workspace: string; liveToolpaths: boolean }) => (s.workspace === 'prepare' && s.liveToolpaths) || s.workspace === 'motion';
export const isMotionTool = (t: Tool) => t === 'paint_motion' || t === 'pick_motion' || t === 'lasso_motion' || t === 'band_motion' || t === 'object_motion';
export const isPaintTool = (t: Tool) => t === 'paint_support' || t === 'paint_seam' || t === 'paint_color' || t === 'paint_adv' || isMotionTool(t);

/** Per-triangle heatmap colours (rgb) when Advanced mode shows the Zone Inspector on this object. */
function heatmapFor(o: SceneObject, tool: Tool): Float32Array | null {
  const a = useAdvanced.getState();
  if (a.engineMode !== 'advanced' || !a.heatmap || (isPaintTool(tool) && tool !== 'paint_adv')) return null;
  const an = a.analysis[o.id];
  if (!an || an.mesh !== o.mesh) return null;
  const f = an.fields[a.field], range = an.ranges[a.field];
  if (!f || !range || f.length * 3 !== o.mesh.indices.length) return null;
  const out = new Float32Array(f.length * 3);
  for (let t = 0; t < f.length; t++) { const c = fieldColor(a.field, f[t], range); out[t * 3] = c[0]; out[t * 3 + 1] = c[1]; out[t * 3 + 2] = c[2]; }
  return out;
}

/** True when an installed plugin uses picked surfaces. */
const motionShown = () => useStore.getState().plugins.includes('motionex');

const adjCache = new WeakMap<object, { adj: Uint32Array[]; normals: Float32Array }>();

/** Screen-space silhouette outline of a selected object: an inverted hull pushed out a fixed number of pixels. */
function outlineMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uWidth: { value: 2 }, uRes: { value: new THREE.Vector2(1, 1) }, uColor: { value: new THREE.Color('#FFFFFF') } },
    vertexShader: `
      uniform float uWidth; uniform vec2 uRes;
      void main() {
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec2 n = (projectionMatrix * vec4(normalMatrix * normal, 0.0)).xy;
        float l = length(n);
        if (l > 1e-6) clip.xy += n / l * uWidth * 2.0 / uRes * clip.w;
        gl_Position = clip;
      }`,
    fragmentShader: 'uniform vec3 uColor; void main() { gl_FragColor = vec4(uColor, 1.0); }',
    side: THREE.BackSide,
  });
}
function hullGeometry(m: SceneObject['mesh']) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.vertices, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeVertexNormals();
  return g;
}

/** Selection box: short white brackets at the eight corners of the bounding box. */
function cornerBrackets(min: number[], max: number[]): number[] {
  const out: number[] = [];
  const len = [0, 1, 2].map((k) => Math.max(0.6, (max[k] - min[k]) * 0.22));
  const pad = 1.2;
  const lo = min.map((v) => v - pad), hi = max.map((v, k) => (k === 2 ? v + pad : v + pad));
  lo[2] = min[2];
  for (const cx of [0, 1]) for (const cy of [0, 1]) for (const cz of [0, 1]) {
    const c = [cx ? hi[0] : lo[0], cy ? hi[1] : lo[1], cz ? hi[2] : lo[2]];
    const dir = [cx ? -1 : 1, cy ? -1 : 1, cz ? -1 : 1];
    for (let k = 0; k < 3; k++) {
      const e = [...c];
      e[k] += dir[k] * len[k];
      out.push(...c, ...e);
    }
  }
  return out;
}

export function Viewport() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.15;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true; // zoom towards the point under the cursor
    // One set of mouse controls everywhere, painting tools included:
    // left drag rotates, middle drag pans, right drag pans, wheel zooms.
    // While a painting tool is on, a left press that lands on the model paints instead of rotating
    // (decided per press in onPressCapture below); a left press on empty space still rotates.
    const normalButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    const paintButtons = { LEFT: -1 as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    controls.mouseButtons = { ...normalButtons };

    scene.add(new THREE.HemisphereLight('#ffffff', '#52525B', 1.4));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(-150, -250, 400);
    scene.add(sun);
    const fill = new THREE.DirectionalLight('#E5E7EB', 0.5);
    fill.position.set(300, 300, 200);
    scene.add(fill);

    const plateGroup = new THREE.Group();
    scene.add(plateGroup);
    let printer = printerById(useStore.getState().printerId);
    const objGroup = new THREE.Group();
    scene.add(objGroup);
    // Advanced mode: interior volume zones of the Zone Inspector, drawn as points
    const voxelPts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 1.6, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.85, depthWrite: false }));
    voxelPts.raycast = () => {};
    voxelPts.renderOrder = 3;
    scene.add(voxelPts);
    const syncVoxels = () => {
      const a = useAdvanced.getState(), s = useStore.getState();
      const show = a.engineMode === 'advanced' && a.showVoxels && s.workspace === 'prepare';
      voxelPts.visible = show;
      if (show) {
        const pos: number[] = [], col: number[] = [];
        for (const o of s.objects) {
          const an = a.analysis[o.id];
          if (!an || an.mesh !== o.mesh) continue;
          const v = an.voxels;
          for (let i = 0; i < v.length; i += 4) { pos.push(v[i], v[i + 1], v[i + 2]); col.push(...(ZONE_RGB[v[i + 3]] ?? [1, 1, 1])); }
        }
        voxelPts.geometry.dispose();
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        voxelPts.geometry = g;
      }
      invalidate();
    };
    const meshes = new Map<string, { mesh: THREE.Mesh; src: SceneObject['mesh']; colorKey: string; hull?: THREE.Mesh; shade: number; edges?: THREE.LineSegments; edgeDeps?: unknown[]; picked?: THREE.LineSegments }>();
    const edgeMat = new THREE.LineBasicMaterial({ vertexColors: true });
    const pickMat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true });
    const hoverMat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true });
    const hoverLine = new THREE.LineSegments(new THREE.BufferGeometry(), hoverMat);
    hoverLine.renderOrder = 12; hoverLine.raycast = () => {}; hoverLine.visible = false; hoverLine.frustumCulled = false;
    let hoverKey = '';
    const outlineMat = outlineMaterial();
    let hoverId: string | null = null;
    const partMeshes = new Map<string, { mesh: THREE.Mesh; src: ScenePart['mesh'] }>();
    const selBoxes = new THREE.Group();
    scene.add(selBoxes);
    // weave wave bands (height ranges with a wave): translucent slabs round their object, not pickable
    const waveBands = new THREE.Group();
    scene.add(waveBands);
    const toolpaths = new ToolpathView();
    scene.add(toolpaths.group);
    // Patternex: placement outlines (prepare) and region/bleed/swap overlays (preview)
    const pxPrep = new THREE.Group();
    scene.add(pxPrep);
    const pxPrev = new THREE.Group();
    scene.add(pxPrev);
    const brush = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: '#2563EB', side: THREE.DoubleSide, depthTest: false, transparent: true }));
    brush.renderOrder = 10;
    brush.visible = false;
    scene.add(brush);
    // Lasso / box outline drawn over the canvas.
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.setAttribute('class', 'lasso-overlay');
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    overlay.appendChild(outline);
    el.appendChild(overlay);
    // Height band preview for the band tool.
    const bandMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: '#2563EB', transparent: true, opacity: 0.22, depthWrite: false }));
    bandMesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: '#2563EB' })));
    bandMesh.visible = false;
    bandMesh.renderOrder = 9;
    scene.add(bandMesh);

    const proxy = new THREE.Object3D();
    scene.add(proxy);
    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.setSize(0.85);
    scene.add(gizmo.getHelper());
    let dragging = false;

    let needsRender = true;
    const invalidate = () => { needsRender = true; };

    // ---------------- cut plane & measure overlays
    const cutPlaneMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: '#2563EB', transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }));
    const cutEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: '#2563EB' }));
    cutPlaneMesh.add(cutEdge);
    cutPlaneMesh.visible = false;
    scene.add(cutPlaneMesh);
    // live cut preview: the pieces above (cyan) and below (magenta) the plane; the object being cut is shown alone
    const cutPrev = new THREE.Group();
    cutPrev.matrixAutoUpdate = false;
    scene.add(cutPrev);
    const cutMats = { a: new THREE.MeshStandardMaterial({ color: '#3cc8d2', roughness: 0.6 }), b: new THREE.MeshStandardMaterial({ color: '#d43cd4', roughness: 0.6 }) };
    let cutPrevKey = '';
    let cutPrevTimer = 0;
    const cutting = () => { const s = useStore.getState(); return s.workspace === 'prepare' && s.tool === 'cut' && !!s.objects.find((x) => x.id === s.selected[0]); };
    const clearCutPrev = () => { for (const c of cutPrev.children) (c as THREE.Mesh).geometry.dispose(); cutPrev.clear(); };
    const buildCutPrev = () => {
      const s = useStore.getState();
      const o = s.objects.find((x) => x.id === s.selected[0]);
      clearCutPrev();
      const pv = o && cutting() ? cutPreview(o, s.cutPlane) : null;
      if (pv) {
        cutPrev.matrix.copy(pv.fromPlane);
        cutPrev.matrixWorldNeedsUpdate = true;
        const sw = new Set(s.cutSwap);
        const add = (m: IndexedMesh, id: string, side: 'a' | 'b') => {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(m.vertices, 3));
          g.setIndex(new THREE.BufferAttribute(m.indices, 1));
          const flat = g.toNonIndexed(); flat.computeVertexNormals(); g.dispose();
          const mesh = new THREE.Mesh(flat, cutMats[sw.has(id) ? (side === 'a' ? 'b' : 'a') : side]);
          mesh.userData.cutFrag = id;
          cutPrev.add(mesh);
        };
        pv.above.forEach((m, k) => add(m, `a${k}`, 'a'));
        pv.below.forEach((m, k) => add(m, `b${k}`, 'b'));
      }
      applyCutIsolation();
      invalidate();
    };
    /** While cutting, only the object being cut is shown (as its preview pieces when the plane crosses it). */
    const applyCutIsolation = () => {
      const s = useStore.getState();
      const on = cutting();
      cutPrev.visible = on && cutPrev.children.length > 0;
      if (!on) return;
      for (const [id, e] of meshes) e.mesh.visible = id === s.selected[0] && !cutPrev.visible && !s.objects.find((x) => x.id === id)?.hidden;
      for (const pe of partMeshes.values()) pe.mesh.visible = false;
      selBoxes.visible = false;
    };
    const syncCutPrev = () => {
      const s = useStore.getState();
      const o = s.objects.find((x) => x.id === s.selected[0]);
      const key = cutting() && o ? JSON.stringify([o.id, s.cutPlane, s.cutMode, o.position, o.rotation, o.scale]) + (o.mesh.vertices.length) : '';
      if (key !== cutPrevKey) {
        cutPrevKey = key;
        if (s.cutSwap.length) s.set({ cutSwap: [] }); // pieces are renumbered when the plane moves
        clearTimeout(cutPrevTimer);
        if (!key) { clearCutPrev(); applyCutIsolation(); return; }
        cutPrevTimer = window.setTimeout(buildCutPrev, 60);
        return;
      }
      // only the swapped pieces changed: recolour
      const sw = new Set(s.cutSwap);
      for (const c of cutPrev.children) {
        const id = c.userData.cutFrag as string, side = id[0] as 'a' | 'b';
        (c as THREE.Mesh).material = cutMats[sw.has(id) ? (side === 'a' ? 'b' : 'a') : side];
      }
      applyCutIsolation();
      invalidate();
    };
    const measureGroup = new THREE.Group();
    scene.add(measureGroup);
    // cut connectors on the plane (plane frame without the plane's display scale)
    const connGroup = new THREE.Group();
    scene.add(connGroup);
    const connMat = new THREE.MeshBasicMaterial({ color: '#1E88E5', transparent: true, opacity: 0.85, depthTest: false });
    // lay-on-face candidates of the selected objects (hull planes), highlighted under the cursor
    const faceGroup = new THREE.Group();
    scene.add(faceGroup);
    const faceMat = new THREE.MeshBasicMaterial({ color: '#9aa4ad', transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const faceHot = new THREE.MeshBasicMaterial({ color: '#10B981', transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    let faceKey = '';
    const syncFaces = () => {
      const s = useStore.getState();
      const objs = s.workspace === 'prepare' && s.tool === 'face' ? s.objects.filter((o) => s.selected.includes(o.id)) : [];
      const key = objs.map((o) => `${o.id}:${o.position}:${o.rotation}:${o.scale}:${o.mesh.vertices.length}`).join('|');
      if (key === faceKey) return;
      faceKey = key;
      for (const c of faceGroup.children) (c as THREE.Mesh).geometry.dispose();
      faceGroup.clear();
      for (const o of objs) for (const f of flatFaces(o.mesh.vertices, objectMatrix(o))) {
        const g = new THREE.BufferGeometry();
        const off = f.normal.clone().multiplyScalar(0.05);
        const v = f.tris.map((x, i) => x + off.getComponent(i % 3));
        g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
        const m = new THREE.Mesh(g, faceMat);
        m.userData = { id: o.id, normal: f.normal };
        m.renderOrder = 8;
        faceGroup.add(m);
      }
      invalidate();
    };
    let faceHover: THREE.Mesh | null = null;
    /** Edges tool: highlight the run of edges a click would pick. */
    const hoverEdge = (ev: PointerEvent) => {
      const st = useStore.getState();
      let key = '';
      if (!iconAt(ev)) {
        ray.setFromCamera(ndc(ev), camera);
        const hit = ray.intersectObjects(objectMeshes(), false)[0];
        const o = hit && st.objects.find((x) => x.id === hit.object.userData.id);
        if (hit && o && hit.faceIndex != null) {
          const p = hit.object.worldToLocal(hit.point.clone());
          const e = nearestEdge(o, hit.faceIndex, [p.x, p.y, p.z], st.edgeAngle);
          key = `${o.id}:${e}:${ev.altKey}`;
          if (key !== hoverKey) {
            const g = pairLines(o, edgeRun(o, e, st.edgeAngle, ev.altKey), '#ffd60a');
            hoverLine.geometry.dispose();
            hoverLine.geometry = g ?? new THREE.BufferGeometry();
            hit.object.add(hoverLine);
          }
        }
      }
      hoverLine.visible = !!key;
      if (key !== hoverKey) { hoverKey = key; invalidate(); }
    };
    const hoverFace = (ev: PointerEvent) => {
      let h: THREE.Mesh | null = null;
      if (faceGroup.children.length) {
        ray.setFromCamera(ndc(ev), camera);
        h = (ray.intersectObjects(faceGroup.children, false)[0]?.object as THREE.Mesh | undefined) ?? null;
      }
      if (h === faceHover) return;
      if (faceHover) faceHover.material = faceMat;
      faceHover = h;
      if (h) h.material = faceHot;
      invalidate();
    };
    const syncTools = () => {
      const s = useStore.getState();
      const o = s.objects.find((x) => x.id === s.selected[0]);
      cutPlaneMesh.visible = s.workspace === 'prepare' && s.tool === 'cut' && !!o;
      if (cutPlaneMesh.visible && o) {
        const b = worldBounds(o);
        const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 1.4 + 10;
        const d = Math.PI / 180;
        cutPlaneMesh.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, s.cutPlane.height);
        cutPlaneMesh.rotation.set(s.cutPlane.tiltX * d, s.cutPlane.tiltY * d, 0, 'XYZ');
        cutPlaneMesh.scale.set(size, size, 1);
      }
      connGroup.visible = cutPlaneMesh.visible;
      if (connGroup.visible) {
        connGroup.position.copy(cutPlaneMesh.position);
        connGroup.rotation.copy(cutPlaneMesh.rotation);
        for (const c of connGroup.children) (c as THREE.Mesh).geometry.dispose();
        connGroup.clear();
        const c = s.cutConnector;
        const seg = { triangle: 3, square: 4, hexagon: 6, circle: 32 }[c.shape];
        if (s.cutMode === 'dovetail') {
          const so = s.objects.find((x) => x.id === s.selected[0])!;
          const ob = worldBounds(so);
          const L = Math.hypot(ob.max[0] - ob.min[0], ob.max[1] - ob.min[1]) + 4;
          const key = cutGrooveOverlay(so, s.cutPlane, s.cutGroove, L);
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(key.vertices, 3));
          g.setIndex(new THREE.BufferAttribute(key.indices, 1));
          const m = new THREE.Mesh(g, connMat);
          m.renderOrder = 12;
          connGroup.add(m);
        }
        for (const p of s.cutMode === 'dovetail' ? [] : s.cutConnectors) {
          const r = c.size / 2, top = c.style === 'frustum' && c.type !== 'dowel' ? r * 0.6 : r;
          const g = new THREE.CylinderGeometry(top, r, c.type === 'dowel' ? c.depth * 2 : c.depth, seg, 1, false, c.shape === 'square' ? Math.PI / 4 : 0);
          g.rotateX(-Math.PI / 2);
          g.translate(p.x, p.y, c.type === 'dowel' ? 0 : -c.depth / 2);
          const m = new THREE.Mesh(g, connMat);
          m.renderOrder = 12;
          connGroup.add(m);
        }
      }
      measureGroup.clear();
      if (s.workspace === 'prepare' && (s.tool === 'brim_ears' || s.overrides.brim_type === 'brim_ears')) {
        const bw = Number(s.overrides.brim_width ?? 5);
        for (const o of s.objects) for (const [x, y, z] of o.brimEars ?? []) {
          const w = new THREE.Vector3(x, y, z ?? 0).applyMatrix4(objectMatrix(o));
          const ear = new THREE.Mesh(new THREE.CircleGeometry(bw, 40), new THREE.MeshBasicMaterial({ color: '#10B981', transparent: true, opacity: s.tool === 'brim_ears' ? 0.55 : 0.3, depthWrite: false }));
          ear.position.set(w.x, w.y, 0.06); ear.renderOrder = 6;
          measureGroup.add(ear);
        }
      }
      // print by object: each object's extruder clearance outline (half the clearance radius around it), red where two meet
      const byObject = (s.plates[s.activePlate]?.printSequence ?? s.overrides.print_sequence) === 'by_object';
      if (s.workspace === 'prepare' && byObject && s.objects.length) {
        const r = Number(machineConfig(s.printerId, s.machineOverrides).extruder_clearance_max_radius ?? 0) / 2;
        const zones = s.objects.filter((o) => o.printable !== false).map((o) => {
          const pts: Pt[] = [];
          for (const [x, y] of silhouette(o)) for (let k = 0; k < 16; k++) pts.push([x + r * Math.cos((k * Math.PI) / 8), y + r * Math.sin((k * Math.PI) / 8)]);
          return convexHull(pts);
        });
        zones.forEach((z, i) => {
          const hit = zones.some((w, j) => j !== i && convexOverlap(z, w));
          const g = new THREE.BufferGeometry().setFromPoints(z.map(([x, y]) => new THREE.Vector3(x, y, 0.08)));
          const line = new THREE.LineLoop(g, new THREE.LineDashedMaterial({ color: hit ? '#E53935' : '#8BC34A', dashSize: 2, gapSize: 1.2, depthTest: false }));
          line.computeLineDistances(); line.renderOrder = 7;
          measureGroup.add(line);
        });
      }
      if (s.workspace === 'prepare' && s.tool === 'text' && s.surfacePick) {
        const sp = s.surfacePick;
        const ring = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.8, 32), new THREE.MeshBasicMaterial({ color: '#10B981', depthTest: false, side: THREE.DoubleSide }));
        ring.position.set(...sp.point); ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...sp.normal)); ring.renderOrder = 11;
        const arrow = new THREE.ArrowHelper(new THREE.Vector3(...sp.normal), new THREE.Vector3(...sp.point), 6, 0x10b981, 1.5, 1);
        measureGroup.add(ring, arrow);
      }
      if (s.workspace === 'prepare' && s.tool === 'measure') {
        const dotMat = new THREE.MeshBasicMaterial({ color: '#2563EB', depthTest: false });
        const lineMat = new THREE.LineBasicMaterial({ color: '#2563EB', depthTest: false });
        const addLine = (a: Vec3, b: Vec3, mat = lineMat) => {
          const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]), mat);
          l.renderOrder = 10; measureGroup.add(l);
        };
        for (const f of s.measureFeatures) {
          if (f.kind === 'edge') { addLine(f.a, f.b, new THREE.LineBasicMaterial({ color: '#1E88E5', depthTest: false })); continue; }
          if (f.kind === 'circle') {
            const ring = new THREE.Mesh(new THREE.RingGeometry(f.r - 0.15, f.r + 0.15, 64), new THREE.MeshBasicMaterial({ color: '#1E88E5', depthTest: false, side: THREE.DoubleSide }));
            ring.position.set(...f.center); ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...f.normal)); ring.renderOrder = 10;
            const c = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), dotMat); c.position.set(...f.center); c.renderOrder = 10;
            measureGroup.add(ring, c);
            continue;
          }
          const dot = new THREE.Mesh(new THREE.SphereGeometry(f.kind === 'plane' ? 0.5 : 0.8, 16, 12), dotMat);
          dot.position.set(...f.p); dot.renderOrder = 10;
          measureGroup.add(dot);
          if (f.kind === 'plane') {
            const disc = new THREE.Mesh(new THREE.CircleGeometry(4, 32), new THREE.MeshBasicMaterial({ color: '#1E88E5', transparent: true, opacity: 0.35, depthTest: false, side: THREE.DoubleSide }));
            disc.position.set(...f.p); disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...f.n)); disc.renderOrder = 10;
            measureGroup.add(disc);
          }
        }
        if (s.measureFeatures.length === 2) {
          const r = measure(s.measureFeatures[0], s.measureFeatures[1]);
          if (r.from && r.to) addLine(r.from, r.to);
        }
      }
      invalidate();
    };
    controls.addEventListener('change', invalidate);

    /** Camera distance that shows the whole plate with a margin, the default view. */
    const fitDistance = (X: number, Y: number) => {
      const half = Math.hypot(X, Y) * 0.5 * 1.08;
      const vfov = (camera.fov * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      return half / Math.tan(Math.min(vfov, hfov) / 2);
    };
    const setView = (v: ViewName) => {
      const s = useStore.getState();
      const { x: X, y: Y, z: Z } = printer.bed;
      const [ox, oy] = plateOrigin(s.activePlate, s.printerId);
      const c = new THREE.Vector3(ox + X / 2, oy + Y / 2, 0);
      const r = fitDistance(X, Y);
      const dirs: Record<string, [number, number, number]> = {
        iso: [0, -0.85, 0.7], top: [0, -0.001, 1], bottom: [0, -0.001, -1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0],
      };
      const d = new THREE.Vector3(...dirs[v]).normalize().multiplyScalar(r);
      camera.position.copy(c).add(d);
      controls.target.copy(c).setZ(v === 'iso' ? Z * 0.06 : ['front', 'back', 'left', 'right'].includes(v) ? Z * 0.15 : 0);
      controls.update();
      invalidate();
    };
    const fit = () => {
      const s = useStore.getState();
      const { x: X, y: Y } = printer.bed;
      const [ox, oy] = plateOrigin(s.activePlate, s.printerId);
      const dir = camera.position.clone().sub(controls.target).normalize();
      controls.target.set(ox + X / 2, oy + Y / 2, 0);
      camera.position.copy(controls.target).addScaledVector(dir, fitDistance(X, Y));
      controls.update();
      invalidate();
    };
    const Z_UP = new THREE.Vector3(0, 0, 1);
    const orbit = (dAz: number, dPol: number) => {
      const off = camera.position.clone().sub(controls.target);
      off.applyAxisAngle(Z_UP, dAz);
      const polar = off.angleTo(Z_UP);
      const next = Math.min(Math.PI - 0.001, Math.max(0.001, polar + dPol));
      const axis = new THREE.Vector3().crossVectors(Z_UP, off);
      if (axis.lengthSq() < 1e-12) axis.set(1, 0, 0);
      off.applyAxisAngle(axis.normalize(), next - polar);
      camera.position.copy(controls.target).add(off);
      controls.update();
      invalidate();
    };
    const emitCamera = () => { camera.updateMatrixWorld(); for (const l of viewApi.cameraListeners) l(camera.matrixWorldInverse.elements); };
    viewApi.current = { setView, fit, orbit, emitCamera };
    (window as any).__nx = { camera, controls, invalidate, THREE, store: useStore, scene };

    let plateIcons: PlateIcon[] = [];
    const rebuildPlates = () => {
      hoverIcon = null;
      plateGroup.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.map?.dispose?.(); o.material?.dispose?.(); });
      plateGroup.clear();
      const s = useStore.getState();
      printer = printerById(s.printerId);
      plateIcons = [];
      s.plates.forEach((pl, i) => {
        const bed = pl.bedType ?? s.plate;
        const built = buildPlate(printer, bed, printer.plates.find((x) => x.type === bed)?.label ?? '', i,
          { plates: s.plates.length, locked: !!pl.locked, name: pl.name, dark: s.theme === 'dark', active: i === s.activePlate });
        plateIcons.push(...built.icons);
        const g = built.group;
        const [ox, oy] = plateOrigin(i, s.printerId);
        g.position.set(ox, oy, 0);
        plateGroup.add(g);
      });
      scene.background = backgroundTexture(s.theme);
      invalidate();
    };

    const disposeMesh = (m: THREE.Mesh) => {
      m.parent?.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose();
      for (const c of m.children) (c as THREE.Mesh).geometry?.dispose();
    };
    /** Hovered objects brighten slightly. */
    const applyHover = () => {
      const s = useStore.getState();
      for (const [id, e] of meshes) {
        const mat = e.mesh.material as THREE.MeshStandardMaterial;
        const hov = id === hoverId && s.workspace === 'prepare' && !isPaintTool(s.tool);
        mat.emissive.set(hov ? '#FFFFFF' : '#000000');
        mat.emissiveIntensity = hov ? 0.12 : 0;
      }
      invalidate();
    };

    const syncObjects = () => {
      const s = useStore.getState();
      const slots = choiceColors(s);
      const keep = new Set(s.objects.map((o) => o.id));
      for (const [id, m] of meshes) if (!keep.has(id)) { disposeMesh(m.mesh); meshes.delete(id); }
      const keepParts = new Set(s.objects.flatMap((o) => (o.parts ?? []).map((p) => p.id)));
      for (const [id, m] of partMeshes) if (!keepParts.has(id)) { disposeMesh(m.mesh); partMeshes.delete(id); }
      for (const o of s.objects) {
        let entry = meshes.get(o.id);
        const shade = s.shadeSmooth ? s.edgeAngle : 0;
        if (!entry || entry.src !== o.mesh || entry.shade !== shade) {
          if (entry) disposeMesh(entry.mesh);
          const mesh = new THREE.Mesh(geometryFor(o.mesh, shade), overhangMaterial());
          mesh.userData.id = o.id;
          entry = { mesh, src: o.mesh, colorKey: '', shade };
          meshes.set(o.id, entry);
          objGroup.add(mesh);
        }
        const adv = useAdvanced.getState();
        const colorKey = `${s.tool}|${slots.join()}|${o.filament ?? 0}|${adv.engineMode}|${adv.heatmap}|${adv.field}|${adv.analysis[o.id] ? 1 : 0}|${adv.analysisVersion}|${motionShown()}`;
        if (colorKey !== entry.colorKey || entry.mesh.userData.paint !== o.paint) {
          paintColors(entry.mesh.geometry, o, s.tool, slots);
          entry.colorKey = colorKey;
          entry.mesh.userData.paint = o.paint;
        }
        const mat = entry.mesh.material as THREE.MeshStandardMaterial;
        const sel = s.workspace === 'prepare' && s.selected.includes(o.id) && !s.selectedPart && !isPaintTool(s.tool);
        // selected: white silhouette outline
        if (sel && !entry.hull) {
          entry.hull = new THREE.Mesh(hullGeometry(o.mesh), outlineMat);
          entry.hull.raycast = () => {};
          entry.mesh.add(entry.hull);
        }
        if (entry.hull) entry.hull.visible = sel;
        // Preview: models of the plate that is sliced give way to its toolpaths; every other model (and all of them while slicing) stays as a ghost
        const inPreview = s.workspace === 'preview';
        const covered = inPreview && !!s.slice.result && s.slice.status !== 'slicing' && objectPlate(o, s.printerId, s.plates.length) === s.slice.plate;
        entry.mesh.visible = !o.hidden && !covered;
        // edge overlay: creases / open borders / colour outlines (Edges tool or the View toggle), and the picked edges
        const edgeSel = s.edgeSel && s.edgeSel.objectId === o.id ? s.edgeSel : null;
        const wantEdges = s.workspace === 'prepare' && (s.showEdges || s.tool === 'edges') && !o.hidden;
        const deps = [o.mesh, wantEdges, s.edgeAngle, o.paint?.color, slots.join(), edgeSel];
        if (!entry.edgeDeps || deps.some((d, i) => d !== entry!.edgeDeps![i])) {
          entry.edgeDeps = deps;
          for (const k of ['edges', 'picked'] as const) { const old = entry[k]; if (old) { old.parent?.remove(old); old.geometry.dispose(); entry[k] = undefined; } }
          const fg = wantEdges ? featureLines(o, slots, s.edgeAngle) : null;
          if (fg) { entry.edges = new THREE.LineSegments(fg, edgeMat); entry.edges.raycast = () => {}; entry.mesh.add(entry.edges); }
          const pg = edgeSel && s.workspace === 'prepare' ? pairLines(o, edgeSel.edges, '#ff8a00') : null;
          if (pg) { entry.picked = new THREE.LineSegments(pg, pickMat); entry.picked.renderOrder = 11; entry.picked.raycast = () => {}; entry.mesh.add(entry.picked); }
        }
        // see-through while the live toolpath is shown on it, and for objects left out of the print
        const ghost = showsMotion(s) || inPreview ? 0.45 : o.printable === false ? 0.45 : 1;
        if (mat.opacity !== ghost) { mat.transparent = ghost < 1; mat.opacity = ghost; mat.depthWrite = ghost === 1; mat.needsUpdate = true; }
        const u = mat.userData.uniforms;
        u.uOverhang.value = s.showOverhangs || s.tool === 'paint_support' ? 1 : 0;
        u.uCos.value = Math.cos(((s.tool === 'paint_support' ? s.paintOverhangAngle : Number(s.overrides.support_threshold_angle ?? 30)) * Math.PI) / 180);
        u.uOOB.value = isOutOfBounds(o, s.printerId, s.plates.length) ? 1 : 0;
        const om = objectMatrix(o);
        if (!dragging || !s.selected.includes(o.id)) {
          entry.mesh.matrixAutoUpdate = false;
          entry.mesh.matrix.copy(om);
          entry.mesh.matrixWorldNeedsUpdate = true;
        }
        for (const p of o.parts ?? []) {
          let pe = partMeshes.get(p.id);
          if (!pe || pe.src !== p.mesh) {
            if (pe) disposeMesh(pe.mesh);
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(p.mesh.vertices, 3));
            g.setIndex(new THREE.BufferAttribute(p.mesh.indices, 1));
            const flat = g.toNonIndexed(); flat.computeVertexNormals(); g.dispose();
            const m = new THREE.Mesh(flat, new THREE.MeshStandardMaterial({ color: partColor(p), transparent: true, opacity: 0.45, depthWrite: false, roughness: 0.6 }));
            m.renderOrder = 2;
            m.userData = { id: o.id, partId: p.id };
            pe = { mesh: m, src: p.mesh };
            partMeshes.set(p.id, pe);
            objGroup.add(m);
          }
          const pm = pe.mesh.material as THREE.MeshStandardMaterial;
          pm.color.set(partColor(p));
          pm.opacity = s.selectedPart === p.id ? 0.7 : 0.4;
          pe.mesh.visible = !isPaintTool(s.tool) && s.workspace === 'prepare';
          if (!dragging || !s.selected.includes(o.id)) {
            pe.mesh.matrixAutoUpdate = false;
            pe.mesh.matrix.copy(om.clone().multiply(trsMatrix(p)));
            pe.mesh.matrixWorldNeedsUpdate = true;
          }
        }
      }
      waveBands.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      waveBands.clear();
      if (s.workspace === 'prepare' && !isPaintTool(s.tool)) for (const o of s.objects) {
        if (o.hidden) continue;
        for (const r of o.heightRanges ?? []) {
          const mode = zoneMode(r.overrides);
          if (!mode) continue;
          const b = worldBounds(o), top = b.max[2] - b.min[2];
          const z0 = b.min[2] + Math.max(0, r.z0), z1 = b.min[2] + Math.min(top, r.z1);
          if (!(z1 > z0)) continue;
          const on = s.selectedRange === r.id;
          const band = new THREE.Mesh(new THREE.BoxGeometry(b.max[0] - b.min[0] + 3, b.max[1] - b.min[1] + 3, z1 - z0),
            new THREE.MeshStandardMaterial({ color: mode === 'wave' ? WAVE_ZONE_COLOR : PLAIN_ZONE_COLOR, transparent: true, opacity: on ? 0.3 : 0.16, depthWrite: false, roughness: 0.6 }));
          band.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (z0 + z1) / 2);
          band.renderOrder = 2;
          band.raycast = () => {};
          waveBands.add(band);
        }
      }
      selBoxes.traverse((o: any) => o.geometry?.dispose?.());
      selBoxes.clear();
      selBoxes.position.set(0, 0, 0);
      if (!isPaintTool(s.tool) && s.selected.length && !s.selectedPart) {
        const pts: number[] = [];
        for (const id of s.selected) {
          const o = s.objects.find((x) => x.id === id);
          if (!o) continue;
          const b = worldBounds(o);
          pts.push(...cornerBrackets(b.min, b.max));
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        selBoxes.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: s.theme === 'dark' ? '#F4F4F5' : '#2563EB' })));
      }
      applyHover();
      syncPatternex();
      if (!isPaintTool(s.tool)) brush.visible = false;
      selBoxes.visible = s.workspace === 'prepare';
      syncCutPrev();
      syncGizmo();
      invalidate();
    };

    const gizmoTarget = () => {
      const s = useStore.getState();
      const o = s.objects.find((x) => x.id === s.selected[0]);
      if (!o) return null;
      const part = s.selectedPart ? o.parts?.find((p) => p.id === s.selectedPart) : undefined;
      return { o, part };
    };

    const syncGizmo = () => {
      const s = useStore.getState();
      const t = gizmoTarget();
      // cut tool: X / Y rings tilt the cut plane (the plane itself is dragged to move it)
      const cutRings = s.tool === 'cut' && s.workspace === 'prepare' && cutPlaneMesh.visible && !s.cutConnectorMode;
      gizmo.showZ = !cutRings;
      if (cutRings) {
        if (!dragging) {
          proxy.position.copy(cutPlaneMesh.position);
          proxy.quaternion.copy(cutPlaneMesh.quaternion);
          proxy.scale.set(1, 1, 1);
          proxy.updateMatrixWorld();
        }
        gizmo.setMode('rotate');
        gizmo.setSpace('world');
        if (gizmo.object !== proxy) gizmo.attach(proxy);
        return;
      }
      const mode = s.tool === 'move' ? 'translate' : s.tool === 'rotate' ? 'rotate' : s.tool === 'scale' ? 'scale' : null;
      if (!t || !mode || s.workspace !== 'prepare') { gizmo.detach(); return; }
      if (!dragging) {
        const m = t.part ? objectMatrix(t.o).multiply(trsMatrix(t.part)) : objectMatrix(t.o);
        m.decompose(proxy.position, proxy.quaternion, proxy.scale);
        proxy.updateMatrixWorld();
      }
      gizmo.setMode(mode);
      gizmo.setSpace(mode === 'scale' ? 'local' : 'world');
      if (gizmo.object !== proxy) gizmo.attach(proxy);
    };

    // Shift while dragging a handle snaps (1 mm, 5°, 5 %); Alt on a scale handle inverts the uniform-scale toggle
    let altDown = false;
    let scaleStart = new THREE.Vector3(1, 1, 1);
    const setSnap = (on: boolean) => {
      gizmo.setTranslationSnap(on ? 1 : null);
      shiftSnap = on;
      gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(5) : null);
      gizmo.setScaleSnap(on ? 0.05 : null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setSnap(e.type === 'keydown');
      if (e.key === 'Alt') { altDown = e.type === 'keydown'; if (dragging) e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    gizmo.addEventListener('dragging-changed', (e: any) => {
      controls.enabled = !e.value;
      dragging = e.value;
      if (e.value) { scaleStart = proxy.scale.clone(); return; }
      const s = useStore.getState();
      if (s.tool === 'cut') { commitCutTilt(); return; }
      const t = gizmoTarget();
      if (!t) return;
      const D = 180 / Math.PI;
      proxy.updateMatrixWorld();
      if (t.part) {
        const local = objectMatrix(t.o).invert().multiply(proxy.matrixWorld);
        const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
        local.decompose(pos, q, sc);
        const eu = new THREE.Euler().setFromQuaternion(q, 'XYZ');
        const pid = t.part.id;
        s.updateObjects((o) => ({ ...o, parts: (o.parts ?? []).map((p) => (p.id === pid ? { ...p, position: [pos.x, pos.y, pos.z], rotation: [eu.x * D, eu.y * D, eu.z * D], scale: [sc.x, sc.y, sc.z] } : p)) }), [t.o.id]);
        return;
      }
      const eu = new THREE.Euler().setFromQuaternion(proxy.quaternion, 'XYZ');
      s.updateObjects((o) => {
        const n: SceneObject = {
          ...o,
          position: [proxy.position.x, proxy.position.y, proxy.position.z],
          rotation: [eu.x * D, eu.y * D, eu.z * D],
          scale: [proxy.scale.x, proxy.scale.y, proxy.scale.z],
        };
        return s.tool === 'move' && Math.abs(n.position[2] - o.position[2]) > 1e-6 ? n : dropToBed(n);
      }, [t.o.id]);
      // moving onto another plate makes it the active plate
      const pi = plateAt(proxy.position.x, proxy.position.y, s.printerId, s.plates.length);
      if (pi !== s.activePlate) s.set({ activePlate: pi });
      clearKeepOut([t.o.id]);
    });
    let applyRing: (() => void) | null = null; // rotate rings: replaces three's angle before the meshes follow the proxy
    /** Plane tilt from the gizmo: the tiltX / tiltY (Euler XYZ, no Z) that give the same plane normal. */
    const cutTiltOf = () => {
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(proxy.quaternion);
      const D = 180 / Math.PI, c = (v: number) => Math.max(-90, Math.min(90, +v.toFixed(1)));
      return { tiltX: c(Math.atan2(-n.y, n.z) * D), tiltY: c(Math.asin(Math.max(-1, Math.min(1, n.x))) * D) };
    };
    const commitCutTilt = () => {
      const s = useStore.getState();
      s.set({ cutPlane: { ...s.cutPlane, ...cutTiltOf() } });
    };
    gizmo.addEventListener('objectChange', () => {
      applyRing?.();
      if (useStore.getState().tool === 'cut') {
        proxy.updateMatrixWorld();
        cutPlaneMesh.quaternion.copy(proxy.quaternion);
        connGroup.quaternion.copy(proxy.quaternion);
        invalidate();
        return;
      }
      const t = gizmoTarget();
      if (!t) return;
      // uniform scale (panel toggle; Alt inverts it): every axis follows the dragged one
      if (gizmo.mode === 'scale' && useStore.getState().uniformScale !== altDown && gizmo.axis && gizmo.axis !== 'XYZ') {
        const k = 'XYZ'.indexOf(gizmo.axis[0]);
        const f = proxy.scale.getComponent(k) / (scaleStart.getComponent(k) || 1);
        proxy.scale.copy(scaleStart).multiplyScalar(f);
      }
      proxy.updateMatrixWorld();
      const e = t.part ? partMeshes.get(t.part.id) : meshes.get(t.o.id);
      if (!e) return;
      e.mesh.matrix.copy(proxy.matrixWorld);
      e.mesh.matrixWorldNeedsUpdate = true;
      if (!t.part) for (const p of t.o.parts ?? []) {
        const pe = partMeshes.get(p.id);
        if (pe) { pe.mesh.matrix.copy(proxy.matrixWorld.clone().multiply(trsMatrix(p))); pe.mesh.matrixWorldNeedsUpdate = true; }
      }
      invalidate();
    });
    gizmo.addEventListener('change', invalidate);

    // Rotate gizmo scale: 72 ticks (5°), a long tooth every 10°, 8 long marks (45°). Tick 0 sits on the point where the drag
    // began. The angle is the pointer's polar angle around the ring (three's own tangent-based angle is replaced): inside the tick
    // band it snaps to 5°, just outside it to 45°; Shift snaps to 5° anywhere. The readout follows the pointer.
    const tickGeo = (() => {
      const v: number[] = [];
      for (let i = 0; i < 72; i++) {
        const a = (i * Math.PI) / 36, c = Math.cos(a), sn = Math.sin(a);
        const r1 = i % 2 ? 1.08 : 1.14;
        v.push(c, sn, 0, c * r1, sn * r1, 0);
      }
      for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; v.push(Math.cos(a) * 1.16, Math.sin(a) * 1.16, 0, Math.cos(a) * 1.3, Math.sin(a) * 1.3, 0); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); return g;
    })();
    const ticks = new THREE.LineSegments(tickGeo, new THREE.LineBasicMaterial({ color: '#ffffff', depthTest: false, transparent: true, opacity: 0.9 }));
    ticks.renderOrder = 20; ticks.visible = false;
    scene.add(ticks);
    const readout = document.createElement('div');
    readout.style.cssText = 'position:absolute;pointer-events:none;display:none;padding:2px 6px;border-radius:3px;background:rgba(30,30,30,.9);color:#fff;font:12px/1.3 system-ui,sans-serif;z-index:5';
    el.appendChild(readout);
    let shiftSnap = false;
    const lastPtr = { x: 0, y: 0 };
    // an X / Y / Z ring in world space whose plane the camera is not looking along
    let ring: { axis: THREE.Vector3; start: THREE.Vector3; q0: THREE.Quaternion; angle: number } | null = null;
    const ringHit = () => {
      if (!ring) return null;
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((lastPtr.x - r.left) / r.width) * 2 - 1, -((lastPtr.y - r.top) / r.height) * 2 + 1), camera);
      const h = planeHit(ray.ray, proxy.position, ring.axis);
      return h ? h.sub(proxy.position) : null;
    };
    const updateRing = () => {
      if (!ring) { ticks.visible = false; readout.style.display = 'none'; return; }
      const R = ringRadius(camera, gizmo.size, proxy.position);
      ticks.position.copy(proxy.position);
      ticks.quaternion.copy(tickBasis(ring.start, ring.axis));
      ticks.scale.setScalar(R);
      ticks.visible = true;
      const deg = THREE.MathUtils.radToDeg(ring.angle);
      readout.textContent = `${'XYZ'[ring.axis.x ? 0 : ring.axis.y ? 1 : 2]}: ${deg.toFixed(2)}°`;
      readout.style.display = 'block';
      const r = renderer.domElement.getBoundingClientRect();
      readout.style.left = `${lastPtr.x - r.left + 14}px`; readout.style.top = `${lastPtr.y - r.top + 10}px`;
      invalidate();
    };
    renderer.domElement.addEventListener('pointerdown', (ev) => { lastPtr.x = ev.clientX; lastPtr.y = ev.clientY; }, { capture: true });
    renderer.domElement.addEventListener('pointermove', (ev) => { lastPtr.x = ev.clientX; lastPtr.y = ev.clientY; if (ring) updateRing(); }, { capture: true });
    gizmo.addEventListener('dragging-changed', (e: any) => {
      if (!e.value) { ring = null; updateRing(); return; }
      ring = null;
      if (gizmo.mode !== 'rotate' || !gizmo.axis || !'XYZ'.includes(gizmo.axis) || gizmo.space !== 'world') return;
      const axis = new THREE.Vector3(gizmo.axis === 'X' ? 1 : 0, gizmo.axis === 'Y' ? 1 : 0, gizmo.axis === 'Z' ? 1 : 0);
      const dragStart = { axis, start: new THREE.Vector3(), q0: proxy.quaternion.clone(), angle: 0 };
      ring = dragStart;
      const h = ringHit();
      if (!h || h.lengthSq() < 1e-12) { ring = null; return; }
      dragStart.start.copy(h);
      updateRing();
    });
    applyRing = () => {
      if (!ring) return;
      const end = ringHit();
      if (!end || end.lengthSq() < 1e-12) return; // ring seen edge-on: keep three's own result
      ring.angle = rotateAngle(ring.start, end, ring.axis, ringRadius(camera, gizmo.size, proxy.position), shiftSnap);
      proxy.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(ring.axis, ring.angle)).multiply(ring.q0).normalize();
      updateRing();
    };

    // ---------------- picking & painting
    const ray = new THREE.Raycaster();
    const ndc = (ev: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    };
    const objectMeshes = () => [...meshes.values()].map((m) => m.mesh);
    let downAt: [number, number] | null = null;
    let painting: { id: string; value: number; layer: keyof ObjectPaint; first?: boolean } | null = null;
    let drawing: { pts: [number, number][]; value: number; box: boolean } | null = null;
    let band: { id: string; z0: number; z1: number; value: number; anchor: THREE.Vector3 } | null = null;
    const showOutline = () => {
      const r = renderer.domElement.getBoundingClientRect();
      if (!drawing) { outline.setAttribute('points', ''); return; }
      let pts = drawing.pts;
      if (drawing.box && pts.length > 1) { const [a, b] = [pts[0], pts[pts.length - 1]]; pts = [a, [b[0], a[1]], b, [a[0], b[1]]]; }
      outline.setAttribute('points', pts.map(([x, y]) => `${x - r.left},${y - r.top}`).join(' '));
      outline.setAttribute('class', drawing.value ? '' : 'erase');
    };
    const showBand = () => {
      const s = useStore.getState();
      const o = band && s.objects.find((x) => x.id === band!.id);
      bandMesh.visible = !!o;
      if (o && band) {
        const b = worldBounds(o);
        const lo = Math.min(band.z0, band.z1), hi = Math.max(band.z0, band.z1, lo + 0.2);
        bandMesh.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (lo + hi) / 2);
        bandMesh.scale.set(b.max[0] - b.min[0] + 4, b.max[1] - b.min[1] + 4, hi - lo);
        (bandMesh.material as THREE.MeshBasicMaterial).color.set(band.value ? '#2563EB' : '#888888');
      }
      invalidate();
    };
    /** Height under the cursor on a vertical plane through the band's start point, facing the camera. */
    const bandHeight = (ev: PointerEvent) => {
      ray.setFromCamera(ndc(ev), camera);
      const n = new THREE.Vector3(camera.position.x - band!.anchor.x, camera.position.y - band!.anchor.y, 0);
      if (n.lengthSq() < 1e-9) n.set(0, -1, 0);
      const hitP = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), band!.anchor), new THREE.Vector3());
      return hitP ? Math.max(0, hitP.z) : band!.z1;
    };
    // per-triangle bounding spheres (centre xyz + radius) for fast brush culling
    const sphereCache = new WeakMap<object, Float32Array>();
    const spheres = (mesh: SceneObject['mesh']) => {
      let c = sphereCache.get(mesh);
      if (c) return c;
      const v = mesh.vertices, ix = mesh.indices;
      const n = ix.length / 3;
      c = new Float32Array(n * 4);
      for (let t = 0; t < n; t++) {
        let cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < 3; k++) { const i = ix[t * 3 + k] * 3; cx += v[i] / 3; cy += v[i + 1] / 3; cz += v[i + 2] / 3; }
        let r = 0;
        for (let k = 0; k < 3; k++) { const i = ix[t * 3 + k] * 3; r = Math.max(r, Math.hypot(v[i] - cx, v[i + 1] - cy, v[i + 2] - cz)); }
        c[t * 4] = cx; c[t * 4 + 1] = cy; c[t * 4 + 2] = cz; c[t * 4 + 3] = r;
      }
      sphereCache.set(mesh, c);
      return c;
    };
    const tri = new THREE.Triangle();
    const closest = new THREE.Vector3();

    const paintAt = (ev: PointerEvent) => {
      const s = useStore.getState();
      if (s.tool === 'lasso_motion' || s.tool === 'band_motion' || s.tool === 'object_motion') return;
      ray.setFromCamera(ndc(ev), camera);
      const hit = ray.intersectObjects(objectMeshes(), false)[0];
      if (!hit) { if (brush.visible) { brush.visible = false; invalidate(); } return; }
      const n = hit.face!.normal.clone().transformDirection(hit.object.matrixWorld);
      brush.position.copy(hit.point).addScaledVector(n, 0.05);
      brush.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      brush.scale.setScalar(s.brushSize / 2);
      brush.visible = true;
      invalidate();
      if (!painting) return;
      if (s.tool === 'pick_motion') return; // click-to-pick fills the whole surface on press
      const id = hit.object.userData.id as string;
      if (id !== painting.id) return;
      const o = s.objects.find((x) => x.id === id);
      const arr = o?.paint?.[painting.layer];
      if (!o || !arr) return;
      const om = objectMatrix(o);
      const local = hit.point.clone().applyMatrix4(om.clone().invert());
      const scale = (Math.abs(o.scale[0]) + Math.abs(o.scale[1]) + Math.abs(o.scale[2])) / 3;
      const rad = s.brushSize / 2 / scale;
      const r2 = rad * rad;
      const thr = Math.cos(((Number(s.overrides.support_threshold_angle ?? 30)) * Math.PI) / 180);
      const nm = new THREE.Matrix3().getNormalMatrix(om);
      const v = o.mesh.vertices, ix = o.mesh.indices;
      const A = new THREE.Vector3(), B = new THREE.Vector3(), Cc = new THREE.Vector3();
      const type = brushFor(s, painting.layer);
      // one-shot brushes act on press only
      if ((type === 'fill' || type === 'gap_fill') && !painting.first) return;
      painting.first = false;
      const cands: number[] = [];
      if (type === 'triangle') { if (hit.faceIndex != null) cands.push(hit.faceIndex); }
      else if (type === 'fill') { if (hit.faceIndex != null) cands.push(...fillTriangles(o.mesh, hit.faceIndex, s.smartFillAngle)); }
      else if (type === 'height_range') {
        const e = om.elements;
        const wz = (vi: number) => e[2] * v[vi * 3] + e[6] * v[vi * 3 + 1] + e[10] * v[vi * 3 + 2] + e[14];
        cands.push(...heightRangeTriangles(o.mesh, wz, hit.point.z - s.brushSize / 2, hit.point.z + s.brushSize / 2));
      } else if (type === 'gap_fill') {
        let changedGap = false;
        for (const g of gapFill(o.mesh, arr, s.gapArea / (scale * scale))) for (const t of g.tris) { arr[t] = g.value; changedGap = true; }
        if (changedGap) { paintColors(meshes.get(id)!.mesh.geometry, o, s.tool, choiceColors(s)); invalidate(); }
        return;
      } else {
        // circle: the part of the sphere facing the camera (the circle is projected along the view); sphere: everything inside
        const c = spheres(o.mesh);
        const eye = camera.position.clone().applyMatrix4(om.clone().invert());
        for (let t = 0; t < arr.length; t++) {
          const dx = c[t * 4] - local.x, dy = c[t * 4 + 1] - local.y, dz = c[t * 4 + 2] - local.z;
          const reach = rad + c[t * 4 + 3];
          if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
          tri.set(A.fromArray(v, ix[t * 3] * 3), B.fromArray(v, ix[t * 3 + 1] * 3), Cc.fromArray(v, ix[t * 3 + 2] * 3));
          if (tri.closestPointToPoint(local, closest).distanceToSquared(local) > r2) continue;
          if (type === 'circle') {
            const nn = B.clone().sub(A).cross(Cc.clone().sub(A));
            if (nn.dot(eye.clone().sub(A)) <= 0) continue;
          }
          cands.push(t);
        }
      }
      let changed = false;
      for (const t of cands) {
        if (s.overhangOnly && painting.layer === 'support' && painting.value === 1) {
          A.fromArray(v, ix[t * 3] * 3); B.fromArray(v, ix[t * 3 + 1] * 3); Cc.fromArray(v, ix[t * 3 + 2] * 3);
          const nn = B.sub(A).cross(Cc.sub(A)).applyMatrix3(nm).normalize();
          if (nn.z > -thr) continue;
        }
        // erasing a motion's surfaces leaves other motions' surfaces alone
        if (painting.layer === 'motion' && !painting.value && arr[t] !== s.motionSet) continue;
        if (arr[t] !== painting.value) { arr[t] = painting.value; changed = true; }
      }
      if (changed) {
        paintColors(meshes.get(id)!.mesh.geometry, o, s.tool, choiceColors(s));
        invalidate();
      }
    };

    const capture = (ev: PointerEvent) => { try { renderer.domElement.setPointerCapture(ev.pointerId); } catch { /* pointer already up */ } };
    // Path sculpt: pick cells of the unrolled wall map by dragging over the model
    let sculpting = false;
    const sculptPickAt = (ev: PointerEvent, erase: boolean) => {
      ray.setFromCamera(ndc(ev), camera);
      const hit = ray.intersectObjects(objectMeshes(), false)[0];
      if (!hit) return;
      const o = useStore.getState().objects.find((x) => x.id === hit.object.userData.id);
      if (!o) return;
      const b = worldBounds(o);
      if (pickPoint(mx.sculpt, (b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2], hit.point.x, hit.point.y, hit.point.z, erase)) pickChanged();
    };
    const onDown = (ev: PointerEvent) => {
      downAt = [ev.clientX, ev.clientY];
      // middle and right buttons always pan; only the left button paints
      if (ev.button !== 0) return;
      startPaint(ev, ev.shiftKey, ev.altKey);
    };
    /** Paint, pick or draw at the pointer. erase: take paint off · alt: the tool's second action (block / object filament). */
    const startPaint = (ev: PointerEvent, eraseIn: boolean, alt: boolean) => {
      const s = useStore.getState();
      if (s.tool === 'sculpt_pick' && s.workspace === 'prepare' && ev.button === 0) {
        sculpting = true; capture(ev);
        sculptPickAt(ev, eraseIn);
        return;
      }
      if (s.tool === 'place_pattern' && s.workspace === 'prepare' && ev.button === 0) {
        ray.setFromCamera(ndc(ev), camera);
        const hit = ray.intersectObjects(objectMeshes(), false)[0];
        if (hit?.face && hit.faceIndex != null && placeDown(hit.object.userData.id, hit.point, hit.face.normal.clone().transformDirection(hit.object.matrixWorld), hit.faceIndex)) {
          capture(ev);
        }
        return;
      }
      if (!isPaintTool(s.tool) || s.workspace !== 'prepare') return;
      const erase = eraseIn || (alt && isMotionTool(s.tool));
      if (s.tool === 'lasso_motion') {
        drawing = { pts: [[ev.clientX, ev.clientY]], value: erase ? 0 : s.motionSet, box: s.motionDraw === 'box' };
        capture(ev);
        showOutline();
        return;
      }
      ray.setFromCamera(ndc(ev), camera);
      const hit = ray.intersectObjects(objectMeshes(), false)[0];
      if (!hit) return;
      const id = hit.object.userData.id as string;
      if (s.tool === 'object_motion') {
        // click an object: the whole object; clicking it again (or right click) takes it off
        const o = s.objects.find((x) => x.id === id)!;
        const all = !!o.paint?.motion?.every((v) => v === s.motionSet);
        assignMotion(new Map([[id, allTris(o)]]), erase || all ? 0 : s.motionSet);
        return;
      }
      if (s.tool === 'band_motion') {
        band = { id, z0: hit.point.z, z1: hit.point.z, value: erase ? 0 : s.motionSet, anchor: hit.point.clone() };
        capture(ev);
        showBand();
        return;
      }
      const motion = s.tool === 'paint_motion' || s.tool === 'pick_motion';
      const layer: keyof ObjectPaint = s.tool === 'paint_support' ? 'support' : s.tool === 'paint_seam' ? 'seam' : motion ? 'motion' : s.tool === 'paint_adv' ? 'adv' : 'color';
      const value = eraseIn ? 0 : layer === 'adv' ? (alt ? 0 : useAdvanced.getState().paintValue) : layer === 'color' ? (alt ? 0 : s.paintColor) : motion ? (erase ? 0 : s.motionSet) : alt ? 2 : 1;
      // copy-on-write so undo keeps the previous paint
      s.updateObjects((o) => {
        const tris = o.mesh.indices.length / 3;
        const prev = o.paint?.[layer];
        return { ...o, paint: { ...(o.paint ?? {}), [layer]: prev ? prev.slice() : new Uint8Array(tris) } };
      }, [id]);
      painting = { id, value, layer, first: true };
      if (s.tool === 'pick_motion' && hit.faceIndex != null) {
        // click a surface: take it and every smoothly joined neighbour (a flat side, or a whole curved wall)
        const o = useStore.getState().objects.find((x) => x.id === id)!;
        let a = adjCache.get(o.mesh);
        if (!a) { a = { adj: triAdjacency(o.mesh), normals: triNormals(o.mesh) }; adjCache.set(o.mesh, a); }
        const arr = o.paint!.motion!;
        for (const t of growFaces(o.mesh, hit.faceIndex, s.motionGrowAngle, a.adj, a.normals)) if (value || arr[t] === s.motionSet) arr[t] = value;
        paintColors(meshes.get(id)!.mesh.geometry, o, s.tool, choiceColors(s));
        invalidate();
      }
      capture(ev);
      paintAt(ev);
    };
    const onMove = (ev: PointerEvent) => {
      if (sculpting) { if (ev.buttons === 1) sculptPickAt(ev, ev.shiftKey); return; }
      if (objDrag) { moveObjectDrag(ev); return; }
      if (cutDrag) { moveCutDrag(ev); return; }
      if (ev.buttons === 0 && cutPlaneMesh.visible && !useStore.getState().cutConnectorMode) {
        ray.setFromCamera(ndc(ev), camera);
        const over = ray.intersectObject(cutPlaneMesh, false).length > 0;
        renderer.domElement.style.cursor = over ? 'ns-resize' : '';
        renderer.domElement.title = over ? 'Drag to move the cut plane\nRight-click a piece to assign it to the other side' : '';
      }
      if (boxSel) { boxSel.x1 = ev.clientX; boxSel.y1 = ev.clientY; showBox(); return; }
      if (pressedIcon) return;
      {
        const st = useStore.getState();
        if (ev.buttons === 0 && st.workspace === 'prepare') {
          const icon = iconAt(ev);
          setIconHover(icon, ev);
          // hover highlight on objects
          let h: string | null = null;
          if (!icon && !isPaintTool(st.tool)) {
            ray.setFromCamera(ndc(ev), camera);
            h = (ray.intersectObjects(objectMeshes(), false)[0]?.object.userData.id as string | undefined) ?? null;
          }
          if (h !== hoverId) { hoverId = h; applyHover(); }
          if (st.tool === 'face') hoverFace(ev);
          else if (st.tool === 'edges') hoverEdge(ev);
          else if (hoverLine.visible) { hoverLine.visible = false; hoverKey = ''; invalidate(); }
        }
      }
      const s = useStore.getState();
      if (placeDragging()) {
        ray.setFromCamera(ndc(ev), camera);
        const hit = ray.intersectObjects(objectMeshes(), false)[0];
        if (hit?.face && hit.faceIndex != null) placeMove(hit.object.userData.id, hit.point, hit.face.normal.clone().transformDirection(hit.object.matrixWorld), hit.faceIndex);
        return;
      }
      if (drawing) {
        const last = drawing.pts[drawing.pts.length - 1];
        if (drawing.box) drawing.pts = [drawing.pts[0], [ev.clientX, ev.clientY]];
        else if (Math.hypot(ev.clientX - last[0], ev.clientY - last[1]) > 3) drawing.pts.push([ev.clientX, ev.clientY]);
        showOutline();
        return;
      }
      if (band) { band.z1 = bandHeight(ev); showBand(); return; }
      if (s.tool === 'lasso_motion' || s.tool === 'band_motion' || s.tool === 'object_motion') return;
      if (isPaintTool(s.tool) && s.workspace === 'prepare') paintAt(ev);
    };
    const endPaint = () => {
      if (!painting) return;
      painting = null;
      const s = useStore.getState();
      s.set({ objects: s.objects.map((o) => (o.paint ? { ...o, paint: { ...o.paint } } : o)) }); // paint arrays were mutated in place
      s.markDirty();
    };
    const onUp = (ev: PointerEvent) => {
      if (sculpting) { sculpting = false; downAt = null; return; }
      if (pressedIcon) {
        const pi = pressedIcon;
        pressedIcon = null;
        downAt = null;
        if (iconAt(ev) === pi) runIcon(pi);
        return;
      }
      if (cutDrag) { cutDrag = null; downAt = null; renderer.domElement.style.cursor = ''; return; }
      if (boxSel && finishBoxSelect(ev)) return;
      if (endObjectDrag()) return;
      if (placeUp()) { downAt = null; return; }
      if (useStore.getState().tool === 'place_pattern') { downAt = null; return; }
      if (drawing) {
        const d = drawing;
        drawing = null;
        showOutline();
        downAt = null;
        let poly = d.pts;
        if (d.box && poly.length > 1) { const [a, b] = [poly[0], poly[poly.length - 1]]; poly = [a, [b[0], a[1]], b, [a[0], b[1]]]; }
        const s = useStore.getState();
        const rect = renderer.domElement.getBoundingClientRect();
        camera.updateMatrixWorld();
        const sel = new Map<string, number[]>();
        for (const o of s.objects) sel.set(o.id, trisInScreenPolygon(o, poly, camera, rect));
        assignMotion(sel, d.value);
        return;
      }
      if (band) {
        const b = band;
        band = null;
        downAt = null;
        showBand();
        const s = useStore.getState();
        const o = s.objects.find((x) => x.id === b.id);
        const lo = Math.min(b.z0, b.z1), hi = Math.max(b.z0, b.z1);
        // A band is a height range, not a set of triangles (one triangle can span the whole height
        // of a low-poly model), so it is handed to the plugin panel to set the motion's heights.
        if (o && (hi - lo > 0.05 || !b.value)) {
          window.dispatchEvent(new CustomEvent('nx-motion-band', { detail: { id: o.id, from: lo, to: hi, erase: !b.value } }));
        }
        return;
      }
      if (painting) { endPaint(); return; }
      if (!downAt) return;
      if (ev.button === 2) {
        const s = useStore.getState();
        // painting tools: a right click (no drag) on the model takes paint off there; right drag pans
        if (isPaintTool(s.tool) && s.workspace === 'prepare') {
          const moved = Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]);
          downAt = null;
          if (moved <= 4 && s.tool !== 'lasso_motion' && s.tool !== 'band_motion') { startPaint(ev, true, false); endPaint(); }
          return;
        }
        if (s.tool === 'cut' && s.workspace === 'prepare' && Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) <= 4) {
          const f = cutFragAt(ev);
          downAt = null;
          if (f) s.set({ cutSwap: s.cutSwap.includes(f) ? s.cutSwap.filter((x) => x !== f) : [...s.cutSwap, f] });
          return;
        }
        openMenu(ev);
        return;
      }
      if (ev.button !== 0) return;
      const moved = Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]);
      downAt = null;
      if (moved > 4 || dragging) return;
      const s = useStore.getState();
      if (s.workspace !== 'prepare' || isPaintTool(s.tool)) return;
      ray.setFromCamera(ndc(ev), camera);
      if (s.tool === 'cut' && s.cutConnectorMode && cutPlaneMesh.visible) {
        const ch = ray.intersectObject(cutPlaneMesh, false)[0];
        if (ch) {
          const q = cutPlaneMesh.quaternion.clone().invert();
          const v = ch.point.clone().sub(cutPlaneMesh.position).applyQuaternion(q);
          // clicking an existing connector removes it
          const near = s.cutConnectors.findIndex((c) => Math.hypot(c.x - v.x, c.y - v.y) < s.cutConnector.size / 2);
          s.set({ cutConnectors: near >= 0 ? s.cutConnectors.filter((_, k) => k !== near) : [...s.cutConnectors, { x: +v.x.toFixed(2), y: +v.y.toFixed(2) }] });
          return;
        }
      }
      if (s.tool === 'face' && faceGroup.children.length) {
        const fh = ray.intersectObjects(faceGroup.children, false)[0];
        if (fh) { layOnFace(fh.object.userData.id, (fh.object.userData.normal as THREE.Vector3).clone()); faceKey = ''; return; }
      }
      if (s.tool === 'cut' && cutFragAt(ev)) return;
      const parts = [...partMeshes.values()].map((p) => p.mesh);
      const hit = ray.intersectObjects([...parts, ...objectMeshes()].filter((m) => m.visible), false)[0];
      if (!hit) {
        const plates = plateGroup.children.flatMap((g) => g.children.filter((c) => c.userData.plateIndex !== undefined));
        const ph = ray.intersectObjects(plates, false)[0];
        const patch: any = gizmo.dragging ? {} : { selected: [], selectedPart: null };
        if (ph) patch.activePlate = ph.object.userData.plateIndex;
        s.set(patch);
        return;
      }
      const id = hit.object.userData.id as string;
      const partId = hit.object.userData.partId as string | undefined;
      if (s.tool === 'edges' && !partId) {
        // pick the run of edges nearest the click; Shift adds / removes, Alt picks one tessellation edge
        if (hit.faceIndex != null) {
          const p = hit.object.worldToLocal(hit.point.clone());
          s.set({ selected: [id] });
          pickEdge(id, hit.faceIndex, [p.x, p.y, p.z], { add: ev.shiftKey, single: ev.altKey });
        }
        return;
      }
      if (s.tool === 'brim_ears' && !partId) {
        // click near an ear removes it, elsewhere adds one (ears sit on the first layer, so only XY matters)
        const o = s.objects.find((x) => x.id === id)!;
        const om = objectMatrix(o);
        const bw = Number(s.overrides.brim_width ?? 5);
        const ears = o.brimEars ?? [];
        const k = ears.findIndex(([x, y, z]) => { const w = new THREE.Vector3(x, y, z ?? 0).applyMatrix4(om); return Math.hypot(w.x - hit.point.x, w.y - hit.point.y) < Math.max(2, bw / 2); });
        const local = hit.point.clone().setZ(worldBounds(o).min[2]).applyMatrix4(om.clone().invert());
        const next = k >= 0 ? ears.filter((_, i) => i !== k) : [...ears, [+local.x.toFixed(3), +local.y.toFixed(3), +local.z.toFixed(3)] as [number, number, number]];
        s.updateObjects((x) => ({ ...x, brimEars: next.length ? next : undefined }), [id]);
        if (k < 0 && s.overrides.brim_type !== 'brim_ears') {
          s.setOverride('brim_type', 'brim_ears');
          s.set({ toast: { kind: 'info', text: 'Brim type set to Painted so the brim ears are used.' } });
        }
        s.markDirty();
        return;
      }
      if (s.tool === 'text' && hit.face && !partId) {
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        s.set({ selected: [id], selectedPart: null, surfacePick: { objId: id, point: [hit.point.x, hit.point.y, hit.point.z], normal: [n.x, n.y, n.z] } });
        return;
      }
      if (s.tool === 'measure' && hit.face && hit.faceIndex != null && !partId) {
        const o = s.objects.find((x) => x.id === id)!;
        const mw = hit.object.matrixWorld, ix = o.mesh.indices, v = o.mesh.vertices, t = hit.faceIndex;
        const corner = (k: number) => new THREE.Vector3().fromArray(v, ix[t * 3 + k] * 3).applyMatrix4(mw);
        const tri: [THREE.Vector3, THREE.Vector3, THREE.Vector3] = [corner(0), corner(1), corner(2)];
        const normal = hit.face.normal.clone().transformDirection(mw);
        const mc = meshCache(o.mesh);
        // an edge is sharp when the neighbour across it turns by more than 30°
        const sharp = (k: number) => {
          const a = ix[t * 3 + k], b = ix[t * 3 + ((k + 1) % 3)];
          const nb = Array.from(mc.adj[t]).find((u) => { const s3 = [ix[u * 3], ix[u * 3 + 1], ix[u * 3 + 2]]; return s3.includes(a) && s3.includes(b); });
          if (nb === undefined) return true;
          return mc.normals[t * 3] * mc.normals[nb * 3] + mc.normals[t * 3 + 1] * mc.normals[nb * 3 + 1] + mc.normals[t * 3 + 2] * mc.normals[nb * 3 + 2] < Math.cos(Math.PI / 6);
        };
        const region = fillTriangles(o.mesh, t, 1);
        let area = 0; for (const u of region) area += mc.areas[u];
        const sc = Math.abs(o.scale[0] * o.scale[1] * o.scale[2]) ** (2 / 3);
        const vert = (vi: number) => new THREE.Vector3().fromArray(v, vi * 3).applyMatrix4(mw);
        // circles: the boundary loop of the clicked flat face nearest the click, when it is round (holes, bosses)
        const circle = s.measureMode === 'circle' || s.measureMode === 'auto' ? circleFeature(id, o.mesh, region, vert, hit.point) : null;
        const nearRim = circle && Math.abs(hit.point.distanceTo(new THREE.Vector3(...circle.center)) - circle.r) < Math.max(1, circle.r * 0.15);
        const f = circle && (s.measureMode === 'circle' || nearRim) ? circle : s.measureMode === 'circle' ? null : pickFeature(id, s.measureMode, hit.point, tri, normal, sharp, area * sc > 4);
        if (!f) { s.set({ toast: { kind: 'info', text: 'No circular edge on that face. Click a flat face next to a hole or round boss.' } }); return; }
        s.set({ measureFeatures: s.measureFeatures.length >= 2 ? [f] : [...s.measureFeatures, f] });
        return;
      }
      if (s.tool === 'face' && hit.face && !partId) {
        layOnFace(id, hit.face.normal.clone().transformDirection(hit.object.matrixWorld));
        s.set({ selected: [id], selectedPart: null });
        return;
      }
      if (partId) { s.set({ selected: [id], selectedPart: partId }); return; }
      // Boolean mode: plain clicks build the operand list (first click = base), like Shift+click elsewhere
      if (s.tool === 'boolean' || ev.shiftKey || ev.ctrlKey || ev.metaKey) s.set({ selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id], selectedPart: null });
      else s.set({ selected: [id], selectedPart: null });
      const pi = plateAt(hit.point.x, hit.point.y, s.printerId, s.plates.length);
      if (pi !== s.activePlate) s.set({ activePlate: pi });
    };
    // Right click without dragging (right drag pans): menu for the object, part or plate spot under the cursor.
    const openMenu = (ev: PointerEvent) => {
      const moved = Math.hypot(ev.clientX - downAt![0], ev.clientY - downAt![1]);
      downAt = null;
      const s = useStore.getState();
      // no menu while painting or placing artwork (right button belongs to the tool there)
      if (moved > 4 || s.workspace !== 'prepare' || isPaintTool(s.tool) || s.tool === 'place_pattern') return;
      ray.setFromCamera(ndc(ev), camera);
      const parts = [...partMeshes.values()].filter((p) => p.mesh.visible).map((p) => p.mesh);
      const hit = ray.intersectObjects([...parts, ...objectMeshes()], false)[0];
      const plates = plateGroup.children.flatMap((g) => g.children.filter((c) => c.userData.plateIndex !== undefined));
      const at = { x: ev.clientX, y: ev.clientY };
      if (hit) {
        const id = hit.object.userData.id as string;
        const partId = hit.object.userData.partId as string | undefined;
        const plate = plateAt(hit.point.x, hit.point.y, s.printerId, s.plates.length);
        if (partId) { s.set({ selected: [id], selectedPart: partId, contextMenu: { ...at, kind: 'part', plate, id, partId } }); return; }
        s.set({ selected: s.selected.includes(id) ? s.selected : [id], selectedPart: null, activePlate: plate, contextMenu: { ...at, kind: 'object', plate, id } });
        return;
      }
      const ph = ray.intersectObjects(plates, false)[0];
      // Off the plate the menu still opens for the active plate.
      const plate = ph ? ph.object.userData.plateIndex as number : s.activePlate;
      const world: [number, number] | undefined = ph ? [ph.point.x, ph.point.y] : undefined;
      s.set({ selected: [], selectedPart: null, activePlate: plate, contextMenu: { ...at, kind: 'plate', plate, world } });
    };
    const onContext = (ev: Event) => ev.preventDefault();

    // ---------------- free move: left drag on an object slides it (and the rest of the selection) over the bed,
    // with no tool needed. The drag runs on the horizontal plane through the grabbed point.
    let objDrag: { ids: string[]; plane: THREE.Plane; start: THREE.Vector3; at: [number, number]; delta: THREE.Vector3; moved: boolean; base: Map<THREE.Mesh, THREE.Matrix4>; proxy: THREE.Vector3 } | null = null;
    const FREE_MOVE_TOOLS: Tool[] = ['select', 'move', 'rotate', 'scale'];
    const startObjectDrag = (ev: PointerEvent): boolean => {
      const s = useStore.getState();
      if (ev.button !== 0 || s.workspace !== 'prepare' || !FREE_MOVE_TOOLS.includes(s.tool) || ev.shiftKey || ev.ctrlKey || ev.metaKey) return false;
      if (gizmo.object && gizmo.axis) return false; // the gizmo handle under the cursor wins
      ray.setFromCamera(ndc(ev), camera);
      const parts = [...partMeshes.values()].filter((p) => p.mesh.visible).map((p) => p.mesh);
      const hit = ray.intersectObjects([...parts, ...objectMeshes()], false)[0];
      if (!hit || hit.object.userData.partId) return false;
      const id = hit.object.userData.id as string;
      let ids = s.selected.includes(id) && !s.selectedPart ? s.selected : [id];
      if (ev.altKey) {
        // Alt + drag: duplicate the selection and move the copies, leaving the originals in place
        const copies = s.objects.filter((o) => ids.includes(o.id)).map((o) => ({ ...o, id: newId() }));
        s.addObjects(copies);
        ids = copies.map((o) => o.id);
      } else if (ids !== s.selected || s.selectedPart) s.set({ selected: ids, selectedPart: null });
      const base = new Map<THREE.Mesh, THREE.Matrix4>();
      for (const oid of ids) {
        const e = meshes.get(oid);
        if (e) base.set(e.mesh, e.mesh.matrix.clone());
        const o = s.objects.find((x) => x.id === oid);
        for (const p of o?.parts ?? []) { const pe = partMeshes.get(p.id); if (pe) base.set(pe.mesh, pe.mesh.matrix.clone()); }
      }
      objDrag = {
        ids, plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -hit.point.z), start: hit.point.clone(), at: [ev.clientX, ev.clientY],
        delta: new THREE.Vector3(), moved: false, base, proxy: proxy.position.clone(),
      };
      capture(ev);
      return true;
    };
    const moveObjectDrag = (ev: PointerEvent) => {
      const d = objDrag!;
      if (!d.moved && Math.hypot(ev.clientX - d.at[0], ev.clientY - d.at[1]) <= 4) return;
      ray.setFromCamera(ndc(ev), camera);
      const p = ray.ray.intersectPlane(d.plane, new THREE.Vector3());
      if (!p) return;
      // keep a grazing view from flinging the object to the horizon
      const far = Math.max(printer.bed.x, printer.bed.y) * 2;
      d.delta.set(p.x - d.start.x, p.y - d.start.y, 0).clampLength(0, far * 4);
      if (!d.moved) { d.moved = true; dragging = true; renderer.domElement.style.cursor = 'move'; }
      const t = new THREE.Matrix4().makeTranslation(d.delta.x, d.delta.y, 0);
      for (const [m, b] of d.base) { m.matrix.multiplyMatrices(t, b); m.matrixWorldNeedsUpdate = true; m.updateMatrixWorld(); }
      selBoxes.position.set(d.delta.x, d.delta.y, 0);
      if (gizmo.object === proxy) { proxy.position.copy(d.proxy).add(d.delta); proxy.updateMatrixWorld(); }
      invalidate();
    };
    const endObjectDrag = (): boolean => {
      const d = objDrag;
      objDrag = null;
      if (!d) return false;
      renderer.domElement.style.cursor = '';
      if (!d.moved) return false; // a click: the normal selection logic runs
      dragging = false;
      downAt = null;
      const s = useStore.getState();
      const { x: dx, y: dy } = d.delta;
      if (Math.hypot(dx, dy) < 1e-6) { syncObjects(); return true; }
      s.updateObjects((o) => ({ ...o, position: [o.position[0] + dx, o.position[1] + dy, o.position[2]] }), d.ids);
      // dropping onto another plate makes it the active plate
      const pi = plateAt(d.start.x + dx, d.start.y + dy, s.printerId, s.plates.length);
      if (pi !== s.activePlate) s.set({ activePlate: pi });
      clearKeepOut(d.ids);
      return true;
    };
    // Runs before the camera controls see the press: a left press with a painting or placing tool that
    // lands on the model (or anywhere, for the lasso) paints or places; elsewhere the left button rotates.
    // ---------------- Shift + drag: box selection. Left to right selects objects entirely inside the box (window);
    // right to left selects anything the box touches (crossing).
    let boxSel: { x0: number; y0: number; x1: number; y1: number } | null = null;
    const startBoxSelect = (ev: PointerEvent): boolean => {
      const s = useStore.getState();
      if (ev.button !== 0 || !ev.shiftKey || s.workspace !== 'prepare' || !FREE_MOVE_TOOLS.includes(s.tool)) return false;
      if (gizmo.object && gizmo.axis) return false;
      boxSel = { x0: ev.clientX, y0: ev.clientY, x1: ev.clientX, y1: ev.clientY };
      capture(ev);
      return true;
    };
    const showBox = () => {
      const r = renderer.domElement.getBoundingClientRect();
      if (!boxSel || Math.hypot(boxSel.x1 - boxSel.x0, boxSel.y1 - boxSel.y0) < 4) { outline.setAttribute('points', ''); return; }
      const { x0, y0, x1, y1 } = boxSel;
      outline.setAttribute('points', [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => `${x - r.left},${y - r.top}`).join(' '));
      outline.setAttribute('class', x1 < x0 ? 'box-cross' : 'box-window');
    };
    const finishBoxSelect = (ev: PointerEvent): boolean => {
      const b = boxSel!;
      boxSel = null;
      showBox();
      if (Math.hypot(b.x1 - b.x0, b.y1 - b.y0) < 4) return false; // a Shift+click: normal toggle selection
      downAt = null;
      const s = useStore.getState();
      const r = renderer.domElement.getBoundingClientRect();
      const xa = Math.min(b.x0, b.x1), xb = Math.max(b.x0, b.x1), ya = Math.min(b.y0, b.y1), yb = Math.max(b.y0, b.y1);
      const crossing = b.x1 < b.x0;
      camera.updateMatrixWorld();
      const v = new THREE.Vector3();
      const picked: string[] = [];
      for (const o of s.objects) {
        const m = objectMatrix(o);
        const vs = o.mesh.vertices;
        const n = vs.length / 3, step = Math.max(1, Math.floor(n / 60000));
        let inside = 0, total = 0;
        for (let i = 0; i < n; i += step) {
          v.set(vs[i * 3], vs[i * 3 + 1], vs[i * 3 + 2]).applyMatrix4(m).project(camera);
          total++;
          const sx = r.left + (v.x + 1) / 2 * r.width, sy = r.top + (1 - v.y) / 2 * r.height;
          if (v.z <= 1 && sx >= xa && sx <= xb && sy >= ya && sy <= yb) inside++;
        }
        let hit = crossing ? inside > 0 : inside === total && total > 0;
        if (crossing && !hit) {
          // the box can sit inside the object's outline without containing a vertex
          const e = meshes.get(o.id);
          for (const [px, py] of [[xa, ya], [xb, ya], [xa, yb], [xb, yb], [(xa + xb) / 2, (ya + yb) / 2]]) {
            ray.setFromCamera(new THREE.Vector2(((px - r.left) / r.width) * 2 - 1, -((py - r.top) / r.height) * 2 + 1), camera);
            if (e && ray.intersectObject(e.mesh, false).length) { hit = true; break; }
          }
        }
        if (hit) picked.push(o.id);
      }
      const add = ev.ctrlKey || ev.metaKey;
      s.set({ selected: add ? [...new Set([...s.selected, ...picked])] : picked, selectedPart: null });
      return true;
    };

    // ---------------- plate icons (remove, orient, arrange, lock, settings, number, name) drawn on the bed plane
    let hoverIcon: PlateIcon | null = null;
    let pressedIcon: PlateIcon | null = null;
    const tip = document.createElement('div');
    tip.className = 'instant-tip';
    tip.style.display = 'none';
    document.body.appendChild(tip);
    const iconAt = (ev: PointerEvent): PlateIcon | null => {
      ray.setFromCamera(ndc(ev), camera);
      const hit = ray.intersectObjects(plateIcons.map((i) => i.mesh), false)[0];
      return (hit?.object.userData.plateIcon as PlateIcon | undefined) ?? null;
    };
    const setIconHover = (icon: PlateIcon | null, ev?: PointerEvent) => {
      if (icon !== hoverIcon) {
        const swap = (pi: PlateIcon, hover: boolean) => {
          if (!pi.icon || !pi.enabled) return;
          const mat = pi.mesh.material as THREE.MeshBasicMaterial;
          const key = hover ? 'hoverTex' : 'baseTex';
          if (!pi.mesh.userData.baseTex) pi.mesh.userData.baseTex = mat.map;
          if (!pi.mesh.userData.hoverTex) pi.mesh.userData.hoverTex = iconTexture(pi.icon, 'hover', useStore.getState().theme === 'dark');
          mat.map = pi.mesh.userData[key];
          mat.needsUpdate = true;
        };
        if (hoverIcon) swap(hoverIcon, false);
        if (icon) swap(icon, true);
        hoverIcon = icon;
        renderer.domElement.style.cursor = icon && icon.enabled ? 'pointer' : '';
        invalidate();
      }
      if (icon && ev) {
        tip.textContent = icon.enabled ? icon.tip : `${icon.tip} (not available)`;
        tip.style.display = '';
        tip.style.left = `${ev.clientX + 14}px`;
        tip.style.top = `${ev.clientY + 16}px`;
      } else tip.style.display = 'none';
    };
    const runIcon = (pi: PlateIcon) => {
      if (!pi.enabled) return;
      const s = useStore.getState();
      if (s.activePlate !== pi.plate && pi.action !== 'remove' && pi.action !== 'add') s.set({ activePlate: pi.plate });
      switch (pi.action) {
        case 'remove': deletePlate(pi.plate); break;
        case 'add': addPlate(); break;
        case 'orient': orientPlate(pi.plate); break;
        case 'arrange': arrange(undefined, pi.plate); break;
        case 'lock': updatePlate(pi.plate, { locked: !s.plates[pi.plate]?.locked }); break;
        case 'settings': case 'name': openPlateSettings(pi.plate); break;
        case 'number': selectPlate(pi.plate); break;
      }
    };

    // ---------------- cut tool: left drag on the plane slides it along its normal; right click on a piece swaps its side
    let cutDrag: { n: THREE.Vector3; p0: THREE.Vector3; h0: number; lo: number; hi: number } | null = null;
    const startCutDrag = (ev: PointerEvent): boolean => {
      const s = useStore.getState();
      if (ev.button !== 0 || s.tool !== 'cut' || s.cutConnectorMode || !cutPlaneMesh.visible) return false;
      if (gizmo.object && gizmo.axis) return false; // a tilt ring under the cursor wins
      ray.setFromCamera(ndc(ev), camera);
      const hit = ray.intersectObject(cutPlaneMesh, false)[0];
      const o = s.objects.find((x) => x.id === s.selected[0]);
      if (!hit || !o) return false;
      const b = worldBounds(o);
      cutDrag = { n: new THREE.Vector3(0, 0, 1).applyQuaternion(cutPlaneMesh.quaternion), p0: hit.point.clone(), h0: s.cutPlane.height, lo: b.min[2], hi: b.max[2] };
      renderer.domElement.style.cursor = 'grabbing';
      capture(ev);
      return true;
    };
    const moveCutDrag = (ev: PointerEvent) => {
      const d = cutDrag!;
      ray.setFromCamera(ndc(ev), camera);
      // the drag line runs along the plane normal; intersect the ray with the plane through that line facing the camera
      const view = ray.ray.direction.clone();
      const pn = d.n.clone().cross(view.clone().cross(d.n));
      if (pn.lengthSq() < 1e-8) return;
      const p = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(pn.normalize(), d.p0), new THREE.Vector3());
      if (!p) return;
      const t = p.sub(d.p0).dot(d.n);
      const nz = Math.abs(d.n.z) < 0.2 ? Math.sign(d.n.z || 1) * 0.2 : d.n.z;
      const h = Math.min(d.hi, Math.max(d.lo, d.h0 + t / nz));
      const s = useStore.getState();
      if (Math.abs(h - s.cutPlane.height) > 1e-3) s.set({ cutPlane: { ...s.cutPlane, height: +h.toFixed(2) } });
    };
    const cutFragAt = (ev: PointerEvent): string | null => {
      if (!cutPrev.visible) return null;
      ray.setFromCamera(ndc(ev), camera);
      return (ray.intersectObjects(cutPrev.children, false)[0]?.object.userData.cutFrag as string | undefined) ?? null;
    };

    const onPressCapture = (ev: PointerEvent) => {
      const s = useStore.getState();
      let paints = false;
      pressedIcon = null;
      if (ev.button === 0 && ev.target === renderer.domElement && s.workspace === 'prepare' && (pressedIcon = iconAt(ev))) {
        paints = true;
        capture(ev);
      } else if (ev.button === 0 && (isPaintTool(s.tool) || s.tool === 'place_pattern' || s.tool === 'sculpt_pick') && s.workspace === 'prepare' && ev.target === renderer.domElement) {
        if (s.tool === 'lasso_motion') paints = true;
        else { ray.setFromCamera(ndc(ev), camera); paints = ray.intersectObjects(objectMeshes(), false).length > 0; }
      } else if (ev.target === renderer.domElement && (startCutDrag(ev) || startBoxSelect(ev) || startObjectDrag(ev))) paints = true;
      controls.mouseButtons = paints ? { ...paintButtons } : { ...normalButtons };
    };
    el.addEventListener('pointerdown', onPressCapture, true);
    const onLeave = () => { brush.visible = false; setIconHover(null); if (hoverId) { hoverId = null; applyHover(); } invalidate(); };
    // double click on empty space: drop the selection and leave the active tool
    const onDouble = (ev: MouseEvent) => {
      const s = useStore.getState();
      if (s.workspace !== 'prepare' || isPaintTool(s.tool)) return;
      ray.setFromCamera(ndc(ev as PointerEvent), camera);
      const vis = [...[...partMeshes.values()].map((p) => p.mesh), ...objectMeshes(), ...cutPrev.children].filter((m) => m.visible && (m.parent?.visible ?? true));
      if (ray.intersectObjects(vis, false).length) return;
      s.set({ selected: [], selectedPart: null, tool: 'select', cutConnectorMode: false, cutSwap: [], surfacePick: null });
    };
    renderer.domElement.addEventListener('dblclick', onDouble);
    const onCancel = () => {
      cutDrag = null;
      drawing = null; band = null; boxSel = null; pressedIcon = null; showOutline(); showBand();
      if (objDrag) { objDrag = null; dragging = false; renderer.domElement.style.cursor = ''; syncObjects(); }
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointerleave', onLeave);
    renderer.domElement.addEventListener('contextmenu', onContext);
    renderer.domElement.addEventListener('pointercancel', onCancel);

    // ---------------- motion preview in Prepare: plugin lines drawn on the model, no slicing
    const motionMat = new LineMaterial({ linewidth: 2, vertexColors: true, worldUnits: false, depthTest: true, transparent: true });
    const motionLines = new LineSegments2(new LineSegmentsGeometry(), motionMat);
    motionLines.renderOrder = 5;
    motionLines.visible = false;
    motionLines.frustumCulled = false;
    scene.add(motionLines);
    // thick-thread twin of the lines: real-size beads and the hot drips (set while the toolpath view is on)
    const threadMesh = new ThreadMesh();
    scene.add(threadMesh.group);
    let previewTimer: ReturnType<typeof setTimeout> | null = null;
    const rebuildMotionPreview = () => {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        previewTimer = null;
        const s = useStore.getState();
        if (!showsMotion(s)) return;
        const t0 = performance.now();
        // every installed plugin adds its lines (Patternex inks, Motionex motion); drawn together
        const parts: PluginPreview[] = [];
        for (const p of PLUGINS) if (s.plugins.includes(p.id) && p.preview) { const l = p.preview(); if (l && l.positions.length) parts.push(l); }
        // thread view: parts with threads draw them (their markers stay lines); the rest turn into plain beads
        const cfg = currentConfig();
        const lw = Number(cfg.outer_wall_line_width) || Number(cfg.line_width) || 0.42, lh = Number(cfg.layer_height) || 0.2;
        let lines = parts.map((l) => ({ positions: l.positions, colors: l.colors }));
        let threads: ThreadData | null = null;
        if (s.threadView && parts.length) {
          const sets = parts.map((l) => ({ threads: hasThreads(l.threads) ? l.threads : linesToThreads(l.positions, l.colors, lw, lh), report: l.drool ?? { worstMm: 0, safeMm: 0, dripMm: 0, beads: 0, sagging: 0, dripping: 0, drips: 0, strings: 0, thinned: false, level: 'ok' as const } }));
          threads = mergeThreads(sets)?.threads ?? null;
          lines = parts.filter((l) => hasThreads(l.threads) && l.markers).map((l) => l.markers!);
        }
        setDrool(parts.map((l) => l.drool).filter((d): d is NonNullable<typeof d> => !!d));
        threadMesh.set(threads);
        const geo = new LineSegmentsGeometry();
        if (lines.length) {
          const n = lines.reduce((a, l) => a + l.positions.length, 0);
          const P = new Float32Array(n), C = new Float32Array(n);
          let o = 0;
          for (const l of lines) { P.set(l.positions, o); C.set(l.colors, o); o += l.positions.length; }
          if (n) { geo.setPositions(P); geo.setColors(C); }
        }
        motionLines.geometry.dispose();
        motionLines.geometry = geo;
        (window as any).__nxPreviewMs = performance.now() - t0;
        window.dispatchEvent(new Event('nx-preview-built'));
        invalidate();
      }, 200);
    };
    window.addEventListener('nx-plugin-preview', rebuildMotionPreview);

    // Path sculpt marks on the model: picked cells white, moved cells orange (out) or blue (in), found by casting
    // a ray from the axis out through each cell's centre to the wall
    const marks = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true }));
    marks.renderOrder = 12; marks.visible = false; marks.frustumCulled = false;
    scene.add(marks);
    let marksTimer: ReturnType<typeof setTimeout> | null = null;
    const rebuildMarks = () => {
      if (marksTimer) clearTimeout(marksTimer);
      marksTimer = setTimeout(() => {
        marksTimer = null;
        const s = useStore.getState(), sc = mx.sculpt;
        const show = s.workspace === 'prepare' && sc.enabled && (s.tool === 'sculpt_pick' || Object.keys(sc.d).length > 0);
        marks.visible = show;
        if (!show) { invalidate(); return; }
        const picked = pickedOf('sculpt', sc.w, sc.h);
        const cells = new Set<number>([...Object.keys(sc.d).map(Number), ...picked]);
        const ids = new Set(sc.objects ?? []);
        const objs = s.objects.filter((o) => o.printable !== false && (!ids.size || ids.has(o.id)));
        const targets = objectMeshes().filter((m) => objs.some((o) => o.id === m.userData.id));
        const P: number[] = [], C: number[] = [];
        const stride = Math.max(1, Math.ceil(cells.size / 1500));
        let n = 0;
        for (const i of cells) {
          if (n++ % stride) continue;
          for (const o of objs) {
            const b = worldBounds(o), cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, big = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1]) + 5;
            const { u, z } = cellCentre(sc, b.max[2], i % sc.w, Math.floor(i / sc.w));
            const a = u * 2 * Math.PI, dx = Math.cos(a), dy = Math.sin(a);
            ray.set(new THREE.Vector3(cx + dx * big, cy + dy * big, z), new THREE.Vector3(-dx, -dy, 0));
            const hit = ray.intersectObjects(targets.filter((m) => m.userData.id === o.id), false)[0];
            if (!hit) continue;
            P.push(hit.point.x + dx * 0.15, hit.point.y + dy * 0.15, hit.point.z);
            const m = sc.d[i] ?? 0;
            if (picked.has(i)) C.push(1, 1, 1); else if (m > 0) C.push(1, 0.47, 0.12); else C.push(0.16, 0.47, 1);
          }
        }
        marks.geometry.dispose();
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
        marks.geometry = g;
        invalidate();
      }, 90);
    };
    window.addEventListener('nx-sculpt-pick', rebuildMarks);
    window.addEventListener('nx-plugin-preview', rebuildMarks);

    // ---------------- preview
    let lastColorKey = '';
    const legendHook = () => {
      const s = useStore.getState();
      const key = `${s.colorScheme}|${s.hiddenFeatures.join(',')}|${s.slice.result ? s.slice.result.moves.length : 0}|${s.filaments.map((f) => f.color).join()}`;
      if (key === lastColorKey) return;
      lastColorKey = key;
      const range = toolpaths.colorize(s.colorScheme, new Set(s.hiddenFeatures), s.filaments.map((f) => f.color));
      (window as any).__nxLegend = range;
      window.dispatchEvent(new Event('nx-legend'));
    };
    const syncPreview = () => {
      const s = useStore.getState();
      const preview = s.workspace === 'preview';
      objGroup.visible = true;
      selBoxes.visible = s.workspace === 'prepare';
      toolpaths.group.visible = preview;
      motionLines.visible = showsMotion(s);
      threadMesh.group.visible = showsMotion(s);
      if (preview) {
        if (toolpaths.result !== s.slice.result) { toolpaths.setResult(s.slice.result); lastColorKey = ''; }
        const [ox, oy] = plateOrigin(s.slice.plate, s.printerId);
        toolpaths.group.position.set(ox, oy, 0);
        legendHook();
        toolpaths.setRange(s.layerRange[0], s.layerRange[1], s.moveCursor);
        toolpaths.showTravel(s.showTravel);
      }
      pxPrev.visible = preview;
      if (preview) {
        const [ox, oy] = plateOrigin(s.slice.plate, s.printerId);
        pxPrev.position.set(ox, oy, 0);
        const r = s.slice.result;
        syncPreviewOverlay(pxPrev, r?.pluginReports?.patternex as PatternexReport | undefined, s.layerRange, r ? r.layers.map((l) => l.z) : [], s.filaments.map((f) => f.color));
      }
      syncGizmo();
      invalidate();
    };

    function syncPatternex() {
      const s = useStore.getState();
      pxPrep.visible = (s.workspace === 'prepare' || s.workspace === 'motion') && s.plugins.includes('patternex');
      if (pxPrep.visible) syncPlacementOverlay(pxPrep, s.objects);
      invalidate();
    }
    const onPatternex = () => { syncPatternex(); if (useStore.getState().workspace === 'preview') syncPreview(); };
    window.addEventListener('nx-patternex', onPatternex);

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = w + 'px';
      renderer.domElement.style.height = h + 'px';
      camera.aspect = w / Math.max(h, 1);
      motionMat.resolution.set(w, h);
      threadMesh.setResolution(w, h);
      outlineMat.uniforms.uRes.value.set(w, h);
      camera.updateProjectionMatrix();
      invalidate();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    rebuildPlates();
    resize();
    setView('iso');
    syncObjects();
    syncPreview();

    const unsubAdv = useAdvanced.subscribe((a, prev) => {
      if (a.engineMode !== prev.engineMode || a.heatmap !== prev.heatmap || a.field !== prev.field || a.analysisVersion !== prev.analysisVersion) syncObjects();
      if (a.engineMode !== prev.engineMode || a.showVoxels !== prev.showVoxels || a.analysisVersion !== prev.analysisVersion) syncVoxels();
    });
    const unsub = useStore.subscribe((s, prev) => {
      if (s.printerId !== prev.printerId || s.theme !== prev.theme || s.plates !== prev.plates || s.plate !== prev.plate || s.activePlate !== prev.activePlate) {
        rebuildPlates();
        if (s.printerId !== prev.printerId || s.activePlate !== prev.activePlate || s.plates.length !== prev.plates.length) setView('iso');
      }
      if (s.objects !== prev.objects || s.selected !== prev.selected || s.selectedPart !== prev.selectedPart || s.selectedRange !== prev.selectedRange || s.filaments !== prev.filaments || s.showOverhangs !== prev.showOverhangs || s.showEdges !== prev.showEdges || s.shadeSmooth !== prev.shadeSmooth || s.edgeAngle !== prev.edgeAngle || s.edgeSel !== prev.edgeSel || s.paintOverhangAngle !== prev.paintOverhangAngle
        || s.tool !== prev.tool || s.printerId !== prev.printerId || s.theme !== prev.theme || s.overrides !== prev.overrides || s.plates !== prev.plates || s.workspace !== prev.workspace || s.plugins !== prev.plugins || s.slice.result !== prev.slice.result || s.slice.status !== prev.slice.status) syncObjects();
      if (s.tool !== prev.tool || s.workspace !== prev.workspace || s.objects !== prev.objects) rebuildMarks();
      if (s.liveToolpaths !== prev.liveToolpaths) syncObjects();
      if (s.cutPlane !== prev.cutPlane || s.cutConnectorMode !== prev.cutConnectorMode) { syncTools(); syncGizmo(); }
      if (s.cutPlane !== prev.cutPlane || s.cutSwap !== prev.cutSwap || s.cutMode !== prev.cutMode) syncCutPrev();
      if (showsMotion(s) && (s.liveToolpaths !== prev.liveToolpaths || s.workspace !== prev.workspace || s.objects !== prev.objects || s.activePlate !== prev.activePlate
        || s.printerId !== prev.printerId || s.presetId !== prev.presetId || s.overrides !== prev.overrides || s.plugins !== prev.plugins || s.filaments !== prev.filaments || s.threadView !== prev.threadView || s.colorScheme !== prev.colorScheme)) rebuildMotionPreview();
      if (s.liveToolpaths !== prev.liveToolpaths || s.workspace !== prev.workspace || s.slice.result !== prev.slice.result || s.layerRange !== prev.layerRange || s.moveCursor !== prev.moveCursor
        || s.colorScheme !== prev.colorScheme || s.hiddenFeatures !== prev.hiddenFeatures || s.showTravel !== prev.showTravel || s.filaments !== prev.filaments) syncPreview();
      if (s.brushSize !== prev.brushSize) { brush.scale.setScalar(s.brushSize / 2); invalidate(); }
      if (s.workspace !== prev.workspace || s.objects !== prev.objects) syncVoxels();
      if (s.cutPlane !== prev.cutPlane || s.cutConnectors !== prev.cutConnectors || s.cutConnector !== prev.cutConnector || s.cutMode !== prev.cutMode || s.cutGroove !== prev.cutGroove || s.measureFeatures !== prev.measureFeatures || s.surfacePick !== prev.surfacePick || s.overrides !== prev.overrides || s.plates !== prev.plates || s.activePlate !== prev.activePlate || s.machineOverrides !== prev.machineOverrides || s.tool !== prev.tool || s.selected !== prev.selected || s.objects !== prev.objects || s.workspace !== prev.workspace) { syncTools(); syncFaces(); syncGizmo(); }
    });

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (controls.update()) needsRender = true;
      if (needsRender) {
        const below = camera.position.z < 0;
        plateGroup.traverse((o) => { if (o.userData.surface) o.visible = !below; });
        // depth precision follows the zoom: a fixed 1 mm near plane left too little precision close up, so
        // neighbouring line beads fought for the same pixels and showed as stripes at every joint
        const dist = camera.position.distanceTo(controls.target);
        const near = Math.min(50, Math.max(0.05, dist / 60));
        if (Math.abs(camera.near - near) / near > 0.05) { camera.near = near; camera.updateProjectionMatrix(); }
        renderer.render(scene, camera);
        needsRender = false;
        emitCamera();
      }
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('nx-patternex', onPatternex);
      unsub();
      unsubAdv();
      voxelPts.geometry.dispose(); (voxelPts.material as THREE.Material).dispose();
      ro.disconnect();
      gizmo.dispose();
      controls.dispose();
      toolpaths.dispose();
      threadMesh.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      el.removeChild(overlay);
      window.removeEventListener('nx-plugin-preview', rebuildMotionPreview);
      window.removeEventListener('nx-sculpt-pick', rebuildMarks);
      window.removeEventListener('nx-plugin-preview', rebuildMarks);
      marks.geometry.dispose();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      tip.remove();
      el.removeEventListener('pointerdown', onPressCapture, true);
      motionLines.geometry.dispose(); motionMat.dispose();
      viewApi.current = null;
    };
  }, []);

  return <div className="viewport-canvas" ref={host} />;
}
