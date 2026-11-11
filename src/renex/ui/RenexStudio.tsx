// Renex studio: opened from the Plantex and Lumonex studios. Left: scene, camera, product, props, output,
// profiles and AI settings. Centre: the progressive path-traced image. Export writes the render
// disclosure into the image metadata.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RenexRenderer, encodeCanvas, type RenderProgress } from '../engine';
import { RenexViewport } from '../viewport';
import { IMPORT_EXT, importModel } from '../cad/importModel';
import { ALL_SWATCHES, FINISH_KINDS, SWATCH_BRANDS, type FinishKind } from '../materials';
import { PLANT_CATEGORIES, PLANTS, type PlantCategory } from '../plants';
import { TOP_DRESSINGS } from '../components';
import { BACKDROPS, ENVIRONMENTS, SHOTS } from '../scenes';
import { ASPECTS, QUALITY, addProfile, batchJobs, type BatchSpec, deleteProfile, lastSetup, profilesFor, rememberSetup, type Quality, type RenderSetup, type RenexSource } from '../profiles';
import { AI_PROVIDERS, aiEnhance, aiReady, loadAi, saveAi, type AiSettings } from '../ai';
import { hasDisclosure, tagImage, type DisclosureInfo } from '../metadata';
import type { RenexSceneSource } from '../source';
import { useStore } from '../../state/store';
import type { ShotId } from '../scenes';
import './renex.css';

const TABS = ['Scene', 'Camera', 'Product', 'Props', 'Output', 'Profiles', 'AI'] as const;
type Tab = (typeof TABS)[number];

interface Props { source: RenexSource; build: () => RenexSceneSource; onClose: () => void }

/** Setup fields that only move the camera (handled without rebuilding the scene). */
const CAMERA_KEYS = ['az', 'el', 'dolly', 'focal', 'fNumber', 'focusZ', 'blades', 'shot'] as const;
/** Setup fields that do not change the picture at all. */
const OUTPUT_KEYS = ['quality', 'format', 'jpegQuality', 'watermark', 'saveToProject', 'denoise', 'aspect'] as const;
const sceneKey = (s: RenderSetup) => JSON.stringify({ ...s, ...Object.fromEntries([...CAMERA_KEYS, ...OUTPUT_KEYS, 'width', 'height'].map((k) => [k, 0])) });
const cameraKey = (s: RenderSetup) => JSON.stringify(CAMERA_KEYS.map((k) => s[k]));

