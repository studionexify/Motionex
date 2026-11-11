// Clickex live view: the base, the button and the real switch on a build plate, rebuilt as the design is edited.
// Assembled (with a press test), Exploded, or Print layout (every part the way it will sit on the bed).
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useStore } from '../../../state/store';
import { meshBounds } from '../../../engine/mesh';
import { printParts, type BuiltClicker, type Part } from '../build';
import { effectiveSwitch } from '../plan';
import { bedOf, compute, cx, geometryVersion, useCx } from './state';

const geoCache = new WeakMap<Part, THREE.BufferGeometry>();

function geometryOf(p: Part): THREE.BufferGeometry {
  const hit = geoCache.get(p);
  if (hit) return hit;
  const v = p.mesh.vertices, ix = p.mesh.indices, n = ix.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const colours = p.palette.map((h) => new THREE.Color(h));
  for (let k = 0; k < n; k++) {
    const i = ix[k] * 3, c = colours[p.slots[Math.floor(k / 3)]] ?? colours[0];
    pos[k * 3] = v[i]; pos[k * 3 + 1] = v[i + 1]; pos[k * 3 + 2] = v[i + 2];
    col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  geoCache.set(p, g);
  return g;
}

/** The switch, drawn from its datasheet numbers: housing, flange, stem with cross, pins. */
function switchModel(built: BuiltClicker, k: number, clip: THREE.Plane[], travelDown: number): THREE.Group {
  const spec = cx.spec, sw = effectiveSwitch(spec), s = built.switches[k];
  const g = new THREE.Group();
  const mat = (color: string, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, side: THREE.DoubleSide, clippingPlanes: clip, ...extra });
  const box = (w: number, h: number, z0: number, z1: number, m: THREE.Material, x = 0, y = 0) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, z1 - z0), m);
    b.position.set(x, y, (z0 + z1) / 2);
    return b;
  };
  const cyl = (r: number, z0: number, z1: number, m: THREE.Material, x = 0, y = 0) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, z1 - z0, 24), m);
    c.rotation.x = Math.PI / 2; c.position.set(x, y, (z0 + z1) / 2);
    return c;
  };
  const z0 = s.plateTop;
  const body = mat('#2b2c31'), top = mat('#34363c', { transparent: true, opacity: 0.96 }), stem = mat('#d94c3d', { roughness: 0.4 }), gold = mat('#c9a24a', { metalness: 0.6, roughness: 0.35 });
  g.add(box(sw.cutout - 0.1, sw.cutout - 0.1, z0 - sw.belowPlate, z0, body));
  g.add(box(sw.flange, sw.flange, z0, z0 + sw.housingTop, top));
  const st = new THREE.Group();
  st.add(cyl(sw.collarD / 2 - 0.2, z0 + sw.housingTop - 1.2, z0 + sw.housingTop + 1.4, stem));
  st.add(box(sw.armLen, sw.armWid, z0 + sw.housingTop + 1.4, z0 + sw.stemTop, stem));
  st.add(box(sw.armWid, sw.armLen, z0 + sw.housingTop + 1.4, z0 + sw.stemTop, stem));
  st.position.z = -travelDown;
  g.add(st);
  g.add(cyl(2, z0 - sw.belowPlate - 1.8, z0 - sw.belowPlate, body));
  g.add(cyl(0.8, z0 - sw.belowPlate - sw.pins, z0 - sw.belowPlate, gold, -3.81, 2.54));
  g.add(cyl(0.8, z0 - sw.belowPlate - sw.pins, z0 - sw.belowPlate, gold, 2.54, 5.08));
  g.position.set(s.cx, s.cy, 0);
  g.rotation.z = (s.angle * Math.PI) / 180;
  return g;
}

