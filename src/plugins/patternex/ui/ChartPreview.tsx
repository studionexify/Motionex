// Live 3D preview for the Patternex Studio: the real object, with the chart painted on it by a shader that uses
// the same mapping as the slicer (arc length round the wrap axis, or straight on for front charts, and the same
// surface-angle filter). Repainting a cell only updates a small texture, so the preview follows every stroke.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { objectMatrix, type SceneObject } from '../../../state/store';
import { transformVertices } from '../../../engine/mesh';
import { BASE, cellAt, chartSize, type ChartSpec } from '../chart';
import { wrapGeometry } from './chartStudio';

export interface PreviewControls { fit: () => void; rotate: (deg: number) => void; setSpin: (on: boolean) => void }

const hexBytes = (hex: string): [number, number, number] => { const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };

export function ChartPreview({ object, spec, colour, base, controls }: {
  object: SceneObject | undefined; spec: ChartSpec;
  /** Colour of a cell value (slot or BASE). */
  colour: (v: number) => string;
  base: string;
  controls?: React.MutableRefObject<PreviewControls | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const T = useRef<{
    renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; orbit: OrbitControls;
    mesh: THREE.Mesh | null; uniforms: Record<string, THREE.IUniform>; tex: THREE.DataTexture | null; size: number; spin: boolean;
  } | null>(null);

  // renderer + scene
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 1, 10000);
    camera.up.set(0, 0, 1);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a80, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.7); key.position.set(-180, -320, 380); scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.55); rim.position.set(300, 250, 120); scene.add(rim);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.07, depthWrite: false }));
    shadow.name = 'shadow';
    scene.add(shadow);
    const uniforms: Record<string, THREE.IUniform> = {
      uTex: { value: null }, uCols: { value: 1 }, uRows: { value: 1 }, uTotalCols: { value: 1 }, uTotalRows: { value: 1 },
      uCellW: { value: 1 }, uCellH: { value: 1 }, uHalfW: { value: 1 }, uR: { value: 1 }, uStart: { value: 0 }, uMode: { value: 0 },
      uBase: { value: new THREE.Color('#cccccc') }, uMinCos: { value: Math.cos((78 * Math.PI) / 180) },
    };
    T.current = { renderer, scene, camera, orbit, mesh: null, uniforms, tex: null, size: 100, spin: false };
    const resize = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();
    let raf = 0;
    const loop = () => {
      const t = T.current!;
      if (t.spin) { const a = 0.006, p = camera.position.clone().sub(orbit.target); p.applyAxisAngle(new THREE.Vector3(0, 0, 1), a); camera.position.copy(orbit.target).add(p); }
      orbit.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop);
    };
    loop();
    if (controls) controls.current = {
      fit: () => frame(),
      rotate: (deg) => { const p = camera.position.clone().sub(orbit.target); p.applyAxisAngle(new THREE.Vector3(0, 0, 1), (deg * Math.PI) / 180); camera.position.copy(orbit.target).add(p); },
      setSpin: (on) => { T.current!.spin = on; },
    };
    return () => { cancelAnimationFrame(raf); ro.disconnect(); orbit.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); T.current = null; if (controls) controls.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const frame = () => {
    const t = T.current;
    if (!t?.mesh) return;
    const b = new THREE.Box3().setFromObject(t.mesh), c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.y, s.z) * 0.5 + 1;
    const d = r / Math.sin((t.camera.fov * Math.PI) / 360) * 1.15;
    t.orbit.target.copy(c);
    t.camera.position.set(c.x + d * 0.18, c.y - d * 0.95, c.z + d * 0.32);
  };

  // object mesh
  useEffect(() => {
    const t = T.current;
    if (!t) return;
    if (t.mesh) { t.scene.remove(t.mesh); t.mesh.geometry.dispose(); (t.mesh.material as THREE.Material).dispose(); t.mesh = null; }
    if (!object) return;
    const g = wrapGeometry(object);
    const v = transformVertices(object.mesh.vertices, objectMatrix(object).elements);
    for (let i = 0; i < v.length; i += 3) { v[i] -= g.cx; v[i + 1] -= g.cy; v[i + 2] -= g.zMin; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
    geo.setIndex(new THREE.BufferAttribute(object.mesh.indices, 1));
    // flat facets look like print lines on coarse meshes: split by angle for crisp edges, smooth curved walls
    const soft = geo.toNonIndexed();
    soft.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72, metalness: 0.0 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, t.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vPos;\nvarying vec3 vWN;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * objectNormal);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vPos; varying vec3 vWN;
uniform sampler2D uTex; uniform float uCols, uRows, uTotalCols, uTotalRows, uCellW, uCellH, uHalfW, uR, uStart, uMinCos; uniform int uMode; uniform vec3 uBase;`)
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
vec3 cc = uBase;
float py = vPos.z - uStart, pxx; bool facing;
if (uMode == 0) {
  vec2 rad = vPos.xy; float rl = max(length(rad), 1e-5);
  pxx = atan(vPos.x, -vPos.y) * uR;
  facing = dot(normalize(vWN), vec3(rad / rl, 0.0)) > uMinCos;
} else { pxx = vPos.x; facing = dot(normalize(vWN), vec3(0.0, -1.0, 0.0)) > uMinCos; }
float fx = (pxx + uHalfW) / uCellW, fy = py / uCellH;
if (facing && fx >= 0.0 && fx < uTotalCols && fy >= 0.0 && fy < uTotalRows) {
  float c = mod(floor(fx), uCols), r = mod(floor(fy), uRows);
  cc = texture2D(uTex, vec2((c + 0.5) / uCols, (r + 0.5) / uRows)).rgb;
  vec2 f = fract(vec2(fx, fy));
  float e = min(min(f.x, 1.0 - f.x) * uCellW, min(f.y, 1.0 - f.y) * uCellH);
  cc *= mix(0.86, 1.0, smoothstep(0.0, 0.14, e));
}
float lines = 0.5 + 0.5 * cos(vPos.z * 31.4159);
cc *= 1.0 - 0.035 * lines;
vec4 diffuseColor = vec4(cc, opacity);`);
    };
    const mesh = new THREE.Mesh(soft, mat);
    t.mesh = mesh;
    t.scene.add(mesh);
    const shadow = t.scene.getObjectByName('shadow') as THREE.Mesh;
    shadow.scale.setScalar(g.R * 1.05);
    shadow.position.z = 0.05;
    t.uniforms.uR.value = g.R;
    frame();
  }, [object?.id, object?.mesh, object?.position?.join(','), object?.rotation?.join(','), object?.scale?.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // chart → texture + uniforms (cheap: runs on every stroke)
  const key = spec.cells.join(',') + '|' + spec.cols + 'x' + spec.rows;
  const colourKey = [BASE, ...Array.from({ length: 16 }, (_, k) => k)].map((v) => colour(v)).join(',');
  useEffect(() => {
    const t = T.current;
    if (!t) return;
    const u = t.uniforms;
    const data = new Uint8Array(spec.cols * spec.rows * 4);
    for (let r = 0; r < spec.rows; r++) for (let c = 0; c < spec.cols; c++) {
      const [R, G, B] = hexBytes(colour(cellAt(spec, c, r)));
      const i = (r * spec.cols + c) * 4;
      data[i] = R; data[i + 1] = G; data[i + 2] = B; data[i + 3] = 255;
    }
    if (!t.tex || t.tex.image.width !== spec.cols || t.tex.image.height !== spec.rows) {
      t.tex?.dispose();
      t.tex = new THREE.DataTexture(data, spec.cols, spec.rows, THREE.RGBAFormat);
      t.tex.magFilter = THREE.NearestFilter; t.tex.minFilter = THREE.NearestFilter; t.tex.generateMipmaps = false;
      t.tex.colorSpace = THREE.SRGBColorSpace;
    } else (t.tex.image.data as Uint8Array).set(data);
    t.tex.needsUpdate = true;
    u.uTex.value = t.tex;
    (u.uBase.value as THREE.Color).set(base);
  }, [key, colourKey, base]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = T.current;
    if (!t || !object) return;
    const g = wrapGeometry(object);
    const { width, cellW } = chartSize(spec, g.circumference);
    const u = t.uniforms;
    u.uCols.value = spec.cols; u.uRows.value = spec.rows;
    u.uTotalCols.value = spec.cols * spec.repX; u.uTotalRows.value = spec.rows * spec.repY;
    u.uCellW.value = cellW; u.uCellH.value = spec.cellH; u.uHalfW.value = width / 2;
    u.uStart.value = spec.startZ; u.uMode.value = spec.projection === 'wrap' ? 0 : 1;
    u.uR.value = g.R;
  }, [object?.id, object?.mesh, spec.cols, spec.rows, spec.repX, spec.repY, spec.cellH, spec.cellW, spec.startZ, spec.projection]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={host} style={{ position: 'absolute', inset: 0 }} />;
}