export function RenexStudio({ source, build, onClose }: Props) {
  const [setup, setSetupState] = useState<RenderSetup>(() => lastSetup(source));
  const [tab, setTab] = useState<Tab>('Scene');
  const [scene, setScene] = useState<RenexSceneSource | null>(null);
  const [err, setErr] = useState('');
  const [prog, setProg] = useState<RenderProgress | null>(null);
  const [live, setLive] = useState('Preparing live view…');
  const [view, setView] = useState<'live' | 'final'>('live');
  const [toast, setToast] = useState('');
  const [ai, setAiState] = useState<AiSettings>(loadAi);
  const [profiles, setProfiles] = useState(() => profilesFor(source));
  const [imported, setImported] = useState<string | null>(null);
  const liveHost = useRef<HTMLDivElement>(null);
  const finalHost = useRef<HTMLDivElement>(null);
  const vp = useRef<RenexViewport | null>(null);
  const eng = useRef<RenexRenderer | null>(null);
  const fromOrbit = useRef(false);
  const supported = useMemo(() => RenexRenderer.supported(), []);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const set = (patch: Partial<RenderSetup>) => setSetupState((s) => { const n = { ...s, ...patch }; rememberSetup(source, n); return n; });
  const setAi = (patch: Partial<AiSettings>) => setAiState((s) => { const n = { ...s, ...patch }; saveAi(n); return n; });
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4000); };

  // read the design once on open (and on "Refresh design"); geometry building yields to the UI first
  const refresh = () => { setImported(null); setTimeout(() => { try { setScene(build()); setErr(''); } catch (e) { setErr(`Could not read the design: ${(e as Error).message}`); } }, 30); };
  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // live viewport: created once, rendered on demand
  useEffect(() => {
    if (!supported || !liveHost.current) return;
    const v = new RenexViewport(liveHost.current, {
      onStatus: setLive,
      onLost: (l) => { if (l) setErr('The browser reset the graphics context; restoring the live view…'); else setErr(''); },
      onCamera: (c) => { fromOrbit.current = true; set(c); },
    });
    vp.current = v;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); } };
    window.addEventListener('keydown', k, true);
    return () => { window.removeEventListener('keydown', k, true); v.dispose(); vp.current = null; eng.current?.dispose(); eng.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  // rebuild the live scene when anything visual changes (debounced); camera-only edits just move the camera
  const sKey = sceneKey(setup), cKey = cameraKey(setup);
  useEffect(() => {
    if (!scene || !vp.current) return;
    const t = setTimeout(() => { vp.current?.setScene(scene, setup, false); }, 120);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, sKey]);
  useEffect(() => {
    if (fromOrbit.current) { fromOrbit.current = false; return; }
    vp.current?.applyCamera(setup);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cKey]);
  // a new design or import reframes to the setup's shot
  useEffect(() => { if (scene) setTimeout(() => vp.current?.applyCamera(setup), 200); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [scene]);

  /** The path tracer lives only while a final render is wanted; its own GPU context is freed afterwards. */
  const tracer = () => {
    if (eng.current && !eng.current.lost) return eng.current;
    eng.current?.dispose();
    const r = new RenexRenderer();
    r.onProgress = setProg;
    r.canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
    finalHost.current?.replaceChildren(r.canvas);
    eng.current = r;
    return r;
  };

  const render = async (q?: Quality) => {
    if (!scene) return;
    const s = q ? { ...setup, quality: q } : setup;
    if (q) set({ quality: q });
    setErr('');
    setView('final');
    try {
      const b = await tracer().renderToCompletion(scene, s, setProg);
      if (b.notes.length) flash(b.notes.join(' '));
    } catch (e) {
      setErr(`Final render failed: ${(e as Error).message} The live view is still available, and "Export" saves it at full resolution.`);
      eng.current?.dispose(); eng.current = null;
      setView('live'); setProg(null);
    }
  };

  const info = (aiUsed = false, realtime = false): DisclosureInfo => ({
    title: scene?.title ?? 'Render', source: imported ? 'Imported model' : source === 'plantex' ? 'Plantex' : 'Lumonex', aiAssisted: aiUsed, aiProvider: aiUsed ? AI_PROVIDERS.find((p) => p.id === ai.provider)?.name : undefined,
    details: [
      `Layer height ${scene?.print.layerHeight ?? 0.2} mm, line width ${scene?.print.lineWidth.toFixed(2) ?? '0.42'} mm`,
      ...(scene?.parts ?? []).map((p) => `${p.name}: ${setup.parts[p.key]?.finish ?? p.finish} ${setup.parts[p.key]?.hex ?? p.hex}`),
      realtime ? 'Real-time raster render (image-based lighting)' : `Path traced, ${QUALITY[setup.quality].name}, ${prog?.samples ?? 0} samples per pixel`,
    ],
  });

  /** Keep a render in the project file (.3mf photos, shown under Project). */
  const saveToProject = async (blob: Blob, name: string) => {
    const dataUrl = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.onerror = rej; fr.readAsDataURL(blob); });
    const { project } = useStore.getState();
    useStore.setState({ project: { ...project, photos: [...project.photos.filter((p) => p.name !== name), { name, dataUrl }] } });
  };

  const download = (blob: Blob, name: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };

  const finalReady = view === 'final' && !!prog?.done && !!eng.current && !eng.current.lost;
  /** The image to export: the finished path-traced render if one is on screen, else the live view at output size. */
  const currentImage = async (s: RenderSetup) => {
    if (finalReady) return { out: await eng.current!.exportImage(s, info(false)), realtime: false };
    const snap = await vp.current!.snapshot(s.width, s.height);
    return { out: await encodeCanvas(snap, s, info(false, true)), realtime: true };
  };

  const exportNow = async () => {
    try {
      const { out, realtime } = await currentImage(setup);
      download(out.blob, out.name);
      if (setup.saveToProject) await saveToProject(out.blob, out.name);
      flash(`Saved ${out.name} (${realtime ? 'real-time' : 'path traced'})${setup.saveToProject ? ', also in the project' : ''} — marked as a computer-generated render${hasDisclosure(out.bytes) ? ' ✓' : ''}.`);
    } catch (e) { setErr((e as Error).message); }
  };

  const exportAi = async () => {
    if (!aiReady(ai)) return;
    try {
      flash('Sending the render to the AI pass…');
      const { out } = await currentImage({ ...setup, format: 'png', watermark: { ...setup.watermark, enabled: false } });
      const enhanced = await aiEnhance(out.blob, ai);
      const bytes = tagImage(new Uint8Array(await enhanced.arrayBuffer()), info(true));
      download(new Blob([bytes], { type: enhanced.type || 'image/png' }), out.name.replace('-renex', '-renex-ai'));
      flash('Saved the AI-enhanced image — metadata marks it as AI-assisted.');
    } catch (e) { setErr((e as Error).message); }
  };

  const [batch, setBatch] = useState<BatchSpec>({ aspects: [], shots: [], light: 'current', mode: 'realtime' });
  const [batchState, setBatchState] = useState<{ i: number; n: number; label: string } | null>(null);
  const batchCancel = useRef(false);
  const runBatch = async () => {
    if (!scene || !vp.current) return;
    const jobs = batchJobs(setup, batch, SHOTS, isLamp);
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    batchCancel.current = false;
    try {
      for (let i = 0; i < jobs.length && !batchCancel.current; i++) {
        const job = jobs[i];
        setBatchState({ i: i + 1, n: jobs.length, label: job.label });
        let out: { blob: Blob; bytes: Uint8Array; name: string };
        if (batch.mode === 'final') {
          const r = tracer();
          setView('final');
          await r.renderToCompletion(scene, job.setup, setProg);
          if (batchCancel.current) break;
          out = await r.exportImage(job.setup, info(false));
        } else {
          vp.current.setScene(scene, job.setup, true);
          vp.current.applyCamera(job.setup);
          await new Promise((r) => setTimeout(r, 30));
          out = await encodeCanvas(await vp.current.snapshot(job.setup.width, job.setup.height), job.setup, info(false, true));
        }
        const name = out.name.replace(/-renex\./, `-${job.label}-renex.`);
        zip.file(name, out.bytes);
        if (setup.saveToProject) await saveToProject(out.blob, name);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      download(blob, `${(scene.title || 'renders').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase()}-renex-batch.zip`);
      flash(`Batch done: ${Object.keys(zip.files).length} image(s) in one zip${setup.saveToProject ? ', also saved in the project' : ''}. Each carries the render disclosure.`);
    } catch (e) { setErr(`Batch failed: ${(e as Error).message}`); }
    finally {
      setBatchState(null);
      if (batch.mode !== 'final') { vp.current?.setScene(scene, setup, true); vp.current?.applyCamera(setup); }
    }
  };

  const onImport = async (f: File | undefined) => {
    if (!f) return;
    setErr('');
    setLive(`Importing ${f.name}…${/\.(step|stp|iges|igs|brep)$/i.test(f.name) ? ' (tessellating the CAD model in the background)' : ''}`);
    try {
      const src = await importModel(f);
      setImported(f.name);
      setView('live'); setProg(null);
      setScene(src);
      flash(`Imported ${f.name}: ${src.parts.length} part(s). Set materials in the Product tab.`);
    } catch (e) { setErr(`Import failed: ${(e as Error).message}`); setLive(''); }
  };

  const pct = prog && prog.target ? Math.min(100, (prog.samples / prog.target) * 100) : 0;
  const isLamp = source === 'lumonex' && !imported;
  const tracing = !!eng.current?.running;

  return createPortal(
    <div className="rx-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rx-win" role="dialog" aria-label="Renex render studio">
        <header className="rx-head">
          <span className="mx-badge">Rx</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="rx-title">Renex · {scene?.title ?? '…'}</div>
            <div className="rx-sub">Real-time PBR view + path-traced final render · {imported ? `imported ${imported}` : isLamp ? 'Lumonex' : 'Plantex'} · {scene ? `${scene.parts.length} part(s), ${scene.print.layerHeight} mm layers` : 'reading design…'}</div>
          </div>
          <label className="btn-secondary rx-file" title={`Render any model: ${IMPORT_EXT.join(' ')}`}>Import model…<input type="file" accept={IMPORT_EXT.join(',')} onChange={(e) => { onImport(e.target.files?.[0]); e.target.value = ''; }} /></label>
          <button className="btn-secondary" onClick={refresh}>{imported ? 'Back to design' : 'Refresh design'}</button>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        <div className="rx-body">
          <aside className="rx-side">
            <div className="seg mx-seg rx-tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
            <div className="rx-panel">
              {tab === 'Scene' && <SceneTab setup={setup} set={set} isLamp={isLamp} />}
              {tab === 'Camera' && <CameraTab setup={setup} set={set} />}
              {tab === 'Product' && <ProductTab setup={setup} set={set} scene={scene} />}
              {tab === 'Props' && (isLamp ? <LampTab setup={setup} set={set} scene={scene} /> : <PlanterTab setup={setup} set={set} scene={scene} />)}
              {tab === 'Output' && <OutputTab setup={setup} set={set} />}
              {tab === 'Output' && <BatchPanel batch={batch} setBatch={setBatch} setup={setup} isLamp={isLamp} running={batchState} disabled={!scene} onRun={runBatch} onCancel={() => { batchCancel.current = true; eng.current?.stop(); }} />}
              {tab === 'Profiles' && <ProfilesTab profiles={profiles} onLoad={(s) => { set(s); flash('Profile loaded'); }} onSave={(n) => { addProfile(n, source, setup); setProfiles(profilesFor(source)); flash(`Saved profile "${n}"`); }} onDelete={(id) => { deleteProfile(id); setProfiles(profilesFor(source)); }} />}
              {tab === 'AI' && <AiTab ai={ai} setAi={setAi} />}
            </div>
          </aside>
          <main className="rx-centre">
            <div className="rx-stage" style={{ aspectRatio: `${setup.width} / ${setup.height}` }}>
              <div ref={liveHost} className="rx-layer" style={{ visibility: view === 'live' ? 'visible' : 'hidden' }} />
              <div ref={finalHost} className="rx-layer" style={{ visibility: view === 'final' ? 'visible' : 'hidden' }} />
              {!supported && <div className="rx-msg">Renex needs WebGL 2. Update your graphics driver or browser.</div>}
              {supported && !scene && <div className="rx-msg">Reading the design…</div>}
            </div>
            <div className="rx-bar">
              <div className="seg mx-seg rx-viewseg">
                <button className={view === 'live' ? 'on' : ''} onClick={() => setView('live')}>Live</button>
                <button className={view === 'final' ? 'on' : ''} disabled={!eng.current} onClick={() => setView('final')}>Final</button>
              </div>
              <span className="rx-dim">Final render:</span>
              {(Object.keys(QUALITY) as Quality[]).map((q) => (
                <button key={q} className={`btn-small ${setup.quality === q && view === 'final' ? 'btn-primary' : 'btn-secondary'}`} disabled={!scene || tracing} onClick={() => render(q)} title={QUALITY[q].note}>
                  {QUALITY[q].name} <span className="rx-dim">· {QUALITY[q].samples} spp</span>
                </button>
              ))}
              <span style={{ flex: 1 }} />
              {tracing ? <button className="btn-secondary btn-small" onClick={() => { eng.current?.stop(); setProg((p) => p && { ...p, stage: 'Stopped' }); }}>Stop</button>
                : view === 'final' && prog && <button className="btn-secondary btn-small" onClick={() => eng.current?.more(QUALITY[setup.quality].samples)}>Refine +{QUALITY[setup.quality].samples}</button>}
              <button className="btn-primary btn-small" disabled={!scene || tracing} onClick={exportNow} title={finalReady ? 'Export the path-traced render' : 'Export the live view at full output resolution (instant)'}>Export {setup.format.toUpperCase()}{finalReady ? '' : ' (real-time)'}</button>
              {aiReady(ai) && <button className="btn-secondary btn-small" disabled={!scene || tracing} onClick={exportAi}>Export with AI pass</button>}
            </div>
            <div className="rx-progress"><i style={{ width: `${view === 'final' ? pct : 0}%` }} /></div>
            <div className="rx-status">
              {batchState ? `Batch ${batchState.i}/${batchState.n} (${batchState.label}) · ` : ''}
              {view === 'final' && prog ? `${prog.stage} · ${prog.samples}/${prog.target} samples · ${prog.elapsed.toFixed(1)} s${prog.done ? '' : ` · ~${Math.ceil(prog.eta)} s left`} · ${setup.width}×${setup.height}` : `${live} · drag to orbit, scroll to zoom`}
              {scene?.warnings.length ? <span className="rx-warn"> · {scene.warnings[0]}</span> : null}
            </div>
            {err && <div className="rx-err">{err}</div>}
          </main>
        </div>
        {toast && <div className="rx-toast">{toast}</div>}
      </div>
    </div>,
    document.body,
  );
}

