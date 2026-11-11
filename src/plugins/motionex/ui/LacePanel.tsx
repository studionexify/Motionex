// Lace card in the Motionex panel: openwork holes cut into the walls by the toolpath, printable without
// support (hole tops close in points, short gaps bridge). Pattern or picture, cell size, strand, grading,
// twist, printability limits and the last slice's checks.
import { useMemo, useRef, useState } from 'react';
import { useStore } from '../../../state/store';
import { currentConfig } from '../../../state/slicing';
import { centreOnBed } from '../../../state/ops';
import { objectFromWorld } from '../../../state/tools';
import { weld } from '../../../engine/mesh';
import { changed, mx, useMx } from './MotionexPanel';
import { loadPicture, partSize, solidCylinder } from './WeavePanel';
import type { MotionexReport } from '../engine';
import { defaultLace, type LaceSettings } from '../lace/model';
import { LACE_PATTERNS, lacePattern, patternOpen } from '../lace/patterns';
import { lacePrintSettings } from '../lace/plan';
import { greyLevels, gridFor, resampleRGB, type Dither } from '../weave/image';

let source: { rgba: Uint8ClampedArray; w: number; h: number; name: string } | null = null;

/** Picture mode: the picture as open (dark) and solid (light) at its grid size. */
function rebuild(l: LaceSettings) {
  if (l.source !== 'image' || !source) return;
  const rgb = resampleRGB(source.rgba, source.w, source.h, l.image.w, l.image.h);
  l.image = { w: l.image.w, h: l.image.h, px: greyLevels(rgb, l.image.w, l.image.h, 2, (l.picture?.dither ?? 'none') as Dither, l.picture?.invert), name: source.name };
}

function fit(l: LaceSettings) {
  const { around, top } = partSize(l);
  if (!around) return;
  const band = Math.max(1, Math.min(l.z_end, top - l.rim_mm) - l.z_start);
  const px = l.picture?.pixel_mm ?? 2;
  const g = gridFor(around, band, px, px, source ? source.h / source.w : 0, l.tiles_around);
  l.image = { ...l.image, w: g.w, h: g.h };
  rebuild(l);
}

function addTestTube() {
  const s = useStore.getState();
  const o = centreOnBed(objectFromWorld('Lace test cylinder', weld(solidCylinder(25, 40))), s.printerId);
  s.addObjects([o]);
  const l = mx.lace;
  l.enabled = true; l.objects = [o.id]; l.z_start = 4; l.z_end = 1e4; l.rim_mm = 4;
  changed();
}

const upd = (f: () => void) => { f(); changed(); };

