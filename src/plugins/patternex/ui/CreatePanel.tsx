// Patternex · Create: text, codes, Braille, logos (SVG clean-up, image trace), gradients, tiling and the
// surface brush. Everything becomes an ordinary pattern: preview here, then click the model to place it.
// Finish: ink (AMS colour) or relief (raised / recessed) — relief is the default on single-colour printers.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../../state/store';
import { printerById } from '../../../profiles/printers';
import type { Pattern } from '../model';
import { parseSvg } from '../svg';
import { GROUP_KEYS, GROUP_NAMES } from '../library/catalog';
import { applyToObject, targetObject, inkActions } from '../library/apply';
import { BUNDLED_FONTS, defaultTextSpec, fieldsOf, fillFields, fontById, fontList, loadFont, registerFont, textPattern, type TextSpec } from '../tools/text';
import { CODE_KINDS, defaultBrailleSpec, defaultCodeSpec, braillePattern, codePattern, ADA, type CodeSpec } from '../tools/codes';
import { traceImage, defaultTraceSpec, type TraceSpec } from '../tools/trace';
import { cleanupPattern } from '../tools/shape';
import { defaultGradientSpec, defaultTileSpec, gradientPattern, seamlessCount, tilePattern, type GradientSpec, type TileSpec } from '../tools/layout';
import { addPattern, patternInkKey } from './state';
import { px, changed, usePatternex } from './PatternexPanel';
import { runBatch } from './batch';
import { autoChanges } from '../../../profiles/changer';

type Tab = 'text' | 'code' | 'braille' | 'logo' | 'gradient' | 'tile' | 'brush';
const TABS: [Tab, string][] = [['text', 'Text'], ['code', 'QR / barcode'], ['braille', 'Braille'], ['logo', 'Logo / image'], ['gradient', 'Gradient'], ['tile', 'Repeat'], ['brush', 'Brush']];

export type Finish = { kind: 'ink' } | { kind: 'raise' | 'recess'; height: number };

const nozzleOf = () => Number(printerById(useStore.getState().printerId).machine.nozzle_diameter ?? 0.4) || 0.4;
let seq = 0;
const gid = (k: string) => `${k}-${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Arm a generated pattern for placing, with its finish (ink and/or relief). */
export function armGenerated(pat: Pattern, finish: Finish, inks?: Record<string, number>): void {
  addPattern(px, pat);
  px.armed = pat.id;
  const s = useStore.getState();
  const slots = s.filaments.length;
  const groups = [...new Set(pat.shapes.map((x) => x.fill_color))];
  // ink: each group on its own slot from 2 (or what the user saved for it); relief alone keeps the base material
  const base = px.savedInks[patternInkKey(pat.id)] ?? inks ?? Object.fromEntries(groups.map((g, k) => [g, Math.min(slots - 1, k + 1)]));
  px.armedInks = finish.kind === 'ink' && slots > 1 ? base : finish.kind !== 'ink' && inks ? inks : {};
  px.armedRelief = finish.kind === 'ink' ? null : { mode: finish.kind, height_mm: finish.height };
  s.set({ tool: 'place_pattern', workspace: 'prepare' });
  changed(false);
}

export function CreatePanel() {
  usePatternex();
  const [tab, setTab] = useState<Tab>('text');
  const ams = autoChanges(printerById(useStore((s) => s.printerId)).machine);
  const [finish, setFinish] = useState<Finish>(ams ? { kind: 'ink' } : { kind: 'raise', height: 0.6 });
  useEffect(() => { setFinish(ams ? { kind: 'ink' } : { kind: 'raise', height: 0.6 }); }, [ams]);
  return (
    <section className="mx-card">
      <div className="mx-card-title">Create</div>
      <div className="mx-chips px-tabs">
        {TABS.map(([k, l]) => <button key={k} className={`btn-secondary btn-small ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab !== 'brush' && tab !== 'gradient' && <FinishPicker finish={tab === 'braille' ? { kind: 'raise', height: ADA.height_mm } : finish} set={setFinish} ams={ams} locked={tab === 'braille'} />}
      {tab === 'text' && <TextTab finish={finish} />}
      {tab === 'code' && <CodeTab finish={finish} />}
      {tab === 'braille' && <BrailleTab />}
      {tab === 'logo' && <LogoTab finish={finish} />}
      {tab === 'gradient' && <GradientTab ams={ams} />}
      {tab === 'tile' && <TileTab finish={finish} />}
      {tab === 'brush' && <BrushTab />}
      <BrandKit />
    </section>
  );
}

