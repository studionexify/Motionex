// Lumonex Studio: a full-window (98%) workspace over Nexspiro. Left: the design editor (lamp type,
// presets, part stack, per-part shape / pattern / joint, fitting, wiring, hardware). Centre: a live 3D
// view of the lamp — assembled (lit, with the bulb), exploded, or as the print pieces laid out on the
// plates "Transfer to plate" will create. Right: printer fit, thermal and hardware report.
import { useEffect, useRef, useState } from 'react';
import { Live3D } from '../../../ui/Live3D';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useStore } from '../../../state/store';
import { printerById } from '../../../profiles/printers';
import { assembled, buildLamp, rotateXYZ, type BuiltPart } from '../build';
import { bounds, toMesh, translate, type Soup } from '../geom';
import { EditorColumn, ReportColumn, useReport } from './LumonexPanel';
import { LiveBadge, Seg, Stat, StudioWindow, ToolGroup } from '../../../ui/studio/Studio';
import { UndoRedo } from '../../../ui/studio/UndoRedo';
import { StackEditorBody, StackEditorHead } from './StackEditor';
import { swatch } from '../catalog';
import { RenexStudio } from '../../../renex/ui/RenexStudio';
import { lumonexRenexSource } from '../renexSource';
import { bedOf, changed, geometryVersion, groupByFilament, lx, openStudio, transferToPlate, undoHistory, useLx, type StudioView } from './state';

export function LumonexStudioHost() {
  useLx();
  const installed = useStore((s) => s.plugins.includes('lumonex'));
  if (!installed || !lx.studioOpen || typeof document === 'undefined') return null;
  return createPortal(<Studio />, document.body);
}

interface Placed { part: BuiltPart; soup: Soup; cuts: Soup[]; plate?: number }

/** Shelf-pack print pieces onto beds, one or more beds per filament (same rule as Transfer to plate). */
export function layoutPieces(parts: BuiltPart[], bed: { x: number; y: number }, gap = 6): { placed: Placed[]; beds: { x: number; y: number; key: string; hex: string }[] } {
  const placed: Placed[] = [], beds: { x: number; y: number; key: string; hex: string }[] = [];
  let bedX = 0;
  for (const g of groupByFilament(parts)) {
    let cx = gap, cy = gap, row = 0, origin = bedX;
    beds.push({ x: origin, y: 0, key: g.key, hex: g.hex });
    for (const p of g.parts) {
      const soup = rotateXYZ([...p.soup], p.printRot), cuts = p.cuts.map((c) => rotateXYZ([...c], p.printRot));
      const b = bounds(soup), w = b.max[0] - b.min[0], h = b.max[1] - b.min[1];
      if (cx + w > bed.x - gap && cx > gap) { cx = gap; cy += row + gap; row = 0; }
      if (cy + h > bed.y - gap && cy > gap) { origin += bed.x + 40; beds.push({ x: origin, y: 0, key: g.key, hex: g.hex }); cx = gap; cy = gap; row = 0; }
      const dx = origin + cx - b.min[0], dy = cy - b.min[1], dz = -b.min[2];
      translate(soup, dx, dy, dz);
      for (const c of cuts) translate(c, dx, dy, dz);
      placed.push({ part: p, soup, cuts, plate: beds.length - 1 });
      cx += w + gap; row = Math.max(row, h);
    }
    bedX = origin + bed.x + 80;
  }
  return { placed, beds };
}

function scenePieces(parts: BuiltPart[], view: StudioView): Placed[] {
  if (view === 'pieces') return layoutPieces(parts, bedOf()).placed;
  const list = parts.filter((p) => p.soup.length).map((p) => ({ part: p, soup: assembled(p), cuts: p.cuts.map((c) => assembled(p, c)) }));
  if (view === 'exploded') {
    const order = list.map((x, i) => { const b = bounds(x.soup); return { i, z: (b.min[2] + b.max[2]) / 2 }; }).sort((a, b) => a.z - b.z);
    order.forEach((o, rank) => { const x = list[o.i]; const dz = rank * 45; translate(x.soup, 0, 0, dz); for (const c of x.cuts) translate(c, 0, 0, dz); });
  }
  return list;
}