export function LaceCard() {
  useMx();
  const l = mx.lace;
  const { objects, selected } = useStore();
  void objects;
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try { source = await loadPicture(f); l.source = 'image'; l.picture = { ...(l.picture ?? { kind: 'image' }), kind: 'image' }; fit(l); changed(); } finally { setBusy(false); }
  };
  if (!l.enabled) {
    return (
      <section className="mx-card">
        <div className="mx-card-title">Lace walls<span className="spacer" />
          <button className="toggle" aria-label="Turn on" title="Turn on" onClick={() => upd(() => { l.enabled = true; })} />
        </div>
        <p className="mx-muted" style={{ margin: 0 }}>Cut openwork holes into the walls: lattices, gothic arches, Voronoi or your own picture. Every hole closes in a point or a short bridge, so it prints without support on any printer.</p>
      </section>
    );
  }
  const pat = lacePattern(l.pattern);
  const cfg = currentConfig();
  const nozzle = Number(cfg.nozzle_diameter) || 0.4;
  const lw = Number(cfg.outer_wall_line_width) || Number(cfg.line_width) || nozzle * 1.05;
  const strand = l.source === 'pattern' ? l.strand_mm : Math.max(l.min_strand_mm, l.picture?.pixel_mm ?? 2);
  const thin = strand < 2 * lw;
  const rLen = Number(cfg.retraction_length) || 0, bowden = rLen >= 2;
  const { around } = partSize(l);
  const cellW = l.source === 'pattern' ? l.cell_w : 2 * (l.picture?.pixel_mm ?? 2);
  const walls = l.walls === 'all' ? Math.max(1, Math.round(Number(cfg.wall_loops) || 2)) : 1;
  const perLayer = around ? Math.max(1, Math.round(around / Math.max(1, cellW))) * walls : 0;
  const busyRetract = l.retract && rLen > 0 && perLayer > (bowden ? 60 : 120);
  const bowdenCell = Math.min(80, Math.ceil(Math.max(cellW, (around * walls) / 60) * 2) / 2);
  return (
    <section className="mx-card">
      <div className="mx-card-title">Lace walls<span className="spacer" />
        <button className="toggle on" aria-label="Lace on" title="Turn lace off" onClick={() => upd(() => { l.enabled = false; })} />
      </div>
      <div className="seg mx-seg">
        <button className={l.source === 'pattern' ? 'on' : ''} onClick={() => upd(() => { l.source = 'pattern'; })}>Pattern</button>
        <button className={l.source === 'image' ? 'on' : ''} onClick={() => (source || l.image.name !== 'Checker' ? upd(() => { l.source = 'image'; }) : fileRef.current?.click())}>Picture</button>
      </div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/bmp" style={{ display: 'none' }} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
      {l.source === 'pattern' ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 4 }}>
            {LACE_PATTERNS.map((p) => (
              <button key={p.id} title={p.description} onClick={() => upd(() => { l.pattern = p.id; })}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 2, padding: 3, minWidth: 0, height: 'auto', cursor: 'pointer', borderRadius: 6, background: 'var(--panel-2, #f4f1ec)', border: l.pattern === p.id ? '2px solid var(--accent, #e8457c)' : '1px solid var(--border, #ddd)', color: 'inherit' }}>
                <Swatch l={{ ...l, pattern: p.id }} />
                <span style={{ fontSize: 10, lineHeight: 1.15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
              </button>
            ))}
          </div>
          <p className="mx-muted" style={{ margin: 0 }}>{pat.description}</p>
          <div className="mx-two">
            <label className="mx-field">Cell width (mm)<input className="input" type="number" min={2} max={80} step={0.5} value={l.cell_w} onChange={(e) => upd(() => { l.cell_w = Math.max(2, +e.target.value || 8); })} /></label>
            <label className="mx-field">Cell height (mm)<input className="input" type="number" min={2} max={80} step={0.5} value={l.cell_h} onChange={(e) => upd(() => { l.cell_h = Math.max(2, +e.target.value || 10); })} /></label>
          </div>
          <label className="mx-field">Strand: {l.strand_mm.toFixed(1)} mm of lace between holes
            <input type="range" min={0.8} max={6} step={0.1} value={l.strand_mm} onChange={(e) => upd(() => { l.strand_mm = +e.target.value; })} />
          </label>
          <label className="mx-field">Hole size: {Math.round(l.open * 100)}%
            <input type="range" min={0.2} max={1} step={0.05} value={l.open} onChange={(e) => upd(() => { l.open = +e.target.value; })} />
          </label>
          <label className="mx-field">Grade: {l.grade === 0 ? 'even' : l.grade > 0 ? `holes grow ${Math.round(l.grade * 100)}% up` : `holes shrink ${Math.round(-l.grade * 100)}% up`}
            <input type="range" min={-1} max={1} step={0.05} value={l.grade} onChange={(e) => upd(() => { l.grade = +e.target.value; })} />
          </label>
          <label className="mx-field">Twist: {l.twist_deg ? `${l.twist_deg}° over the band` : 'straight'}
            <input type="range" min={-180} max={180} step={5} value={l.twist_deg} onChange={(e) => upd(() => { l.twist_deg = +e.target.value; })} />
          </label>
          {l.pattern === 'voronoi' && <button className="btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => upd(() => { l.seed = (l.seed * 7 + 13) % 997; })}>New Voronoi cells</button>}
        </>
      ) : (
        <>
          <div className="row" style={{ gap: 6, margin: 0 }}>
            <button className="btn-secondary btn-small" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Reading…' : source ? `Picture: ${source.name}` : 'Import picture…'}</button>
            <label className="row" style={{ gap: 6, margin: 0, fontSize: 12 }}>
              <input type="checkbox" checked={!!l.picture?.invert} onChange={(e) => upd(() => { l.picture = { ...(l.picture ?? { kind: 'image' }), invert: e.target.checked }; rebuild(l); })} /> Light = open
            </label>
          </div>
          <PictureView l={l} />
          <div className="mx-two">
            <label className="mx-field">Pixel (mm)<input className="input" type="number" min={0.6} max={20} step={0.2} value={l.picture?.pixel_mm ?? 2} onChange={(e) => upd(() => { l.picture = { ...(l.picture ?? { kind: 'image' }), pixel_mm: Math.max(0.6, +e.target.value || 2) }; fit(l); })} /></label>
            <label className="mx-field">Times round<input className="input" type="number" min={1} max={24} value={l.tiles_around} onChange={(e) => upd(() => { l.tiles_around = Math.max(1, Math.round(+e.target.value || 1)); fit(l); })} /></label>
          </div>
          <p className="mx-muted" style={{ margin: 0 }}>Dark is open. Silhouettes and line art work best; the printability rule draws every flat top into a point.</p>
        </>
      )}

      <div className="mx-card" style={{ padding: 8, gap: 2 }}>
        <div className="mx-check"><span className={thin ? 'bad' : 'ok'}>{thin ? '!' : '✓'}</span>Strand {strand.toFixed(1)} mm = {(strand / lw).toFixed(1)} line widths ({lw.toFixed(2)} mm line, {nozzle} mm nozzle){thin ? ` — under 2 lines the strands print as single threads and snap: use ${(2 * lw).toFixed(1)} mm or more` : ''}</div>
        {around > 0 && <div className="mx-check"><span className={busyRetract ? 'bad' : 'ok'}>⇄</span>≈ {perLayer} hole crossings per layer ({Math.round(around)} mm round ÷ {cellW.toFixed(1)} mm cells × {walls} wall{walls > 1 ? 's' : ''}){l.retract && rLen > 0 ? `, each a ${rLen} mm retraction` : ', no retraction'}</div>}
        {!around && <div className="mx-check"><span className="ok">⇄</span>Put a part on the plate to see the retractions per layer</div>}
        {bowden && (
          <>
            <p className="mx-muted" style={{ margin: 0 }}>Bowden extruder ({rLen} mm retraction): every hole pulls the filament back a long way, which is slow and can grind it after a few thousand crossings. Use bigger cells{l.source === 'pattern' && bowdenCell > l.cell_w ? ` (≈ ${bowdenCell} mm)` : ''} or turn retraction across holes off for PLA, which hardly strings over short gaps.</p>
            <div className="row" style={{ gap: 6, margin: 0, flexWrap: 'wrap' }}>
              {l.source === 'pattern' && bowdenCell > l.cell_w && <button className="btn-secondary btn-small" onClick={() => upd(() => { const k = bowdenCell / l.cell_w; l.cell_w = bowdenCell; l.cell_h = Math.min(80, Math.round(l.cell_h * k * 2) / 2); })}>Cells to {bowdenCell} mm</button>}
              {l.retract && <button className="btn-secondary btn-small" onClick={() => upd(() => { l.retract = false; })}>Retraction off</button>}
            </div>
          </>
        )}
        {!bowden && busyRetract && <p className="mx-muted bad" style={{ margin: 0 }}>Many retractions per layer: use bigger cells, or turn retraction across holes off for small holes.</p>}
      </div>

      <details className="mx-more">
        <summary className="mx-label" style={{ cursor: 'pointer' }}>Band, walls and printability</summary>
        <div className="mx-two">
          <label className="mx-field">From (mm)<input className="input" type="number" min={0} step={0.2} value={l.z_start} onChange={(e) => upd(() => { l.z_start = Math.max(0, +e.target.value); })} /></label>
          <label className="mx-field">To (mm)<input className="input" type="number" min={0} step={0.2} value={l.z_end >= 1e4 ? '' : l.z_end} placeholder="top" onChange={(e) => upd(() => { l.z_end = e.target.value === '' ? 1e4 : +e.target.value; })} /></label>
        </div>
        <label className="mx-field">Solid rim under the top: {l.rim_mm} mm
          <input type="range" min={0} max={20} step={0.5} value={l.rim_mm} onChange={(e) => upd(() => { l.rim_mm = +e.target.value; })} />
        </label>
        <div className="seg mx-seg">
          <button className={l.walls === 'all' ? 'on' : ''} title="Holes go right through" onClick={() => upd(() => { l.walls = 'all'; })}>Every wall</button>
          <button className={l.walls === 'outer' ? 'on' : ''} title="Holes in the outer wall only; the inner wall stays whole behind them (relief lace, watertight)" onClick={() => upd(() => { l.walls = 'outer'; })}>Outer wall only</button>
        </div>
        <label className="mx-field">Steepest hole top: {l.overhang_deg}° from vertical
          <input type="range" min={20} max={65} step={1} value={l.overhang_deg} onChange={(e) => upd(() => { l.overhang_deg = +e.target.value; })} />
        </label>
        <label className="mx-field">Longest flat bridge: {l.bridge_mm} mm
          <input type="range" min={0} max={10} step={0.5} value={l.bridge_mm} onChange={(e) => upd(() => { l.bridge_mm = +e.target.value; })} />
        </label>
        <div className="mx-two">
          <label className="mx-field">Shortest strand (mm)<input className="input" type="number" min={0} max={10} step={0.1} value={l.min_strand_mm} onChange={(e) => upd(() => { l.min_strand_mm = Math.max(0, +e.target.value); })} /></label>
          <label className="mx-field">Narrowest hole (mm)<input className="input" type="number" min={0} max={10} step={0.1} value={l.min_hole_mm} onChange={(e) => upd(() => { l.min_hole_mm = Math.max(0, +e.target.value); })} /></label>
        </div>
        <label className="row" style={{ gap: 8, margin: 0, fontSize: 12 }}>
          <input type="checkbox" checked={l.retract} onChange={(e) => upd(() => { l.retract = e.target.checked; })} /> Retract across holes (off for tiny holes or filaments that hardly string)
        </label>
        <label className="row" style={{ gap: 8, margin: 0, fontSize: 12 }}>
          <input type="checkbox" checked={l.follow_curve} onChange={(e) => upd(() => { l.follow_curve = e.target.checked; })} /> Measure height along the curve
        </label>
        <div className="mx-label">Goes on</div>
        <div className="seg mx-seg">
          <button className={!l.objects?.length ? 'on' : ''} onClick={() => upd(() => { l.objects = []; })}>Every object</button>
          <button className={l.objects?.length ? 'on' : ''} disabled={!selected.length} onClick={() => upd(() => { l.objects = [...selected]; })}>Selected ({l.objects?.length || selected.length})</button>
        </div>
      </details>

      <div className="row" style={{ gap: 6, margin: 0, flexWrap: 'wrap' }}>
        <button className="btn-secondary btn-small" title="Two walls (one for outer-only lace), no infill or top skin, solid floor, spiral vase off, no Z hop" onClick={() => { const s = useStore.getState(); for (const [k, v] of Object.entries(lacePrintSettings(l, currentConfig()))) s.setOverride(k, v); }}>Set up print settings</button>
        <button className="btn-secondary btn-small" title="A Ø50 × 40 mm cylinder with the lace on it" onClick={addTestTube}>Add test cylinder</button>
        <button className="btn-secondary btn-small" title="Vase shapes to lace" onClick={() => useStore.getState().set({ dock: { ...useStore.getState().dock, open: true, tab: 'plantex' } })}>Vase shapes →</button>
      </div>
      <LaceReport />
      <button className="btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => upd(() => { const keep = { objects: l.objects }; mx.lace = { ...defaultLace(), enabled: true, ...keep }; })}>Reset lace</button>
    </section>
  );
}