function FinishPicker({ finish, set, ams, locked }: { finish: Finish; set: (f: Finish) => void; ams: boolean; locked?: boolean }) {
  return (
    <div className="px-finish">
      <div className="seg mx-seg">
        <button className={finish.kind === 'ink' ? 'on' : ''} disabled={locked} onClick={() => set({ kind: 'ink' })}>{ams ? 'Ink (AMS colour)' : 'Ink (manual swap)'}</button>
        <button className={finish.kind === 'raise' ? 'on' : ''} disabled={locked} onClick={() => set({ kind: 'raise', height: finish.kind !== 'ink' ? finish.height : 0.6 })}>Raised</button>
        <button className={finish.kind === 'recess' ? 'on' : ''} disabled={locked} onClick={() => set({ kind: 'recess', height: finish.kind !== 'ink' ? finish.height : 0.6 })}>Recessed</button>
      </div>
      {finish.kind !== 'ink' && (
        <label className="mx-field">Height (mm){locked && <span className="px-tag">ADA</span>}
          <input className="input" type="number" min={0.1} max={5} step={0.1} value={finish.height} disabled={locked} onChange={(e) => set({ kind: finish.kind, height: Math.max(0.1, Number(e.target.value) || 0.6) })} />
        </label>
      )}
      {!ams && finish.kind === 'ink' && <p className="mx-muted px-warn">Single-colour printer: inked text on a wall needs a swap in the middle of a layer. Raised or recessed prints in one go.</p>}
    </div>
  );
}