function Viewer() {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{ rebuild: (refine: boolean) => void; dispose: () => void } | null>(null);
  const [status, setStatus] = useState('');
  const [beds, setBeds] = useState<{ key: string; hex: string; count: number }[]>([]);
  useLx();
  const printerId = useStore((s) => s.printerId);

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.localClippingEnabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 50000);
    camera.up.set(0, 0, 1);
    camera.position.set(600, -900, 600);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 1.1);
    const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(500, -700, 1200);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-800, 600, 400);
    scene.add(hemi, key, fill);
    const bulbLight = new THREE.PointLight(0xffc56b, 0, 0, 0);
    scene.add(bulbLight);
    const group = new THREE.Group();
    scene.add(group);
    const clip = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let raf = 0, framed = '';

    const resize = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();
    const loop = () => { raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); };
    loop();

    const dark = () => document.documentElement.getAttribute('data-theme') === 'dark' || useStore.getState().theme === 'dark';
    const rebuild = (refine: boolean) => {
      const t0 = performance.now();
      const design = refine ? lx.design : { ...lx.design, quality: 'draft' as const };
      let parts: BuiltPart[];
      try { parts = buildLamp(design, bedOf()).parts; } catch (e) { setStatus(`Build failed: ${(e as Error).message}`); return; }
      for (const c of [...group.children]) { group.remove(c); c.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); }); }
      const view = lx.view;
      const pieces = scenePieces(parts, view);
      const sel = lx.design.sections.find((s) => s.id === lx.selected)?.name;
      const lit = lx.lit && view !== 'pieces';
      scene.background = new THREE.Color(lit ? (dark() ? '#161b22' : '#3b342e') : dark() ? '#141a22' : '#efe7de');
      hemi.intensity = lit ? 0.75 : 1.1; key.intensity = lit ? 1.0 : 1.6;
      let bulbAt: THREE.Vector3 | null = null;
      for (const p of pieces) {
        const m = toMesh(p.soup);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(m.vertices, 3));
        geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
        // flat normals: crisp ribs and rims (smoothing across the rim edges shades them wrongly)
        const flatGeo = geo.toNonIndexed(); geo.dispose();
        flatGeo.computeVertexNormals();
        const isBulb = p.part.key === 'ghost-bulb';
        const translucent = p.part.material === 'PETG Translucent';
        const mat = new THREE.MeshStandardMaterial({
          color: p.part.hex, roughness: p.part.material === 'PLA Silk' ? 0.25 : p.part.material === 'PLA Matte' ? 0.85 : 0.55,
          metalness: p.part.material === 'PLA Silk' ? 0.45 : 0, side: THREE.DoubleSide,
          transparent: translucent || p.part.ghost, opacity: isBulb ? 0.9 : p.part.ghost ? 0.5 : translucent ? (lit ? 0.72 : 0.6) : 1,
          emissive: isBulb && lit ? new THREE.Color('#fff1b8') : lit && translucent ? new THREE.Color(p.part.hex) : new THREE.Color(0),
          emissiveIntensity: isBulb ? 1.6 : 0.35,
          clippingPlanes: lx.cutaway && view !== 'pieces' ? [clip] : [],
        });
        if (sel && p.part.group === sel && !p.part.ghost) { mat.emissive = new THREE.Color('#2563eb'); mat.emissiveIntensity = 0.07; }
        const mesh = new THREE.Mesh(flatGeo, mat);
        mesh.userData.group = p.part.group;
        mesh.userData.name = p.part.name;
        group.add(mesh);
        if (isBulb) { flatGeo.computeBoundingBox(); bulbAt = flatGeo.boundingBox!.getCenter(new THREE.Vector3()); }
        if (lx.showCuts) for (const c of p.cuts) {
          const cm = toMesh(c), cg = new THREE.BufferGeometry();
          cg.setAttribute('position', new THREE.BufferAttribute(cm.vertices, 3)); cg.setIndex(new THREE.BufferAttribute(cm.indices, 1)); cg.computeVertexNormals();
          group.add(new THREE.Mesh(cg, new THREE.MeshStandardMaterial({ color: '#ff3355', transparent: true, opacity: 0.45, depthWrite: false })));
        }
      }
      bulbLight.intensity = lit && bulbAt ? 1.6 * Math.max(0.3, Math.min(2, lx.design.watts / 6)) : 0;
      if (bulbAt) bulbLight.position.copy(bulbAt);
      // floor: printer beds in the pieces view, a grid under the lamp otherwise
      const bed = bedOf();
      if (view === 'pieces') {
        const { beds: bs } = layoutPieces(parts, bed);
        const count = new Map<string, number>();
        for (const b of bs) {
          count.set(b.key, (count.get(b.key) ?? 0) + 1);
          const plate = new THREE.Mesh(new THREE.PlaneGeometry(bed.x, bed.y), new THREE.MeshStandardMaterial({ color: dark() ? '#2b3440' : '#3a3d42', roughness: 0.9 }));
          plate.position.set(b.x + bed.x / 2, bed.y / 2, -0.3);
          const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(bed.x + 6, bed.y + 6)), new THREE.LineBasicMaterial({ color: b.hex }));
          edge.position.set(b.x + bed.x / 2, bed.y / 2, 0);
          group.add(plate, edge);
        }
        setBeds(groupByFilament(parts).map((g) => ({ key: g.key, hex: g.hex, count: count.get(g.key) ?? 1 })));
      } else {
        const grid = new THREE.GridHelper(Math.max(bed.x, bed.y) * 3, 30, 0x888888, 0x555555);
        grid.rotation.x = Math.PI / 2;
        (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.35;
        const zs = pieces.filter((p) => !p.part.ghost).map((p) => bounds(p.soup).min[2]);
        grid.position.z = zs.length ? Math.min(...zs) : 0;
        group.add(grid);
        setBeds([]);
      }
      // frame the camera when the view or lamp size changes
      const box = new THREE.Box3().setFromObject(group);
      const sig = `${view}|${Math.round(box.max.z - box.min.z)}|${Math.round(box.max.x - box.min.x)}|${printerId}`;
      if (sig !== framed && !box.isEmpty()) {
        framed = sig;
        const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
        controls.target.copy(c);
        const dir = view === 'pieces' ? new THREE.Vector3(0.15, -0.7, 0.9) : new THREE.Vector3(0.55, -1, 0.45);
        camera.position.copy(c).add(dir.normalize().multiplyScalar((size / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.05));
      }
      setStatus(`${pieces.filter((p) => !p.part.ghost).length} parts · ${(performance.now() - t0).toFixed(0)} ms${refine ? '' : ' · draft'}`);
    };

    // click a part to edit its section
    let down: [number, number] | null = null;
    const ray = new THREE.Raycaster();
    renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(group.children, false).find((h) => h.object.userData.group);
      const s = hit && lx.design.sections.find((x) => x.name === hit.object.userData.group);
      if (s) { lx.selected = s.id; changed(false); }
    });

    api.current = { rebuild, dispose: () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); } };
    return () => api.current?.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // draft rebuild right after an edit, full quality once editing pauses
  const sig = `${geometryVersion}|${lx.view}|${lx.lit}|${lx.cutaway}|${lx.showCuts}|${lx.selected}|${printerId}`;
  useEffect(() => {
    const a = setTimeout(() => api.current?.rebuild(false), 60);
    const b = lx.design.quality !== 'draft' ? setTimeout(() => api.current?.rebuild(true), 1200) : undefined;
    return () => { clearTimeout(a); if (b) clearTimeout(b); };
  }, [sig]);

  return (
    <>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      {beds.length > 0 && (
        <div className="st-stats" style={{ top: 52, right: 'auto', left: 14 }}>
          {beds.map((b) => <div key={b.key} className="st-stat"><small><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: b.hex, marginRight: 5 }} />{b.key}</small><b>{b.count} plate{b.count > 1 ? 's' : ''}</b></div>)}
        </div>
      )}
      <LiveBadge text={status ? `Live · ${status}` : 'Live'} />
      <div className="st-toolbar br">
        <span className="st-ttl">Preview</span>
        <ToolGroup label="Show"><Seg label="Show" value={lx.view} options={[['assembled', 'Assembled'], ['exploded', 'Exploded'], ['pieces', 'Print plates']]} onChange={(v) => { lx.view = v; changed(false); }} /></ToolGroup>
        <ToolGroup label="Look">
          <span className="st-seg" role="group" aria-label="Look">
            <button className={lx.lit ? 'on' : ''} aria-pressed={lx.lit} title="Light the bulb" onClick={() => { lx.lit = !lx.lit; changed(false); }}>Lit</button>
            <button className={lx.cutaway ? 'on' : ''} aria-pressed={lx.cutaway} title="Cut the lamp open" onClick={() => { lx.cutaway = !lx.cutaway; changed(false); }}>Cutaway</button>
            <button className={lx.showCuts ? 'on' : ''} aria-pressed={lx.showCuts} title="Show the cut-outs (cable, switch…)" onClick={() => { lx.showCuts = !lx.showCuts; changed(false); }}>Cut-outs</button>
          </span>
        </ToolGroup>
      </div>
    </>
  );
}