export function Viewer() {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{ rebuild: () => void; dispose: () => void } | null>(null);
  useCx();
  const printerId = useStore((s) => s.printerId);
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.localClippingEnabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 1, 8000);
    camera.up.set(0, 0, 1);
    camera.position.set(90, -130, 90);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    scene.add(new THREE.HemisphereLight(0xffffff, 0x6a6f78, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 2.1); key.position.set(120, -160, 260); scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.55); fill.position.set(-200, 120, 90); scene.add(fill);
    const group = new THREE.Group();
    scene.add(group);
    let raf = 0, framed = '';

    const resize = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();
    const loop = () => { raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); };
    loop();

    const dark = () => document.documentElement.getAttribute('data-theme') === 'dark' || (document.documentElement.getAttribute('data-theme') == null && useStore.getState().theme === 'dark');

    const rebuild = () => {
      for (const c of [...group.children]) {
        group.remove(c);
        c.traverse((o) => { const m = o as THREE.Mesh; (m.material as THREE.Material | undefined)?.dispose?.(); if (m.geometry && !m.userData.part) m.geometry.dispose(); });
      }
      const isDark = dark();
      scene.background = new THREE.Color(isDark ? '#12171e' : '#eef0f3');
      const c = compute();
      const built = c.built;
      if (!built || !built.parts.length) return;
      const bed = bedOf();
      const clip: THREE.Plane[] = [];
      const sw0 = built.switches[0];
      if (cx.cutOpen && cx.view !== 'print') clip.push(new THREE.Plane(new THREE.Vector3(0, 1, 0), -sw0.cy));
      const travel = cx.spec.sw.travel;
      const explode = Math.max(16, built.heights.capTop * 0.8);

      // plate under the parts
      const plateColor = isDark ? '#2b3138' : '#4d5158';
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(bed.x, bed.y), new THREE.MeshStandardMaterial({ color: plateColor, roughness: 0.95, side: THREE.DoubleSide }));
      const grid = new THREE.GridHelper(Math.max(bed.x, bed.y), Math.round(Math.max(bed.x, bed.y) / 10), 0x7b8088, 0x666b72);
      grid.rotation.x = Math.PI / 2; grid.position.z = 0.02;
      (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.55;

      const items: { part: Part; dz: number; dx: number; dy: number }[] = [];
      if (cx.view === 'print') {
        const pp = printParts(built);
        let x = 0;
        const boxes = pp.map((p) => meshBounds(p.mesh.vertices));
        const gap = 10, total = boxes.reduce((s, b) => s + (b.max[0] - b.min[0]), 0) + gap * (pp.length - 1);
        x = -total / 2;
        pp.forEach((p, i) => {
          const b = boxes[i];
          items.push({ part: p, dz: 0, dx: x - b.min[0], dy: -(b.min[1] + b.max[1]) / 2 });
          x += b.max[0] - b.min[0] + gap;
        });
      } else {
        built.parts.forEach((p) => items.push({ part: p, dz: p.key === 'button' ? (cx.view === 'exploded' ? explode : -cx.press * travel) : 0, dx: 0, dy: 0 }));
      }
      for (const it of items) {
        const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.52, metalness: 0, side: THREE.DoubleSide, clippingPlanes: clip });
        const m = new THREE.Mesh(geometryOf(it.part), mat);
        m.userData.part = it.part;
        m.position.set(it.dx, it.dy, it.dz);
        group.add(m);
      }
      if (cx.showSwitch && cx.view !== 'print') {
        built.switches.forEach((_, k) => {
          const sg = switchModel(built, k, clip, cx.view === 'assembled' ? cx.press * travel : 0);
          group.add(sg);
        });
      }
      // centre the plate on the parts
      const box = new THREE.Box3().setFromObject(group);
      const ctr = box.getCenter(new THREE.Vector3());
      plate.position.set(ctr.x, ctr.y, -0.05); grid.position.x = ctr.x; grid.position.y = ctr.y;
      group.add(plate, grid);
      // edge of the printable area in the print view
      if (cx.view === 'print') {
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(bed.x, bed.y)), new THREE.LineBasicMaterial({ color: 0x2563eb }));
        edge.position.set(ctr.x, ctr.y, 0.1);
        group.add(edge);
      }
      const sig = `${cx.view}|${cx.spec.source}|${Math.round(box.max.z - box.min.z)}|${Math.round(box.max.x - box.min.x)}|${printerId}`;
      if (sig !== framed) {
        framed = sig;
        const solid = new THREE.Box3();
        group.children.forEach((o) => { if (o !== plate && o !== grid) solid.expandByObject(o); });
        const c2 = solid.getCenter(new THREE.Vector3()), size = Math.max(solid.getSize(new THREE.Vector3()).length(), 40);
        controls.target.copy(c2);
        const dir = cx.view === 'print' ? new THREE.Vector3(0.15, -0.6, 0.9) : new THREE.Vector3(0.45, -1, 0.55);
        camera.position.copy(c2).add(dir.normalize().multiplyScalar((size / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.15));
      }
    };

    api.current = { rebuild, dispose: () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); } };
    (window as unknown as { __clickexView?: unknown }).__clickexView = { camera, controls, rebuild };
    return () => api.current?.dispose();
  }, []);

  const sig = `${geometryVersion}|${cx.view}|${cx.showSwitch}|${cx.cutOpen}|${cx.press}|${printerId}|${theme}`;
  useEffect(() => { api.current?.rebuild(); }, [sig]);

  return <div ref={host} className="cx-canvas" />;
}