type TabProps = { setup: RenderSetup; set: (p: Partial<RenderSetup>) => void };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="rx-row"><span>{label}</span><div>{children}</div></label>;
}
function Slider({ v, min, max, step, on, fmt }: { v: number; min: number; max: number; step: number; on: (n: number) => void; fmt?: (n: number) => string }) {
  return <span className="rx-slider"><input type="range" min={min} max={max} step={step} value={v} onChange={(e) => on(+e.target.value)} /><em>{fmt ? fmt(v) : v}</em></span>;
}
function Sel<T extends string>({ v, opts, on }: { v: T; opts: { id: T; name: string }[]; on: (v: T) => void }) {
  return <select className="input" value={v} onChange={(e) => on(e.target.value as T)}>{opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>;
}

function SceneTab({ setup, set, isLamp }: TabProps & { isLamp: boolean }) {
  const envs = [...ENVIRONMENTS].sort((a, b) => Number(!!b.forLamps === isLamp) - Number(!!a.forLamps === isLamp));
  return <>
    <h4>Lighting</h4>
    <Row label="Environment"><Sel v={setup.env} opts={envs} on={(env) => set({ env })} /></Row>
    <Row label="Rotate light"><Slider v={setup.envRotation} min={-180} max={180} step={5} on={(envRotation) => set({ envRotation })} fmt={(n) => `${n}°`} /></Row>
    <Row label="Auto exposure"><input type="checkbox" checked={setup.autoExposure} onChange={(e) => set({ autoExposure: e.target.checked })} /><span className="rx-dim">{setup.autoExposure ? 'metered on the product' : `fixed EV ${ENVIRONMENTS.find((x) => x.id === setup.env)?.ev}`}</span></Row>
    <Row label="Exposure"><Slider v={setup.evComp} min={-4} max={4} step={0.25} on={(evComp) => set({ evComp })} fmt={(n) => `${n > 0 ? '+' : ''}${n} EV`} /></Row>
    <Row label="Tone curve"><Sel v={setup.toneMap} opts={[{ id: 'agx', name: 'AgX (film-like)' }, { id: 'aces', name: 'ACES filmic' }, { id: 'neutral', name: 'Khronos neutral' }]} on={(toneMap) => set({ toneMap })} /></Row>
    <h4>Set</h4>
    <Row label="Backdrop"><Sel v={setup.backdrop} opts={BACKDROPS} on={(backdrop) => set({ backdrop })} /></Row>
    <Row label="Paper / wall colour"><input type="color" value={setup.backdropColour} onChange={(e) => set({ backdropColour: e.target.value })} /></Row>
    <Row label="Transparent background"><input type="checkbox" checked={setup.transparent} onChange={(e) => set({ transparent: e.target.checked })} /></Row>
    <p className="rx-hint">Lighting is in real units (sky and walls in nits, sun in lux, bulbs in lumens) with photographic exposure, so a lamp-lit night scene and a sunny windowsill expose like a camera would.</p>
  </>;
}

function CameraTab({ setup, set }: TabProps) {
  return <>
    <h4>Shot</h4>
    <div className="rx-chips">{SHOTS.map((s) => <button key={s.id} className={`btn-small ${setup.shot === s.id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => set({ shot: s.id, az: s.az, el: s.el, focal: s.focal, fNumber: s.fNumber, dolly: 1 })}>{s.name}</button>)}</div>
    <Row label="Orbit"><Slider v={setup.az} min={-180} max={180} step={1} on={(az) => set({ az })} fmt={(n) => `${n}°`} /></Row>
    <Row label="Height"><Slider v={setup.el} min={-10} max={89} step={1} on={(el) => set({ el })} fmt={(n) => `${n}°`} /></Row>
    <Row label="Distance"><Slider v={setup.dolly} min={0.4} max={2.5} step={0.05} on={(dolly) => set({ dolly })} fmt={(n) => `${n.toFixed(2)}×`} /></Row>
    <h4>Lens (full-frame)</h4>
    <Row label="Focal length"><Slider v={setup.focal} min={24} max={200} step={1} on={(focal) => set({ focal })} fmt={(n) => `${n} mm`} /></Row>
    <Row label="Aperture"><Slider v={setup.fNumber} min={1.4} max={22} step={0.1} on={(fNumber) => set({ fNumber })} fmt={(n) => `f/${n.toFixed(1)}`} /></Row>
    <Row label="Focus height"><Slider v={setup.focusZ} min={-1} max={1} step={0.05} on={(focusZ) => set({ focusZ })} fmt={(n) => (n === 0 ? 'centre' : n > 0 ? `${Math.round(n * 100)}% up` : `${Math.round(-n * 100)}% down`)} /></Row>
    <Row label="Aperture blades"><Slider v={setup.blades} min={0} max={12} step={1} on={(blades) => set({ blades })} fmt={(n) => (n ? `${n}` : 'round')} /></Row>
    <p className="rx-hint">Depth of field is a real thin-lens model: the aperture diameter is focal length ÷ f-number, at true product scale.</p>
  </>;
}

function ProductTab({ setup, set, scene }: TabProps & { scene: RenexSceneSource | null }) {
  const [brand, setBrand] = useState(SWATCH_BRANDS[0]);
  const look = (k: string) => setup.parts[k] ?? {};
  const setLook = (k: string, p: Partial<RenderSetup['parts'][string]>) => set({ parts: { ...setup.parts, [k]: { ...look(k), ...p } } });
  return <>
    <h4>Print appearance</h4>
    <Row label="Supports"><Sel v={setup.supports} opts={[{ id: 'off', name: 'None' }, { id: 'attached', name: 'Attached (as printed)' }, { id: 'removed', name: 'Removed (support scars)' }]} on={(supports) => set({ supports })} /></Row>
    <Row label="Seam"><Sel v={setup.seam} opts={[{ id: 'from-settings', name: `From print settings${scene ? ` (${scene.print.seam})` : ''}` }, { id: 'aligned', name: 'Aligned' }, { id: 'back', name: 'Back' }, { id: 'nearest', name: 'Nearest' }, { id: 'random', name: 'Random' }]} on={(seam) => set({ seam })} /></Row>
    <Row label="Layer lines"><Slider v={setup.layerLines} min={0} max={2} step={0.05} on={(layerLines) => set({ layerLines })} fmt={(n) => (n === 1 ? 'true to print' : `${n.toFixed(2)}×`)} /></Row>
    <Row label="Bed side"><Sel v={setup.texturedBed ? 'tex' : 'smooth'} opts={[{ id: 'tex', name: 'Textured PEI' }, { id: 'smooth', name: 'Smooth plate (glossy)' }]} on={(v) => set({ texturedBed: v === 'tex' })} /></Row>
    {scene && <p className="rx-hint">From your profile: {scene.print.layerHeight} mm layers, {scene.print.firstLayerHeight} mm first layer, {scene.print.lineWidth.toFixed(2)} mm walls. Layer lines, seam, top-skin lines and elephant's foot follow these.</p>}
    <h4>Layout</h4>
    <Row label="Arrangement"><Sel v={setup.layout} opts={[{ id: 'assembled', name: 'Assembled' }, { id: 'exploded', name: 'Exploded' }, { id: 'parts', name: 'Printed parts laid out' }, { id: 'custom', name: 'Assembled + my offsets' }]} on={(layout) => set({ layout })} /></Row>
    <h4>Parts</h4>
    <Row label="Swatch brand"><select className="input" value={brand} onChange={(e) => setBrand(e.target.value)}>{SWATCH_BRANDS.map((b) => <option key={b}>{b}</option>)}</select></Row>
    {scene?.parts.map((p) => {
      const l = look(p.key);
      return (
        <div key={p.key} className="rx-part">
          <div className="rx-part-head"><i style={{ background: l.hex ?? p.hex }} /><b>{p.name}</b><span className="rx-dim">{p.materialName}</span>
            <label className="rx-inline"><input type="checkbox" checked={!l.hidden} onChange={(e) => setLook(p.key, { hidden: !e.target.checked })} /> show</label></div>
          <Row label="Material"><select className="input" value={l.finish ?? p.finish} onChange={(e) => setLook(p.key, { finish: e.target.value as FinishKind })}>{FINISH_KINDS.map((f) => <option key={f}>{f}</option>)}</select></Row>
          <Row label="Colour"><input type="color" value={l.hex ?? p.hex} onChange={(e) => setLook(p.key, { hex: e.target.value })} />
            {(l.hex || l.finish) && <button className="btn-small btn-secondary" onClick={() => setLook(p.key, { hex: undefined, finish: undefined })}>Use filament</button>}</Row>
          <div className="rx-swatches">{ALL_SWATCHES.filter((s) => s.brand === brand).map((s) => <button key={`${s.line}-${s.name}`} title={`${s.brand} ${s.line} · ${s.name}`} style={{ background: s.hex }} onClick={() => setLook(p.key, { hex: s.hex, finish: s.finish })} />)}</div>
          {(setup.layout === 'custom' || setup.layout === 'parts') && <>
            <Row label="Move X / Y / Z (mm)"><span className="rx-xyz">{[0, 1, 2].map((a) => <input key={a} className="input" type="number" value={(l.offset ?? [0, 0, 0])[a]} onChange={(e) => { const o = [...(l.offset ?? [0, 0, 0])] as [number, number, number]; o[a] = +e.target.value; setLook(p.key, { offset: o }); }} />)}</span></Row>
            <Row label="Turn"><Slider v={l.spin ?? 0} min={-180} max={180} step={5} on={(spin) => setLook(p.key, { spin })} fmt={(n) => `${n}°`} /></Row>
          </>}
        </div>
      );
    })}
  </>;
}

function PlanterTab({ setup, set, scene }: TabProps & { scene: RenexSceneSource | null }) {
  const [cat, setCat] = useState<PlantCategory | 'All'>('All');
  const [q, setQ] = useState('');
  const list = PLANTS.filter((p) => (cat === 'All' || p.category === cat) && `${p.name} ${p.latin}`.toLowerCase().includes(q.toLowerCase()));
  const vase = scene?.planter?.kind === 'vase';
  return <>
    <h4>Plants ({setup.plants.length})</h4>
    {setup.plants.map((pk, i) => {
      const d = PLANTS.find((p) => p.id === pk.id);
      return <div key={i} className="rx-plant">
        <b>{d?.name ?? pk.id}</b>
        <Slider v={pk.scale} min={0.4} max={2} step={0.05} on={(scale) => set({ plants: setup.plants.map((x, j) => (j === i ? { ...x, scale } : x)) })} fmt={(n) => `${n.toFixed(2)}×`} />
        <button className="btn-small btn-secondary" title="Another specimen of the same plant" onClick={() => set({ plants: setup.plants.map((x, j) => (j === i ? { ...x, seed: x.seed + 1 } : x)) })}>↻</button>
        <button className="btn-small btn-secondary" onClick={() => set({ plants: setup.plants.filter((_, j) => j !== i) })}>✕</button>
      </div>;
    })}
    {!setup.plants.length && <p className="rx-hint">No plant: the {vase ? 'vase' : 'planter'} renders empty{vase ? '' : ' with soil'}.</p>}
    <div className="rx-plantfilter">
      <input className="input" placeholder={`Search ${PLANTS.length} plants…`} value={q} onChange={(e) => setQ(e.target.value)} />
      <select className="input" value={cat} onChange={(e) => setCat(e.target.value as PlantCategory | 'All')}><option>All</option>{PLANT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
    </div>
    <div className="rx-plantlist">
      {list.map((p) => <button key={p.id} className="rx-plantitem" onClick={() => set({ plants: [...setup.plants, { id: p.id, scale: 1, seed: 1 }] })}>
        <i style={{ background: `linear-gradient(135deg, ${p.leaf}, ${p.flower ?? p.leaf2 ?? p.leaf})` }} />
        <span><b>{p.name}</b><em>{p.latin} · {p.category}</em></span>
      </button>)}
    </div>
    {!vase && <>
      <h4>Soil</h4>
      <Row label="Top dressing"><Sel v={setup.dressing} opts={TOP_DRESSINGS} on={(dressing) => set({ dressing })} /></Row>
      <Row label="Moisture"><Slider v={setup.moisture} min={0} max={1} step={0.05} on={(moisture) => set({ moisture })} fmt={(n) => (n < 0.2 ? 'dry' : n < 0.6 ? 'moist' : 'just watered')} /></Row>
      {scene?.planter?.saucer && <Row label="Water in saucer"><input type="checkbox" checked={setup.saucerWater} onChange={(e) => set({ saucerWater: e.target.checked })} /></Row>}
    </>}
  </>;
}

function LampTab({ setup, set, scene }: TabProps & { scene: RenexSceneSource | null }) {
  const lamp = scene?.lamp;
  return <>
    <h4>Light</h4>
    <div className="rx-chips">
      <button className={`btn-small ${setup.lit ? 'btn-primary' : 'btn-secondary'}`} onClick={() => set({ lit: true })}>💡 On</button>
      <button className={`btn-small ${!setup.lit ? 'btn-primary' : 'btn-secondary'}`} onClick={() => set({ lit: false })}>Off</button>
    </div>
    {lamp && <p className="rx-hint">{lamp.bulb ? lamp.bulb.name : lamp.puck ? `LED puck Ø${lamp.puck.diameter} mm` : 'No light source'} · {lamp.watts} W ≈ {Math.round(lamp.watts * 110)} lm. Light is traced through the shade: translucent filament glows and scatters, opaque parts cast real shadows.</p>}
    <Row label="Colour temperature"><Slider v={setup.kelvin} min={1800} max={6500} step={100} on={(kelvin) => set({ kelvin })} fmt={(n) => `${n} K`} /></Row>
    <Row label="Bulb glass"><Sel v={setup.glass} opts={[{ id: 'clear', name: 'Clear (visible LED filaments)' }, { id: 'opal', name: 'Opal / frosted' }, { id: 'amber', name: 'Amber vintage' }]} on={(glass) => set({ glass })} /></Row>
    <h4>Hardware</h4>
    <Row label="Holder"><Sel v={setup.holderFinish} opts={[{ id: 'bakelite', name: 'Black bakelite' }, { id: 'ceramic', name: 'White porcelain' }, { id: 'brass', name: 'Brass' }]} on={(holderFinish) => set({ holderFinish })} /></Row>
    <Row label="Cord"><Sel v={setup.cordFabric} opts={[{ id: 'braided', name: 'Fabric braided' }, { id: 'twisted', name: 'Twisted fabric' }, { id: 'pvc', name: 'PVC' }]} on={(cordFabric) => set({ cordFabric })} /></Row>
    <Row label="Cord colour"><input type="color" value={setup.cordColour} onChange={(e) => set({ cordColour: e.target.value })} /></Row>
    {lamp?.cordEnd === 'plug' && <Row label="Plug"><Sel v={setup.plug} opts={[{ id: 'eu', name: 'EU (Schuko)' }, { id: 'uk', name: 'UK (BS 1363)' }, { id: 'us', name: 'US (NEMA 1-15)' }, { id: 'in', name: 'India (Type D)' }, { id: 'none', name: 'Hidden' }]} on={(plug) => set({ plug })} /></Row>}
    {lamp?.foot && <Row label="Felt pads"><input type="checkbox" checked={setup.feltPads} onChange={(e) => set({ feltPads: e.target.checked })} /></Row>}
  </>;
}

function OutputTab({ setup, set }: TabProps) {
  return <>
    <h4>Size</h4>
    <Row label="Format"><select className="input" value={setup.aspect} onChange={(e) => { const a = ASPECTS.find((x) => x.id === e.target.value)!; set(a.id === 'custom' ? { aspect: a.id } : { aspect: a.id, width: a.w, height: a.h }); }}>{ASPECTS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Row>
    <Row label="Width × height (px)"><span className="rx-xyz"><input className="input" type="number" min={256} max={8192} value={setup.width} onChange={(e) => set({ width: +e.target.value, aspect: 'custom' })} /><input className="input" type="number" min={256} max={8192} value={setup.height} onChange={(e) => set({ height: +e.target.value, aspect: 'custom' })} /></span></Row>
    <h4>Quality</h4>
    {(Object.keys(QUALITY) as Quality[]).map((q) => <label key={q} className="rx-radio"><input type="radio" checked={setup.quality === q} onChange={() => set({ quality: q })} /><b>{QUALITY[q].name}</b> <span className="rx-dim">{QUALITY[q].samples} samples · {QUALITY[q].bounces} bounces · {QUALITY[q].note}</span></label>)}
    <Row label="Denoise"><input type="checkbox" checked={setup.denoise} onChange={(e) => set({ denoise: e.target.checked })} /></Row>
    <h4>File</h4>
    <Row label="Type"><Sel v={setup.format} opts={[{ id: 'png', name: 'PNG (lossless)' }, { id: 'jpeg', name: 'JPEG' }]} on={(format) => set({ format })} /></Row>
    {setup.format === 'jpeg' && <Row label="JPEG quality"><Slider v={setup.jpegQuality} min={0.6} max={1} step={0.01} on={(jpegQuality) => set({ jpegQuality })} fmt={(n) => `${Math.round(n * 100)}`} /></Row>}
    <Row label="Save into project"><input type="checkbox" checked={setup.saveToProject} onChange={(e) => set({ saveToProject: e.target.checked })} /><span className="rx-dim">stored with the .3mf (Project → Photos)</span></Row>
    <h4>Watermark (optional)</h4>
    <Row label="Show"><input type="checkbox" checked={setup.watermark.enabled} onChange={(e) => set({ watermark: { ...setup.watermark, enabled: e.target.checked } })} /></Row>
    {setup.watermark.enabled && <>
      <Row label="Text"><input className="input" value={setup.watermark.text} onChange={(e) => set({ watermark: { ...setup.watermark, text: e.target.value } })} /></Row>
      <Row label="Corner"><Sel v={setup.watermark.corner} opts={[{ id: 'br', name: 'Bottom right' }, { id: 'bl', name: 'Bottom left' }, { id: 'tr', name: 'Top right' }, { id: 'tl', name: 'Top left' }]} on={(corner) => set({ watermark: { ...setup.watermark, corner } })} /></Row>
      <Row label="Opacity"><Slider v={setup.watermark.opacity} min={0.1} max={1} step={0.05} on={(opacity) => set({ watermark: { ...setup.watermark, opacity } })} /></Row>
      <Row label="Size"><Slider v={setup.watermark.size} min={0.5} max={3} step={0.1} on={(size) => set({ watermark: { ...setup.watermark, size } })} /></Row>
    </>}
    <p className="rx-hint">Every export carries a disclosure in its metadata: IPTC Digital Source Type “digital creation” (the field platforms read for content labels), an XMP/EXIF description saying it is a computer-generated render of a 3D-printable design and not a photograph, and “AI-assisted” when the AI pass was used.</p>
  </>;
}

function ProfilesTab({ profiles, onLoad, onSave, onDelete }: { profiles: ReturnType<typeof profilesFor>; onLoad: (s: RenderSetup) => void; onSave: (name: string) => void; onDelete: (id: string) => void }) {
  const [name, setName] = useState('');
  return <>
    <h4>Save this setup</h4>
    <div className="rx-plantfilter"><input className="input" placeholder="Profile name" value={name} onChange={(e) => setName(e.target.value)} /><button className="btn-primary btn-small" disabled={!name.trim()} onClick={() => { onSave(name.trim()); setName(''); }}>Save</button></div>
    <h4>Profiles</h4>
    {profiles.map((p) => <div key={p.id} className="rx-profile">
      <span><b>{p.name}</b><em>{p.createdAt ? 'yours' : 'built-in'} · {ENVIRONMENTS.find((e) => e.id === p.setup.env)?.name} · {p.setup.width}×{p.setup.height}</em></span>
      <button className="btn-small btn-secondary" onClick={() => onLoad(p.setup)}>Load</button>
      {p.createdAt > 0 && <button className="btn-small btn-secondary" onClick={() => onDelete(p.id)}>✕</button>}
    </div>)}
  </>;
}

function AiTab({ ai, setAi }: { ai: AiSettings; setAi: (p: Partial<AiSettings>) => void }) {
  const prov = AI_PROVIDERS.find((p) => p.id === ai.provider)!;
  return <>
    <p className="rx-hint">Renex is a physically based renderer and needs no AI. This optional pass sends a finished render to an image model of your choice, using your own key. It is off until you enable it, and images that went through it are labelled AI-assisted in their metadata.</p>
    <Row label="Enable AI pass"><input type="checkbox" checked={ai.enabled} onChange={(e) => setAi({ enabled: e.target.checked })} /></Row>
    <Row label="Provider"><Sel v={ai.provider} opts={AI_PROVIDERS} on={(provider) => setAi({ provider })} /></Row>
    <p className="rx-hint">{prov.note}</p>
    <Row label="API key"><input className="input" type="password" placeholder={prov.keyHint} value={ai.keys[ai.provider] ?? ''} onChange={(e) => setAi({ keys: { ...ai.keys, [ai.provider]: e.target.value } })} /></Row>
    {ai.provider === 'replicate' && <Row label="Model version"><input className="input" value={ai.model} onChange={(e) => setAi({ model: e.target.value })} /></Row>}
    {ai.provider === 'custom' && <Row label="Endpoint URL"><input className="input" value={ai.endpoint} onChange={(e) => setAi({ endpoint: e.target.value })} /></Row>}
    <Row label="Strength"><Slider v={ai.strength} min={0} max={1} step={0.05} on={(strength) => setAi({ strength })} fmt={(n) => (n < 0.3 ? `${n.toFixed(2)} subtle` : n.toFixed(2))} /></Row>
    <Row label="Prompt"><textarea className="input" rows={4} value={ai.prompt} onChange={(e) => setAi({ prompt: e.target.value })} /></Row>
    <p className="rx-hint">Keys stay on this device (local storage). They are never saved in projects or images.</p>
  </>;
}

function BatchPanel({ batch, setBatch, setup, isLamp, running, disabled, onRun, onCancel }: { batch: BatchSpec; setBatch: (b: BatchSpec) => void; setup: RenderSetup; isLamp: boolean; running: { i: number; n: number } | null; disabled: boolean; onRun: () => void; onCancel: () => void }) {
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const n = Math.max(1, batch.aspects.length) * Math.max(1, batch.shots.length) * (isLamp && batch.light === 'both' ? 2 : 1);
  return <>
    <h4>Batch export</h4>
    <p className="rx-hint">Renders every combination below with the current scene and downloads one zip. Nothing ticked = the current size / shot.</p>
    <div className="rx-batch"><b>Quality</b>
      <label className="rx-inline"><input type="radio" checked={batch.mode !== 'final'} onChange={() => setBatch({ ...batch, mode: 'realtime' })} />Real-time (instant, live-view quality)</label>
      <label className="rx-inline"><input type="radio" checked={batch.mode === 'final'} onChange={() => setBatch({ ...batch, mode: 'final' })} />Path traced at {QUALITY[setup.quality].name}</label>
    </div>
    <div className="rx-batch">
      <b>Sizes</b>
      {ASPECTS.filter((a) => a.id !== 'custom').map((a) => <label key={a.id} className="rx-inline"><input type="checkbox" checked={batch.aspects.includes(a.id)} onChange={() => setBatch({ ...batch, aspects: toggle(batch.aspects, a.id) })} />{a.name}</label>)}
      <b>Shots</b>
      {SHOTS.map((s) => <label key={s.id} className="rx-inline"><input type="checkbox" checked={batch.shots.includes(s.id)} onChange={() => setBatch({ ...batch, shots: toggle<ShotId>(batch.shots, s.id) })} />{s.name}</label>)}
      {isLamp && <><b>Light</b>
        <label className="rx-inline"><input type="radio" checked={batch.light === 'current'} onChange={() => setBatch({ ...batch, light: 'current' })} />As set ({setup.lit ? 'on' : 'off'})</label>
        <label className="rx-inline"><input type="radio" checked={batch.light === 'both'} onChange={() => setBatch({ ...batch, light: 'both' })} />Both on and off</label></>}
    </div>
    {running ? <button className="btn-secondary btn-small" onClick={onCancel}>Cancel batch ({running.i}/{running.n})</button>
      : <button className="btn-primary btn-small" disabled={disabled} onClick={onRun}>Batch render {n} image{n > 1 ? 's' : ''}</button>}
  </>;
}