function Studio() {
  useLx();
  const printer = printerById(useStore((s) => s.printerId));
  const [renex, setRenex] = useState(false);
  const report = useReport();
  const transfer = () => {
    const r = transferToPlate();
    useStore.getState().set({ toast: { kind: 'info', text: `${r.objects} pieces placed on ${r.plates.length} plate(s): ${r.plates.map((p) => `${p.name} (${p.parts})`).join(', ')}` } });
    openStudio(false);
  };
  const misfit = report.parts.filter((p) => !p.fits).length;
  const stage = (
    <>
      <Live3D><Viewer /></Live3D>
      <div className="st-stats" style={{ top: 52 }}>
        <Stat label="Lamp height" value={`${report.height.toFixed(0)} mm`} />
        <Stat label={`Pieces · ${printer.model}`} value={`${report.pieces}`} />
        <Stat label="Printer fit" value={misfit ? `${misfit} too big` : 'All fit'} tone={misfit ? 'warn' : 'ok'} />
        {report.bulbGap !== null && <Stat label="Bulb gap" value={`${report.bulbGap.toFixed(0)} mm`} tone={report.bulbGap < report.minGap ? 'warn' : undefined} />}
      </div>
    </>
  );
  return (
    <>
      <StudioWindow name="Lumonex" letter="L" gradient="linear-gradient(135deg,#F59E0B,#B45309)" onClose={() => { if (!renex) openStudio(false); }}
        version={lx.design.name} sideWidth={300}
        side={<div className="mx-panel" style={{ display: 'contents' }}><EditorColumn stack={false} /><ReportColumn onTransfer={transfer} /></div>}
        rail={<><small>Parts</small>{lx.design.sections.map((s) => <button key={s.id} className={`st-sw ${s.id === lx.selected ? 'on' : ''}`} style={{ background: swatch(s.material, s.color).hex, width: 24, height: 24 }} title={s.name} aria-label={s.name} onClick={() => { lx.selected = s.id; changed(false); }} />)}</>}
        stage={stage}
        editor={<><StackEditorHead /><div className="st-editor-body"><StackEditorBody /></div></>}
        editorHeight={270}
        actions={<><UndoRedo history={undoHistory} /><button className="st-btn" title="Photorealistic render of the printed lamp (Renex)" onClick={() => setRenex(true)}>Render</button><button className="st-btn" onClick={transfer} title="Take the lamp apart onto print plates">Transfer to plate</button></>} />
      {renex && <RenexStudio source="lumonex" build={lumonexRenexSource} onClose={() => setRenex(false)} />}
    </>
  );
}