/** Two cells by two of the pattern, open = dark. */
function Swatch({ l }: { l: LaceSettings }) {
  const url = useMemo(() => {
    if (typeof document === 'undefined') return '';
    const W = 48, H = 36, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d')!, d = g.createImageData(W, H);
    const P = { cw: 8, ch: 10, strand: l.strand_mm * 0.6, open: l.open, seed: l.seed }, pat = lacePattern(l.pattern);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const open = patternOpen(pat, (x / W) * 16, ((H - 1 - y) / H) * 20, P);
      d.data.set(open ? [40, 40, 44, 255] : [226, 220, 208, 255], (y * W + x) * 4);
    }
    g.putImageData(d, 0, 0);
    return c.toDataURL();
  }, [l.pattern, l.strand_mm, l.open, l.seed]);
  return <img src={url} alt="" style={{ width: '100%', display: 'block', borderRadius: 3 }} />;
}

function PictureView({ l }: { l: LaceSettings }) {
  const url = useMemo(() => {
    if (typeof document === 'undefined') return '';
    const c = document.createElement('canvas');
    c.width = l.image.w; c.height = l.image.h;
    const g = c.getContext('2d')!, d = g.createImageData(l.image.w, l.image.h);
    l.image.px.forEach((v, i) => d.data.set(v ? [40, 40, 44, 255] : [226, 220, 208, 255], i * 4));
    g.putImageData(d, 0, 0);
    return c.toDataURL();
  }, [l.image]);
  return <img src={url} alt="" style={{ width: '100%', height: 150, objectFit: 'contain', imageRendering: 'pixelated', display: 'block', borderRadius: 4 }} />;
}

function LaceReport() {
  const result = useStore((s) => s.slice.result);
  const dirty = useStore((s) => s.slice.dirty);
  const rep = (result?.pluginReports?.motionex as MotionexReport | undefined)?.lace;
  if (!rep) return null;
  const rows: [boolean, string][] = [
    [rep.laceLayers > 0, rep.laceLayers ? `${rep.laceLayers} lace layers · ${Math.round(rep.openShare * 100)}% of the wall open` : 'No holes cut: check the band, the rim and spiral vase'],
    [true, `${rep.holes} hole stretches · ${rep.retractions} retractions`],
    [true, rep.openedForSupport > 0.001 ? `Hole tops drawn into points on ${(rep.openedForSupport * 100).toFixed(1)}% of the wall (printable without support)` : 'Every hole top already printable'],
  ];
  return (
    <div>
      <div className="mx-label">Last slice{dirty ? ' (out of date)' : ''}</div>
      {rows.map(([ok, t], k) => <div key={k} className="mx-check"><span className={ok ? 'ok' : 'bad'}>{ok ? '✓' : '!'}</span>{t}</div>)}
    </div>
  );
}
