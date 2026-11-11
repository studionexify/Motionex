// Live 3D toolpath preview for plugin Studios: the plate's objects as faint ghosts, with the plugin's quick
// preview lines (the same ones the main viewport draws) on top. Rebuilt shortly after every plugin change
// ("nx-plugin-preview"), so dragging a slider redraws the walls while you drag.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { objectMatrix, useStore } from '../../state/store';
import { plateObjects } from '../../state/slicing';
import { transformVertices } from '../../engine/mesh';

export interface LinePreviewControls { fit: () => void; rotate: (deg: number) => void; setSpin: (on: boolean) => void; top: (on: boolean) => void }
export interface PreviewLinesLike { positions: Float32Array; colors: Float32Array }

export function LinePreview3D({ build, controls, onBuilt }: {
  /** Returns the lines to draw (plate coordinates), or null for none. */
  build: () => PreviewLinesLike | null;
  controls?: React.MutableRefObject<LinePreviewControls | null>;
  onBuilt?: (ms: number, segments: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const T = useRef<{ scene: THREE.Scene; camera: THREE.PerspectiveCamera; orbit: OrbitControls; lines: THREE.LineSegments; ghosts: THREE.Group; spin: boolean } | null>(null);
  const buildRef = useRef(build); buildRef.current = build;
  const onBuiltRef = useRef(onBuilt); onBuiltRef.current = onBuilt;
  const objects = useStore((s) => s.objects);
  const activePlate = useStore((s) => s.activePlate);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.domElement.style.display = 'block';
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 10000);
    camera.up.set(0, 0, 1);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a80, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.2); key.position.set(-200, -300, 400); scene.add(key);
    const ghosts = new THREE.Group(); scene.add(ghosts);
    const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
    scene.add(lines);
    T.current = { scene, camera, orbit, lines, ghosts, spin: false };
    const resize = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();
    let raf = 0;
    const loop = () => {
      const t = T.current!;
      if (t.spin) { const p = camera.position.clone().sub(orbit.target); p.applyAxisAngle(new THREE.Vector3(0, 0, 1), 0.006); camera.position.copy(orbit.target).add(p); }
      orbit.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop);
    };
    loop();
    if (controls) controls.current = {
      fit: () => frame(),
      rotate: (deg) => { const p = camera.position.clone().sub(orbit.target); p.applyAxisAngle(new THREE.Vector3(0, 0, 1), (deg * Math.PI) / 180); camera.position.copy(orbit.target).add(p); },
      setSpin: (on) => { T.current!.spin = on; },
      top: (on) => frame(on),
    };
    return () => { cancelAnimationFrame(raf); ro.disconnect(); orbit.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); T.current = null; if (controls) controls.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const frame = (top = false) => {
    const t = T.current;
    if (!t) return;
    const box = new THREE.Box3().setFromObject(t.ghosts);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.y, s.z) * 0.55 + 1;
    const d = (r / Math.sin((t.camera.fov * Math.PI) / 360)) * 1.1;
    t.orbit.target.copy(c);
    if (top) t.camera.position.set(c.x, c.y - d * 0.02, c.z + d);
    else t.camera.position.set(c.x + d * 0.25, c.y - d * 0.9, c.z + d * 0.35);
  };

  // ghost meshes of the plate's objects
  useEffect(() => {
    const t = T.current;
    if (!t) return;
    for (const c of [...t.ghosts.children]) { t.ghosts.remove(c); const m = c as THREE.Mesh; m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    for (const o of plateObjects(activePlate).filter((x) => x.printable !== false)) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(transformVertices(o.mesh.vertices, objectMatrix(o).elements), 3));
      geo.setIndex(new THREE.BufferAttribute(o.mesh.indices, 1));
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xd9d6cf, roughness: 0.9, transparent: true, opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      t.ghosts.add(m);
    }
    frame();
  }, [objects, activePlate]); // eslint-disable-line react-hooks/exhaustive-deps

  // preview lines, rebuilt after plugin changes (debounced)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const rebuild = () => {
      const t = T.current;
      if (!t) return;
      const t0 = performance.now();
      const l = buildRef.current();
      const geo = new THREE.BufferGeometry();
      if (l && l.positions.length) {
        geo.setAttribute('position', new THREE.BufferAttribute(l.positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(l.colors, 3));
      }
      t.lines.geometry.dispose();
      t.lines.geometry = geo;
      setEmpty(!l || !l.positions.length);
      onBuiltRef.current?.(performance.now() - t0, l ? l.positions.length / 6 : 0);
    };
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(rebuild, 90); };
    rebuild();
    window.addEventListener('nx-plugin-preview', schedule);
    return () => { if (timer) clearTimeout(timer); window.removeEventListener('nx-plugin-preview', schedule); };
  }, [objects, activePlate]);

  return (
    <div ref={host} style={{ position: 'absolute', inset: 0 }}>
      {empty && <div className="st-live" style={{ top: '46%', left: '50%', transform: 'translateX(-50%)', bottom: 'auto', zIndex: 3 }}>Nothing to show yet: put the motion on the model (Applies to).</div>}
    </div>
  );
}
