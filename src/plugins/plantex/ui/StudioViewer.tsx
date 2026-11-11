// Live 3D preview in the Plantex studio: every part of the design side by side, coloured by filament
// (texture colour layers included), rebuilt shortly after each edit. Orbit with the mouse.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useStore } from '../../../state/store';
import { IconButton, LiveBadge, ToolGroup } from '../../../ui/studio/Studio';
import { buildParts, geometryVersion, pt, slotsOf, usePt } from './state';

const GAP = 12;

export function StudioViewer() {
  usePt();
  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{ scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; group: THREE.Group; render: () => void; framed: boolean } | null>(null);
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const fils = useStore((s) => s.filaments);
  const bounds = useRef({ span: 150, maxH: 120, maxW: 120 });
  const frame = () => {
    const T = three.current;
    if (!T) return;
    const { span, maxH, maxW } = bounds.current;
    const d = Math.max(maxH, span, maxW) * 2.2 + 60;
    T.camera.position.set(d * 0.55, -d * 0.75, maxH * 0.6 + d * 0.4);
    T.controls.target.set(0, 0, maxH * 0.4);
  };

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    camera.up.set(0, 0, 1);
    camera.position.set(260, -320, 220);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x666655, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(200, -300, 400);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-300, 200, 100);
    scene.add(fill);
    const grid = new THREE.GridHelper(600, 60, 0x888888, 0xcccccc);
    grid.rotation.x = Math.PI / 2;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    scene.add(grid);
    const group = new THREE.Group();
    scene.add(group);
    const render = () => renderer.render(scene, camera);
    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    let raf = 0;
    const loop = () => { controls.update(); render(); raf = requestAnimationFrame(loop); };
    loop();
    three.current = { scene, camera, controls, group, render, framed: false };
    return () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); three.current = null; };
  }, []);

  // rebuild the parts after edits (debounced)
  const gv = geometryVersion;
  const colourKey = fils.map((f) => f.color).join(',');
  useEffect(() => {
    setBusy(true);
    const t = setTimeout(() => {
      const T = three.current;
      if (!T) return;
      const t0 = performance.now();
      const parts = buildParts(pt.spec, !pt.fullPreview);
      const colour = (k: number) => new THREE.Color(fils[k]?.color ?? '#999999');
      for (const c of [...T.group.children]) { T.group.remove(c); const m = c as THREE.Mesh; m.geometry.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose()); }
      let x = 0, left = 0, tris = 0, maxH = 0, maxW = 0;
      const lines: string[] = [];
      parts.forEach((p, n) => {
        const mesh = p.result.mesh;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
        // one draw group per colour so normals stay smooth
        const slotOf = (t: number) => (p.paint && p.paint[t] ? p.paint[t] - 1 : p.filament);
        const triCount = mesh.indices.length / 3;
        const order = Array.from({ length: triCount }, (_, t) => t).sort((a, b) => slotOf(a) - slotOf(b));
        const idx = new Uint32Array(mesh.indices.length);
        const mats: THREE.Material[] = [];
        let start = 0;
        order.forEach((t, k) => {
          idx.set(mesh.indices.subarray(t * 3, t * 3 + 3), k * 3);
          const s = slotOf(t), next = k + 1 < order.length ? slotOf(order[k + 1]) : -2;
          if (s !== next) { geo.addGroup(start * 3, (k + 1 - start) * 3, mats.length); mats.push(new THREE.MeshStandardMaterial({ color: colour(s), roughness: 0.65, metalness: 0.02, side: THREE.DoubleSide })); start = k + 1; }
        });
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.computeVertexNormals();
        geo.computeBoundingBox();
        const b = geo.boundingBox!;
        const m = new THREE.Mesh(geo, mats);
        if (n > 0) x += GAP - b.min.x; else left = b.min.x;
        m.position.set(x, 0, -b.min.z);
        x += b.max.x;
        maxH = Math.max(maxH, b.max.z - b.min.z);
        maxW = Math.max(maxW, b.max.y - b.min.y);
        T.group.add(m);
        tris += triCount;
        lines.push(`${p.label}: filament ${slotsOf(p).map((k) => k + 1).join(' + ')}`);
      });
      const span = x - left;
      T.group.position.set(-(x + left) / 2, 0, 0);
      // re-frame when the set of parts or its size changes a lot (a new design), not on small edits
      const prev = bounds.current;
      bounds.current = { span, maxH, maxW };
      if (!T.framed || Math.abs(span - prev.span) > prev.span * 0.3 || Math.abs(maxH - prev.maxH) > prev.maxH * 0.3) { frame(); T.framed = true; }
      setInfo(`${lines.join(' · ')} — ${tris.toLocaleString()} triangles${pt.fullPreview ? '' : ' (draft preview)'} · ${Math.round(performance.now() - t0)} ms`);
      setBusy(false);
    }, 180);
    return () => clearTimeout(t);
  }, [gv, pt.fullPreview, colourKey]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={host} style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 50% 40%, var(--surface-primary), var(--surface-tertiary))' }} />
      <LiveBadge busy={busy} text={`Live · ${info}`} />
      <div className="st-toolbar br"><span className="st-ttl">Preview</span><ToolGroup label="Zoom"><IconButton icon="fit" title="Reset the view" onClick={frame} /></ToolGroup></div>
    </div>
  );
}