/** Preview SVG fitted to the artwork's bounds (Y up), with a small margin. */
export function fitSvg(pat: Pattern, inks: Record<string, string> = {}, bg = '#f4f4f6', maxPoints = 40_000): string {
  const [x0, y0, x1, y1] = pat.bounds;
  const m = Math.max(x1 - x0, y1 - y0) * 0.06 + 0.5;
  const total = pat.shapes.reduce((n, s) => n + s.polygon_rings.reduce((a, r) => a + r.length, 0), 0);
  const step = Math.max(1, Math.ceil(total / maxPoints));
  const paths = pat.shapes.map((s) => {
    const d = s.polygon_rings.map((r) => { let o = ''; for (let k = 0; k < r.length; k += step) o += `${k ? 'L' : 'M'}${r[k][0].toFixed(2)} ${(-r[k][1]).toFixed(2)}`; return o + 'Z'; }).join('');
    return `<path fill="${inks[s.fill_color] ?? s.fill_color}" fill-rule="${s.fill_rule}" d="${d}"/>`;
  }).join('');
  const vx = x0 - m, vy = -y1 - m, vw = x1 - x0 + 2 * m, vh = y1 - y0 + 2 * m;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" preserveAspectRatio="xMidYMid meet"><rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${bg}"/>${paths}</svg>`;
}

function Preview({ pat, inks }: { pat: Pattern | null; inks?: Record<string, string> }) {
  const svg = useMemo(() => (pat && pat.shapes.length ? fitSvg(pat, inks) : ''), [pat, inks]);
  if (!pat) return <div className="px-prev px-prev-empty">…</div>;
  const w = pat.bounds[2] - pat.bounds[0], h = pat.bounds[3] - pat.bounds[1];
  return (
    <div className="px-prev">
      <div dangerouslySetInnerHTML={{ __html: svg }} />
      <span className="px-dim">{w.toFixed(1)} × {h.toFixed(1)} mm</span>
    </div>
  );
}

const Num = ({ label, value, set, step = 0.5, min, max }: { label: string; value: number; set: (v: number) => void; step?: number; min?: number; max?: number }) => (
  <label className="mx-field">{label}<input className="input" type="number" step={step} min={min} max={max} value={value} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) set(v); }} /></label>
);

function TextTab({ finish }: { finish: Finish }) {
  const [spec, setSpec] = useState<TextSpec>(defaultTextSpec());
  const [fontReady, setFontReady] = useState(0);
  const [batch, setBatch] = useState<{ csv: string; count: number; start: number; step: number }>({ csv: '', count: 5, start: 1, step: 1 });
  const fileFont = useRef<HTMLInputElement>(null), fileCsv = useRef<HTMLInputElement>(null);
  const up = (p: Partial<TextSpec>) => setSpec((s) => ({ ...s, ...p }));
  useEffect(() => { let ok = true; void loadFont(spec.font).then(() => ok && setFontReady((n) => n + 1)).catch(() => {}); return () => { ok = false; }; }, [spec.font]);
  const font = fontById(spec.font);
  const preview = useMemo(() => (font ? textPattern(font, { ...spec, text: fillFields(spec.text, { serial: String(batch.start), date: new Date().toISOString().slice(0, 10), n: '1' }) }, 'text-preview', nozzleOf()) : null), [font, spec, fontReady, batch.start]);
  const fields = fieldsOf(spec.text);
  const sel = px.placements.find((p) => p.id === px.selected);
  const selPat = sel && px.patterns.find((p) => p.id === sel.pattern_id);
  const canBatch = !!selPat?.meta && ['text', 'code', 'braille'].includes(selPat.meta.kind);
  return (
    <>
      <textarea className="input px-text" rows={2} value={spec.text} onChange={(e) => up({ text: e.target.value })} placeholder="Text · {name} {serial:4} {date}" />
      <div className="mx-two">
        <label className="mx-field">Font
          <select className="select" value={spec.font} onChange={(e) => up({ font: e.target.value })}>
            {fontList().map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <label className="mx-field">&nbsp;<button className="btn-secondary btn-small" onClick={() => fileFont.current?.click()}>Add font file…</button></label>
        <input ref={fileFont} type="file" accept=".ttf,.otf,.woff" hidden onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (!f) return;
          try { const id = `user:${f.name}`; registerFont(id, await f.arrayBuffer()); up({ font: id }); }
          catch { useStore.getState().set({ toast: { kind: 'error', text: `${f.name} is not a font NexSpiro can read (TTF, OTF or WOFF).` } }); }
        }} />
      </div>
      <div className="mx-two">
        <Num label="Size (mm)" value={spec.size_mm} set={(v) => up({ size_mm: Math.max(1, v) })} />
        <Num label="Tracking (‰ em)" value={spec.tracking} step={10} set={(v) => up({ tracking: v })} />
      </div>
      <div className="mx-two">
        <Num label="Line height (× size)" value={spec.line_height} step={0.05} set={(v) => up({ line_height: Math.max(0.5, v) })} />
        <Num label="Arc radius (mm, 0 = straight)" value={spec.arc_radius_mm} step={5} set={(v) => up({ arc_radius_mm: v })} />
      </div>
      <div className="mx-two">
        <Num label="Weight (+ mm outline)" value={spec.weight_mm} step={0.05} set={(v) => up({ weight_mm: Math.max(-0.3, Math.min(1, v)) })} />
        <label className="mx-field px-check"><input type="checkbox" checked={spec.kerning} onChange={(e) => up({ kerning: e.target.checked })} />Kerning</label>
      </div>
      <div className="seg mx-seg">
        {(['left', 'center', 'right'] as const).map((a) => <button key={a} className={spec.align === a ? 'on' : ''} onClick={() => up({ align: a })}>{a}</button>)}
      </div>
      <Preview pat={preview?.pattern ?? null} />
      {preview && !preview.minStroke.ok && <p className="mx-muted px-warn">⚠ {Math.round(preview.minStroke.lostShare * 100)}% of the letters are thinner than {preview.minStroke.min.toFixed(2)} mm (2 × nozzle) and will not print cleanly. Make it bigger, add weight, or use a bolder font.</p>}
      {preview?.minStroke.ok && <p className="mx-muted">Strokes ≥ {preview.minStroke.min.toFixed(2)} mm (2 × nozzle) ✓</p>}
      <div className="mx-chips">
        <button className="btn-primary btn-small" disabled={!preview} onClick={() => preview && armGenerated({ ...preview.pattern, id: gid('text') }, finish)}>Place on model</button>
        <button className="btn-secondary btn-small" disabled={!preview || !targetObject()} title="Wrap the text round the selected object (cylindrical)" onClick={() => {
          const o = targetObject(); if (!o || !preview) return;
          const pat = { ...preview.pattern, id: gid('text') };
          addPattern(px, pat);
          applyToObject(px, o, { kind: 'wrap' }, () => pat, (id, p) => finishActions(id, p, finish));
          changed();
        }}>Wrap round object</button>
      </div>
      <details className="px-more">
        <summary>Batch: one copy per CSV row or serial {fields.length ? `(fields: ${fields.join(', ')})` : ''}</summary>
        <p className="mx-muted">Select a placed text, code or Braille placement, then make copies of its object with the fields filled in — <code>{'{name}'}</code> from CSV columns, <code>{'{serial:4}'}</code> counts (zero-padded), <code>{'{date}'}</code>, <code>{'{lot}'}</code>.</p>
        <div className="mx-two">
          <Num label="Copies (no CSV)" value={batch.count} step={1} min={1} set={(v) => setBatch((b) => ({ ...b, count: Math.max(1, Math.round(v)) }))} />
          <Num label="Serial start" value={batch.start} step={1} set={(v) => setBatch((b) => ({ ...b, start: Math.round(v) }))} />
        </div>
        <div className="mx-chips">
          <button className="btn-secondary btn-small" onClick={() => fileCsv.current?.click()}>{batch.csv ? 'CSV loaded ✓' : 'Load CSV…'}</button>
          <input ref={fileCsv} type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { const csv = await f.text(); setBatch((b) => ({ ...b, csv })); } }} />
          <button className="btn-primary btn-small" disabled={!canBatch} title={canBatch ? '' : 'Select a placed text / code / Braille placement first'} onClick={async () => {
            const n = await runBatch(sel!.id, batch);
            useStore.getState().set({ toast: { kind: 'info', text: `Batch: ${n} object(s) with personalised artwork.` } });
          }}>Make batch</button>
        </div>
      </details>
    </>
  );
}

/** Region actions for a generated pattern's groups from the chosen finish (used by the quick-apply buttons). */
export function finishActions(placementId: string, pat: Pattern, finish: Finish) {
  const s = useStore.getState();
  const ams = autoChanges(printerById(s.printerId).machine);
  const groups = [...new Set(pat.shapes.map((x) => x.fill_color))];
  if (finish.kind === 'ink') return inkActions(placementId, pat, Object.fromEntries(groups.map((g, k) => [g, Math.min(s.filaments.length - 1, k + 1)])), ams).filter((a) => s.filaments.length > 1 || a.material.slot_index > 0);
  return groups.map((g) => ({
    region_ref: { placement_id: placementId, color_group: g },
    material: { mode: 'keep' as const, slot_index: 0 },
    purge: { mode: 'full' as const, change_point_shift_mm: 0 },
    motion: null,
    relief: { mode: finish.kind, height_mm: finish.height },
  }));
}

function CodeTab({ finish }: { finish: Finish }) {
  const [spec, setSpec] = useState<CodeSpec>(defaultCodeSpec());
  const up = (p: Partial<CodeSpec>) => setSpec((s) => ({ ...s, ...p }));
  const res = useMemo(() => { try { return codePattern({ ...spec, text: fillFields(spec.text, { serial: '1', date: new Date().toISOString().slice(0, 10) }) }, 'code-preview', nozzleOf()); } catch (e) { return { error: String((e as Error).message ?? e) }; } }, [spec]);
  const kind = CODE_KINDS.find((k) => k.id === spec.kind)!;
  return (
    <>
      <label className="mx-field">Type
        <select className="select" value={spec.kind} onChange={(e) => up({ kind: e.target.value as CodeSpec['kind'] })}>{CODE_KINDS.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select>
      </label>
      <label className="mx-field">Content (fields allowed: {'{serial:5}'}, {'{lot}'}, {'{date}'})<input className="input" value={spec.text} onChange={(e) => up({ text: e.target.value })} /></label>
      <div className="mx-two">
        <Num label="Width (mm)" value={spec.width_mm} set={(v) => up({ width_mm: Math.max(5, v) })} />
        {!kind.twoD && <Num label="Bar height (mm)" value={spec.height_mm} set={(v) => up({ height_mm: Math.max(2, v) })} />}
      </div>
      <div className="mx-two">
        <label className="mx-field px-check"><input type="checkbox" checked={spec.quiet} onChange={(e) => up({ quiet: e.target.checked })} />Quiet zone</label>
        <label className="mx-field px-check"><input type="checkbox" checked={spec.invert} onChange={(e) => up({ invert: e.target.checked })} />Invert (dark base)</label>
      </div>
      {'error' in res ? <p className="mx-muted px-warn">⚠ {res.error}</p> : (
        <>
          <Preview pat={res.pattern} />
          <p className={`mx-muted ${res.ok ? '' : 'px-warn'}`}>{res.ok ? '✓ ' : '⚠ '}{res.message}</p>
          {finish.kind !== 'ink' && <p className="mx-muted">Relief codes scan best recessed ≥ 0.6 mm with a light, raking light; inked codes (AMS) scan best.</p>}
          <button className="btn-primary btn-small" onClick={() => armGenerated({ ...res.pattern, id: gid('code') }, finish)}>Place on model</button>
        </>
      )}
    </>
  );
}

function BrailleTab() {
  const [spec, setSpec] = useState(defaultBrailleSpec());
  const pat = useMemo(() => braillePattern(spec, 'braille-preview'), [spec]);
  return (
    <>
      <label className="mx-field">Text (Grade 1, uncontracted)<input className="input" value={spec.text} onChange={(e) => setSpec({ ...spec, text: e.target.value })} /></label>
      <Preview pat={pat} />
      <p className="mx-muted">ADA 703.3: dots Ø{ADA.dot_mm} mm, {ADA.height_mm} mm high, {ADA.dot_spacing_mm} mm apart, cells {ADA.cell_spacing_mm} mm, lines {ADA.line_spacing_mm} mm. Always raised — print with the face up (dots on a top surface) for round domes.</p>
      <button className="btn-primary btn-small" onClick={() => armGenerated({ ...pat, id: gid('braille') }, { kind: 'raise', height: ADA.height_mm })}>Place on model</button>
    </>
  );
}

function LogoTab({ finish }: { finish: Finish }) {
  const file = useRef<HTMLInputElement>(null);
  const filaments = useStore((s) => s.filaments);
  const [src, setSrc] = useState<{ kind: 'svg'; pattern: Pattern } | { kind: 'img'; data: ImageData; name: string } | null>(null);
  const [clean, setClean] = useState({ mergeDeltaE: 6, simplifyMm: 0.05, speckMm2: 0.2 });
  const [trace, setTrace] = useState<TraceSpec>(defaultTraceSpec());
  const [snap, setSnap] = useState(false);
  const out = useMemo(() => {
    if (!src) return null;
    if (src.kind === 'svg') { const r = cleanupPattern(src.pattern, clean); return { pattern: r.pattern, note: `${r.report.colorsBefore} → ${r.report.colorsAfter} colours · ${r.report.pointsBefore.toLocaleString()} → ${r.report.pointsAfter.toLocaleString()} points · ${r.report.specksRemoved} speck(s) removed` }; }
    const r = traceImage(src.data, { ...trace, palette: snap ? filaments.map((f) => f.color) : undefined }, 'trace-preview', src.name);
    return { pattern: r.pattern, note: `${r.colors.length} colour(s)${r.dropped ? ` · background ${r.dropped} left as base` : ''}` };
  }, [src, clean, trace, snap, filaments]);
  // generated logos come in their real colours: map them onto the ink groups so the library inks apply
  const inked = useMemo(() => out && remapToGroups(out.pattern), [out]);
  const onFile = async (f: File) => {
    if (/\.svg$/i.test(f.name) || f.type === 'image/svg+xml') { setSrc({ kind: 'svg', pattern: parseSvg(await f.text(), { name: f.name.replace(/\.svg$/i, ''), tolerance_mm: 0.05 }).pattern }); return; }
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, 400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d')!; g.drawImage(bmp, 0, 0, c.width, c.height);
    setSrc({ kind: 'img', data: g.getImageData(0, 0, c.width, c.height), name: f.name.replace(/\.[a-z]+$/i, '') });
  };
  return (
    <>
      <button className="btn-secondary btn-small" onClick={() => file.current?.click()}>Open SVG, PNG or JPG…</button>
      <input ref={file} type="file" accept=".svg,.png,.jpg,.jpeg,image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onFile(f); }} />
      {src?.kind === 'svg' && (
        <div className="mx-two">
          <Num label="Merge colours (ΔE)" value={clean.mergeDeltaE} step={1} min={0} set={(v) => setClean({ ...clean, mergeDeltaE: Math.max(0, v) })} />
          <Num label="Simplify (mm)" value={clean.simplifyMm} step={0.01} min={0} set={(v) => setClean({ ...clean, simplifyMm: Math.max(0, v) })} />
          <Num label="Remove specks < (mm²)" value={clean.speckMm2} step={0.1} min={0} set={(v) => setClean({ ...clean, speckMm2: Math.max(0, v) })} />
        </div>
      )}
      {src?.kind === 'img' && (
        <>
          <div className="mx-two">
            <Num label="Colours (1–4)" value={trace.colors} step={1} min={1} max={4} set={(v) => setTrace({ ...trace, colors: Math.max(1, Math.min(4, Math.round(v))) })} />
            <Num label="Width (mm)" value={trace.width_mm} set={(v) => setTrace({ ...trace, width_mm: Math.max(5, v) })} />
          </div>
          <div className="mx-two">
            <Num label="Smooth (mm)" value={trace.smooth_mm} step={0.02} min={0} set={(v) => setTrace({ ...trace, smooth_mm: Math.max(0, v) })} />
            <Num label="Remove specks < (mm²)" value={trace.speck_mm2} step={0.1} min={0} set={(v) => setTrace({ ...trace, speck_mm2: Math.max(0, v) })} />
          </div>
          <label className="mx-field px-check"><input type="checkbox" checked={trace.dropBackground} onChange={(e) => setTrace({ ...trace, dropBackground: e.target.checked })} />Background stays base material</label>
          <label className="mx-field px-check"><input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />Snap colours to loaded filaments</label>
        </>
      )}
      {out && inked && (
        <>
          <Preview pat={out.pattern} />
          <p className="mx-muted">{out.note}</p>
          <div className="mx-chips">
            <button className="btn-primary btn-small" onClick={() => armGenerated({ ...inked.pattern, id: gid('logo') }, finish, snap ? inked.slotByGroup(filaments.map((f) => f.color)) : undefined)}>Place on model</button>
            <button className="btn-secondary btn-small" onClick={() => {
              px.brandKit.push({ id: gid('brand'), name: out.pattern.name, pattern: { ...inked.pattern, id: gid('logo') }, inks: inked.slotByGroup(filaments.map((f) => f.color)), relief: finish.kind === 'ink' ? null : { mode: finish.kind, height_mm: finish.height } });
              changed(false);
            }}>Save to brand kit</button>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Logos keep their real colours for the preview; for placing they are recoloured onto the ink group keys
 * (Ink A, B, C by area) so the region pickers and saved inks work like library patterns. `slotByGroup`
 * picks for each group the loaded filament closest to its original colour.
 */
function remapToGroups(p: Pattern) {
  const colors = [...new Set(p.shapes.map((s) => s.fill_color))];
  const keys = GROUP_KEYS.slice(1);
  const map = new Map(colors.map((c, k) => [c, keys[k] ?? keys[keys.length - 1]]));
  const pattern: Pattern = { ...p, shapes: p.shapes.map((s) => ({ ...s, fill_color: map.get(s.fill_color)! })) };
  const slotByGroup = (fil: string[]) => {
    const out: Record<string, number> = {};
    for (const [orig, key] of map) {
      let best = 1, bd = Infinity;
      fil.forEach((f, k) => { if (k === 0 && fil.length > 1) return; const d = dist(orig, f); if (d < bd) { bd = d; best = k; } });
      out[key] = best;
    }
    return out;
  };
  return { pattern, slotByGroup };
}
const dist = (a: string, b: string) => { const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); const x = p(a), y = p(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };

function GradientTab({ ams }: { ams: boolean }) {
  const [spec, setSpec] = useState<GradientSpec>(defaultGradientSpec());
  const filaments = useStore((s) => s.filaments);
  const up = (p: Partial<GradientSpec>) => setSpec((s) => ({ ...s, ...p }));
  const pat = useMemo(() => gradientPattern(spec, 'gradient-preview'), [spec]);
  const lw = nozzleOf() * 2;
  return (
    <>
      <div className="mx-two">
        <Num label="Width (mm)" value={spec.width_mm} set={(v) => up({ width_mm: Math.max(2, v) })} />
        <Num label="Height (mm)" value={spec.height_mm} set={(v) => up({ height_mm: Math.max(2, v) })} />
      </div>
      <div className="mx-two">
        <Num label="Cell (mm)" value={spec.cell_mm} step={0.1} set={(v) => up({ cell_mm: Math.max(0.4, v) })} />
        <Num label="Angle (°)" value={spec.angle_deg} step={15} set={(v) => up({ angle_deg: v })} />
      </div>
      <div className="mx-two">
        <Num label="Start share of B" value={spec.from} step={0.1} min={0} max={1} set={(v) => up({ from: Math.max(0, Math.min(1, v)) })} />
        <Num label="End share of B" value={spec.to} step={0.1} min={0} max={1} set={(v) => up({ to: Math.max(0, Math.min(1, v)) })} />
      </div>
      <Preview pat={pat} inks={{ [spec.colorA]: filaments[1]?.color ?? '#333', [spec.colorB]: filaments[2]?.color ?? filaments[0]?.color ?? '#999' }} />
      {spec.cell_mm < lw && <p className="mx-muted px-warn">⚠ Cells under {lw.toFixed(2)} mm (2 × nozzle) blur together.</p>}
      {!ams && <p className="mx-muted px-warn">Gradients need a colour change inside a layer: AMS only. On a single-colour printer use a region's “Mix with” setting (alternating layers).</p>}
      <p className="mx-muted">Ordered (Bayer 8×8) dither of two inks. For a vertical blend layer by layer, use a region's “Mix with” setting instead.</p>
      <button className="btn-primary btn-small" disabled={!ams || filaments.length < 3} onClick={() => armGenerated({ ...pat, id: gid('gradient') }, { kind: 'ink' }, { [spec.colorA]: 1, [spec.colorB]: 2 })}>Place on model{filaments.length < 3 ? ' (needs 3 slots)' : ''}</button>
    </>
  );
}

function TileTab({ finish }: { finish: Finish }) {
  const [spec, setSpec] = useState<TileSpec>(defaultTileSpec());
  const sel = px.placements.find((p) => p.id === px.selected);
  const base = sel ? px.patterns.find((p) => p.id === sel.pattern_id) : px.patterns.find((p) => p.id === px.armed);
  const up = (p: Partial<TileSpec>) => setSpec((s) => ({ ...s, ...p }));
  const pat = useMemo(() => (base ? tilePattern(base, spec, 'tile-preview') : null), [base, spec]);
  const o = targetObject();
  const circ = useMemo(() => { if (!o) return 0; const b = o.mesh.vertices; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (let i = 0; i < b.length; i += 3) { x0 = Math.min(x0, b[i]); x1 = Math.max(x1, b[i]); y0 = Math.min(y0, b[i + 1]); y1 = Math.max(y1, b[i + 1]); } return Math.PI * Math.max((x1 - x0) * o.scale[0], (y1 - y0) * o.scale[1]); }, [o]);
  if (!base) return <p className="mx-muted">Select a placement (or arm a pattern) to repeat it.</p>;
  const w = base.bounds[2] - base.bounds[0];
  return (
    <>
      <p className="mx-muted">Repeating <b>{base.name}</b></p>
      <div className="mx-two">
        <Num label="Columns" value={spec.nx} step={1} min={1} set={(v) => up({ nx: Math.max(1, Math.round(v)) })} />
        <Num label="Rows" value={spec.ny} step={1} min={1} set={(v) => up({ ny: Math.max(1, Math.round(v)) })} />
      </div>
      <div className="mx-two">
        <Num label="Gap X (mm)" value={spec.gap_x} step={0.5} set={(v) => up({ gap_x: v })} />
        <Num label="Gap Y (mm)" value={spec.gap_y} step={0.5} set={(v) => up({ gap_y: v })} />
      </div>
      <div className="mx-two">
        <Num label="Jitter (mm)" value={spec.jitter_mm} step={0.2} min={0} set={(v) => up({ jitter_mm: Math.max(0, v) })} />
        <Num label="Jitter (°)" value={spec.jitter_deg} step={5} min={0} set={(v) => up({ jitter_deg: Math.max(0, v) })} />
      </div>
      <div className="mx-two">
        <Num label="Seed" value={spec.seed} step={1} set={(v) => up({ seed: Math.round(v) })} />
        <label className="mx-field px-check"><input type="checkbox" checked={spec.stagger} onChange={(e) => up({ stagger: e.target.checked })} />Brick (stagger)</label>
      </div>
      <label className="mx-field px-check"><input type="checkbox" checked={spec.wrap_mm > 0} disabled={!circ} onChange={(e) => up(e.target.checked ? { wrap_mm: +circ.toFixed(3), nx: seamlessCount(w, circ, Math.max(0, spec.gap_x)) } : { wrap_mm: 0 })} />Seamless wrap{circ ? ` (${circ.toFixed(1)} mm round ${o?.name})` : ''}</label>
      <Preview pat={pat} />
      <div className="mx-chips">
        <button className="btn-primary btn-small" disabled={!pat} onClick={() => pat && armGenerated({ ...pat, id: gid('tile') }, finish, px.savedInks[patternInkKey(base.id)])}>Place on model</button>
        {spec.wrap_mm > 0 && o && <button className="btn-secondary btn-small" onClick={() => { if (!pat) return; const p2 = { ...pat, id: gid('tile') }; addPattern(px, p2); applyToObject(px, o, { kind: 'wrap' }, () => p2, (id, p) => finishActions(id, p, finish)); changed(); }}>Wrap round object</button>}
      </div>
    </>
  );
}

function BrushTab() {
  usePatternex();
  const b = px.brush;
  const set = (p: Partial<typeof b>) => { Object.assign(px.brush, p); changed(false); };
  return (
    <>
      <p className="mx-muted">Paint regions straight onto the surface. Each stroke is added to the brush artwork of the face you start on; ink it like any other region.</p>
      <div className="mx-two">
        <Num label="Brush width (mm)" value={b.width} step={0.2} min={0.4} set={(v) => set({ width: Math.max(0.4, v) })} />
        <label className="mx-field">Group
          <select className="select" value={b.color} onChange={(e) => set({ color: e.target.value })}>{GROUP_KEYS.slice(1).map((k, i) => <option key={k} value={k}>{GROUP_NAMES[i + 1]}</option>)}</select>
        </label>
      </div>
      <button className={`btn-small ${b.active ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { const on = !b.active; px.armed = null; set({ active: on }); useStore.getState().set({ tool: on ? 'place_pattern' : 'select', workspace: 'prepare' }); }}>{b.active ? 'Stop painting' : 'Start painting'}</button>
      {b.width < nozzleOf() * 2 && <p className="mx-muted px-warn">⚠ Strokes under {(nozzleOf() * 2).toFixed(2)} mm (2 × nozzle) print poorly.</p>}
    </>
  );
}

function BrandKit() {
  usePatternex();
  if (!px.brandKit.length) return null;
  return (
    <>
      <div className="mx-label">Brand kit</div>
      <div className="px-brand">
        {px.brandKit.map((b) => (
          <div key={b.id} className="px-brand-item" title={b.name}>
            <button className="px-brand-thumb" onClick={() => armGenerated({ ...b.pattern, id: gid('logo') }, b.relief ? { kind: b.relief.mode, height: b.relief.height_mm } : { kind: 'ink' }, b.inks)} dangerouslySetInnerHTML={{ __html: fitSvg(b.pattern, {}, '#f4f4f6', 8000) }} />
            <span className="px-brand-name">{b.name}</span>
            <button className="btn-secondary btn-small" onClick={() => { px.brandKit = px.brandKit.filter((x) => x !== b); changed(false); }}>Remove</button>
          </div>
        ))}
      </div>
    </>
  );
}

export { BUNDLED_FONTS };
