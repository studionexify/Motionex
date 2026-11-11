// Weave card in the Motionex panel: weave a picture or a motif into the wall, one colour per layer
// (AMS swaps every layer) or as one-filament relief. Picture, colours, wall, seam, filament change,
// cost estimate, print settings and a calibration ring, all in one card.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, worldBounds, type SceneObject } from '../../../state/store';
import { currentConfig, plateObjects } from '../../../state/slicing';
import { centreOnBed, updateHeightRange } from '../../../state/ops';
import { objectFromWorld } from '../../../state/tools';
import { weld } from '../../../engine/mesh';
import { effectiveFlush } from '../../../profiles/flush';
import { changed, mx, useMx } from './MotionexPanel';
import type { MotionexReport } from '../engine';
import { colourCount, cycleLayers, defaultWave, defaultWeave, type ChangeMode, type WeaveSettings } from '../weave/model';
import { pickStyle } from '../weave/wave';
import { AddZone, WaveControls, WaveZoneEditor, zoneName, zonesOf } from './WaveControls';
import { clampPalette, greyLevels, gridFor, parseHex, quantize, resampleRGB, suggestPalette, type Dither, type RGB } from '../weave/image';
import { MOTIFS, motifImage } from '../weave/motifs';
import { estimateWeave, formatDuration, weavePrintSettings } from '../weave/plan';
import { changerOf, purgeTarget, slotCount, toolheadCount } from '../../../profiles/changer';
import type { Config } from '../../../profiles/settings';
import { PathTool } from './PathTool';

/** The last imported picture, kept at up to 640 px so it can be re-matched to new colours or sizes. */
let source: { rgba: Uint8ClampedArray; w: number; h: number; name: string } | null = null;

/** Name of the printer's filament unit, for the panel text (Bambu AMS, Prusa MMU3, Creality CFS, Anycubic ACE). */
function unitName(cfg: Config): string {
  const m = String(cfg.printer_model ?? '').toLowerCase();
  if (String(cfg.gcode_flavor) === 'bbl' || m.startsWith('bambu')) return 'AMS';
  if (m.includes('prusa')) return 'MMU3';
  if (m.includes('creality')) return 'CFS';
  if (m.includes('anycubic')) return 'ACE';
  return 'filament unit';
}

/** Filament slots the printer can feed: heads on a tool changer, the unit's slots (when not set: MMU3 5, AMS/CFS/ACE 4), 1 by hand. */
function slotsOf(cfg: Config): number {
  const n = slotCount(cfg);
  if (n > 0 || changerOf(cfg) !== 'ams') return Math.max(1, n);
  return unitName(cfg) === 'MMU3' ? 5 : 4;
}

/** Colours a weave can take turns with: one per slot of the unit or head of the tool changer (2–4 by hand, if at all). */
const maxColours = () => { const c = currentConfig(); return changerOf(c) === 'manual' ? 4 : Math.max(2, slotsOf(c)); };
const greys = (n: number): RGB[] => Array.from({ length: n }, (_, i) => { const v = Math.round(235 - (i / Math.max(1, n - 1)) * 200); return [v, v, v]; });

/** Colours shown for each palette index: the slots' filament colours (colour) or greys (mono). */
export function weaveColours(w: WeaveSettings = mx.weave): RGB[] {
  const fils = useStore.getState().filaments;
  if (w.mode === 'mono') return greys(Math.max(2, w.picture?.levels ?? 2));
  return w.slots.map((s) => parseHex(fils[s]?.color ?? '#888888'));
}

/** Redraw the picture at its grid size from its source (motif or imported picture) and colours. */
export function rebuildPicture(w: WeaveSettings = mx.weave) {
  const pic = w.picture ?? { kind: 'motif', motif: 'checker' };
  const W = w.image.w, H = w.image.h;
  const n = w.mode === 'colour' ? colourCount(w) : Math.max(2, pic.levels ?? 2);
  if (pic.kind === 'image' && source) {
    const rgb = resampleRGB(source.rgba, source.w, source.h, W, H);
    const px = w.mode === 'colour' ? quantize(rgb, W, H, weaveColours(w), pic.dither ?? 'none') : greyLevels(rgb, W, H, n, pic.dither ?? 'none', pic.invert);
    w.image = { w: W, h: H, px, name: source.name };
  } else if (pic.kind === 'motif') {
    w.image = motifImage(pic.motif ?? 'checker', W, H, n);
  } else {
    w.image = clampPalette(w.image, n);
  }
}

/** Objects the weave goes on (the chosen ones, or every printable object on the active plate). */
export function targetObjects(w: { objects?: string[] }): SceneObject[] {
  const all = plateObjects().filter((o) => o.printable !== false);
  const ids = new Set(w.objects ?? []);
  return ids.size ? all.filter((o) => ids.has(o.id)) : all;
}

/** Widest outline length and height of the target objects (mm), from their bounding boxes. */
export function partSize(w: { objects?: string[] }): { around: number; top: number } {
  let around = 0, top = 0;
  for (const o of targetObjects(w)) {
    const b = worldBounds(o);
    const dx = b.max[0] - b.min[0], dy = b.max[1] - b.min[1];
    // ellipse perimeter (Ramanujan) of the bounding box: right for round parts, close for soft squares
    const a = dx / 2, c = dy / 2, h = ((a - c) / (a + c || 1)) ** 2;
    around = Math.max(around, Math.PI * (a + c) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))));
    top = Math.max(top, b.max[2]);
  }
  return { around, top };
}

/** Grid that fills the part: pixels pixel_mm wide round it, rows as tall as one turn of the colours. */
function fitToPart(w: WeaveSettings) {
  const { around, top } = partSize(w);
  if (!around) return;
  const lh = Number(currentConfig().layer_height) || 0.2;
  const band = Math.max(1, Math.min(w.z_end, top) - w.z_start);
  const aspect = w.picture?.kind === 'image' && source ? source.h / source.w : 0;
  const g = gridFor(around, band, w.picture?.pixel_mm ?? 1.2, cycleLayers(w) * lh, aspect, w.tiles_around);
  w.image = { ...w.image, w: g.w, h: g.h };
  rebuildPicture(w);
}

export async function loadPicture(file: File): Promise<{ rgba: Uint8ClampedArray; w: number; h: number; name: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 640 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const w = Math.max(1, Math.round((img.naturalWidth || 640) * k)), h = Math.max(1, Math.round((img.naturalHeight || 640) * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    return { rgba: g.getImageData(0, 0, w, h).data, w, h, name: file.name.replace(/\.[^.]+$/, '') };
  } finally { URL.revokeObjectURL(url); }
}

/** Closed solid cylinder (triangle soup) standing on z = 0. */
export function solidCylinder(r: number, h: number, seg = 160): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * 2 * Math.PI, a1 = ((i + 1) / seg) * 2 * Math.PI;
    const p0 = [r * Math.cos(a0), r * Math.sin(a0)], p1 = [r * Math.cos(a1), r * Math.sin(a1)];
    out.push(0, 0, 0, p1[0], p1[1], 0, p0[0], p0[1], 0, 0, 0, h, p0[0], p0[1], h, p1[0], p1[1], h);
    out.push(p0[0], p0[1], 0, p1[0], p1[1], 0, p1[0], p1[1], h, p0[0], p0[1], 0, p1[0], p1[1], h, p0[0], p0[1], h);
  }
  return new Float32Array(out);
}

function addCalibrationRing() {
  const s = useStore.getState();
  const o = centreOnBed(objectFromWorld('Weave calibration ring', weld(solidCylinder(25, 22))), s.printerId);
  s.addObjects([o]);
  const w = mx.weave;
  w.enabled = true; w.calibration = true; w.objects = [o.id]; w.z_start = 1.2; w.z_end = 1e4; w.tiles_around = 1;
  w.picture = { ...(w.picture ?? {}), kind: 'motif', motif: 'checker' };
  fitToPart(w);
  changed();
}

const upd = (f: () => void) => { f(); changed(); };

/** Colours of the layers in the texture strip: the weave's filaments in layer order (mono: its filament, then greys). */
function stripColours(w: WeaveSettings): string[] {
  const fils = useStore.getState().filaments;
  return w.mode === 'colour' ? w.slots.map((k) => fils[k]?.color ?? '#888888') : [fils[w.slots[0] ?? 0]?.color ?? '#888888', '#9aa3ad', '#c4cad1'];
}

/** Settings of a selected wave zone (a modifier shape or a height band), for the Inspector and the process card. */
export function WeaveZoneSettings({ objectId, partId, rangeId }: { objectId: string; partId?: string | null; rangeId?: string | null }) {
  useMx();
  const objects = useStore((s) => s.objects);
  useStore((s) => s.filaments);
  const obj = objects.find((o) => o.id === objectId);
  const part = partId ? obj?.parts?.find((p) => p.id === partId) : undefined;
  const range = !part && rangeId ? obj?.heightRanges?.find((r) => r.id === rangeId) : undefined;
  if (!obj || (!part && !range)) return null;
  const w = mx.weave, wave = { ...defaultWave(), ...(w.wave ?? {}) };
  return (
    <div className="mx-card" style={{ margin: '8px 0' }}>
      <div className="mx-card-title">Wave zone</div>
      <p className="mx-muted" style={{ margin: 0 }}>{w.enabled ? `Changes the wave texture where this ${part ? 'shape' : 'height band'} meets the wall. Infill and walls stay as they are.` : 'Turn on Motionex → Weave & texture for this zone to print.'}</p>
      {range && (
        <div className="mx-two">
          <label className="mx-field">From (mm)<input className="input" type="number" min={0} step={0.2} value={range.z0} onChange={(e) => updateHeightRange(obj.id, range.id, { z0: Math.max(0, +e.target.value) })} /></label>
          <label className="mx-field">To (mm)<input className="input" type="number" min={0} step={0.2} value={range.z1} onChange={(e) => updateHeightRange(obj.id, range.id, { z1: Math.max(0, +e.target.value) })} /></label>
        </div>
      )}
      <WaveZoneEditor zone={part ? { obj, part } : { obj, range: range! }} base={pickStyle(wave)} colours={stripColours(w)} blendDefault={wave.blend_mm} />
    </div>
  );
}

/** Delete a wave zone (its modifier shape or height band). */
function removeZone(z: ReturnType<typeof zonesOf>[number]) {
  const s = useStore.getState();
  if (z.part) {
    s.updateObjects((o) => ({ ...o, parts: (o.parts ?? []).filter((p) => p.id !== z.part!.id) }), [z.obj.id]);
    if (s.selectedPart === z.part.id) s.set({ selectedPart: null });
    s.markDirty();
  } else updateHeightRange(z.obj.id, z.range.id, null);
  changed();
}

export function WeaveCard() {
  useMx();
  const w = mx.weave;
  const { filaments, objects, selected, set } = useStore();
  void objects;
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const cfg = currentConfig();
  const changer = changerOf(cfg);
  const ams = changer !== 'manual';
  const MAX_COLOURS = maxColours();
  const unit = unitName(cfg), purge = purgeTarget(cfg);
  const changeS = Number(cfg.filament_change_time) || (changer === 'toolchanger' ? 8 : 60);
  const colours = weaveColours(w);
  const regen = (f: () => void) => upd(() => { f(); rebuildPicture(w); });
  const { selectedPart, selectedRange, colorScheme } = useStore();
  const wave = { ...defaultWave(), ...(w.wave ?? {}) };
  const strip = stripColours(w);
  const targets = targetObjects(w);
  const zones = zonesOf(targets);
  const zoneTarget = targets.find((o) => selected.includes(o.id)) ?? targets[0];
  const pickMotif = (id: string) => regen(() => { w.picture = { ...(w.picture ?? {}), kind: 'motif', motif: id }; });
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      source = await loadPicture(f);
      // colour mode: suggest the picture's own colours as the starting palette when the slots don't fit it yet
      w.picture = { ...(w.picture ?? {}), kind: 'image' };
      fitToPart(w);
      changed();
    } finally { setBusy(false); }
  };
  if (!w.enabled) {
    return (
      <section className="mx-card">
        <div className="mx-card-title">Weave &amp; texture<span className="spacer" />
          <button className="toggle" aria-label="Turn on" title="Turn on" onClick={() => upd(() => { w.enabled = true; if (filaments.length < 2 || !ams) w.mode = 'mono'; fitToPart(w); })} />
        </div>
        <p className="mx-muted" style={{ margin: 0 }}>Weave a picture or motif into the wall: every layer is one colour and each line steps out where the picture shows its colour, like a woven vase. Or use one filament for relief only.</p>
        <p className="mx-muted" style={{ margin: 0 }}>Add a knitted texture too: the line waves in and out and each layer waves the other way. Zones (shapes or height bands) give parts of the wall their own texture or keep them smooth.</p>
        <p className="mx-muted" style={{ margin: 0 }}>{changer === 'toolchanger' ? `This printer: ${toolheadCount(cfg)} toolheads, up to ${MAX_COLOURS} colours with quick head swaps.` : ams ? `This printer: ${unit}, up to ${MAX_COLOURS} colours, purging ${purge === 'chute' ? 'into the chute' : 'into a prime tower'} at every change.` : 'This printer changes filament by hand, so it starts in Mono relief (one filament, no changes).'}</p>
      </section>
    );
  }
  return (
    <section className="mx-card">
      <div className="mx-card-title">Weave &amp; texture<span className="spacer" />
        <button className={`toggle on`} aria-label="Weave on" title="Turn weave off" onClick={() => upd(() => { w.enabled = false; })} />
      </div>
      <label className="mx-field">Weave type
        <select className="select" value={w.mode} title={w.mode === 'colour' ? 'One filament per layer, the colours take turns (AMS)' : 'One filament: the picture is relief only, no filament changes'}
          onChange={(e) => regen(() => { if (e.target.value === 'colour') { w.mode = 'colour'; if (w.slots.length < 2) w.slots = [0, Math.min(1, filaments.length - 1)]; } else w.mode = 'mono'; })}>
          <option value="colour">Colour weave · filaments take turns</option>
          <option value="mono">Mono relief · one filament, no changes</option>
        </select>
      </label>
      {w.mode === 'colour' && !ams && (
        <div className="mx-card" style={{ padding: 8, gap: 6 }}>
          <p className="mx-muted bad" style={{ margin: 0 }}>This printer changes filament by hand (M600 / pause): colour weave would stop the print for a spool swap every {w.layers_per_colour === 1 ? 'layer' : `${w.layers_per_colour} layers`}, hundreds of times. Use Mono relief, which weaves the picture with one filament and no changes, or pick a printer with a filament unit (AMS, MMU3, CFS, ACE) or a tool changer.</p>
          <button className="btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => regen(() => { w.mode = 'mono'; })}>Switch to Mono relief</button>
        </div>
      )}
      {w.mode === 'colour' && changer === 'toolchanger' && <p className="mx-muted" style={{ margin: 0 }}>Tool changer ({toolheadCount(cfg)} heads): each colour has its own head, so a change is a ~{Math.round(changeS)} s head swap with a small prime and no purge. Up to {MAX_COLOURS} colours, one per head.</p>}
      {w.mode === 'colour' && changer === 'ams' && purge === 'chute' && <p className="mx-muted" style={{ margin: 0 }}>{unit}: each change cuts, unloads and loads the filament (~{Math.round(changeS)} s) and flushes the old colour out through the purge chute, so nothing lands on the plate. Small purge or Bleed cut the waste and time. Up to {MAX_COLOURS} colours, one per slot.</p>}
      {w.mode === 'colour' && changer === 'ams' && purge === 'tower' && <p className="mx-muted" style={{ margin: 0 }}>{unit}: each change unloads and loads the filament (~{Math.round(changeS)} s) and purges into a prime tower printed next to the part, so leave room on the plate. Bleed needs no tower (Set up print settings turns it off). Up to {MAX_COLOURS} colours, one per slot.</p>}

      <div className="mx-label">1 · Colours and picture</div>
      <div className="row" style={{ gap: 6, margin: 0, flexWrap: 'wrap' }}>
        <button className="btn-secondary btn-small" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Reading…' : 'Import picture…'}</button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/bmp" style={{ display: 'none' }} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
        <select className="select" value={w.picture?.kind === 'motif' ? w.picture.motif : w.picture?.kind === 'none' ? '__none' : ''} onChange={(e) => e.target.value === '__none' ? upd(() => { w.picture = { ...(w.picture ?? {}), kind: 'none' }; }) : e.target.value && pickMotif(e.target.value)} title="Built-in motifs, or no picture">
          <option value="">{w.picture?.kind === 'image' ? `Picture: ${w.image.name ?? 'imported'}` : 'Motif…'}</option>
          <option value="__none" title="No picture: a plain wall (the texture alone, or colour stripes)">None (plain wall)</option>
          {MOTIFS.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.name}</option>)}
        </select>
      </div>
      {w.picture?.kind === 'image' && !source && <p className="mx-muted" style={{ margin: 0 }}>Import the picture again to re-match it to new colours or a new size.</p>}
      {w.picture?.kind === 'none' ? <p className="mx-muted" style={{ margin: 0 }}>No picture: {w.mode === 'colour' ? 'the colours make stripes, layer by layer' : 'one plain colour'}. Use the texture below for the knitted look.</p> : <>
      <PixelView w={w} colours={colours} />
      <div className="mx-two">
        <label className="mx-field">Pixels round<input className="input" type="number" min={4} max={2000} value={w.image.w} onChange={(e) => regen(() => { w.image = { ...w.image, w: Math.max(4, Math.round(+e.target.value || 4)) }; })} /></label>
        <label className="mx-field">Rows<input className="input" type="number" min={2} max={4000} value={w.image.h} onChange={(e) => regen(() => { w.image = { ...w.image, h: Math.max(2, Math.round(+e.target.value || 2)) }; })} /></label>
      </div>
      <div className="mx-two">
        <label className="mx-field">Pixel width (mm)<input className="input" type="number" min={0.4} max={5} step={0.1} value={w.picture?.pixel_mm ?? 1.2} onChange={(e) => upd(() => { w.picture = { ...(w.picture ?? { kind: 'motif' }), pixel_mm: Math.max(0.4, +e.target.value || 1.2) }; })} /></label>
        <label className="mx-field">Times round<input className="input" type="number" min={1} max={24} value={w.tiles_around} onChange={(e) => upd(() => { w.tiles_around = Math.max(1, Math.round(+e.target.value || 1)); })} /></label>
      </div>
      <button className="btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} title="Pixels round and rows to fill the part at the pixel width, one row per turn of the colours" onClick={() => upd(() => fitToPart(w))}>Fit to part</button>
      </>}
      {w.picture?.kind === 'image' && (
        <div className="mx-two">
          <label className="mx-field">Dithering
            <select className="select" value={w.picture.dither ?? 'none'} onChange={(e) => regen(() => { w.picture = { ...w.picture!, dither: e.target.value as Dither }; })}>
              <option value="none">None (flat areas)</option><option value="floyd">Diffusion (photos)</option><option value="ordered">Pattern</option>
            </select>
          </label>
          {w.mode === 'colour' && source && (
            <button className="btn-secondary btn-small" style={{ alignSelf: 'end' }} title="Pick the loaded filaments closest to the picture's own colours" onClick={() => regen(() => {
              const pal = suggestPalette(resampleRGB(source!.rgba, source!.w, source!.h, Math.min(source!.w, 160), Math.min(source!.h, 160)), Math.min(maxColours(), filaments.length));
              const used = new Set<number>();
              w.slots = pal.map((c) => {
                let best = 0, bd = Infinity;
                filaments.forEach((f, i) => { if (used.has(i)) return; const p = parseHex(f.color), d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; best = i; } });
                used.add(best);
                return best;
              });
            })}>Match filaments</button>
          )}
        </div>
      )}

      {w.mode === 'colour' ? (
        <>
          <div className="mx-label">Colours, in layer order</div>
          {w.slots.map((slot, i) => (
            <div key={i} className="row" style={{ gap: 6, margin: 0 }}>
              <span style={{ width: 16, fontSize: 12 }}>{i + 1}</span>
              <span className="px-swatch" style={{ background: filaments[slot]?.color ?? '#888', width: 14, height: 14, borderRadius: 3, display: 'inline-block' }} />
              <select className="select" style={{ flex: 1 }} value={slot} onChange={(e) => regen(() => { w.slots[i] = +e.target.value; })}>
                {filaments.map((f, k) => <option key={k} value={k}>Slot {k + 1} · {f.color}</option>)}
              </select>
              {w.slots.length > 2 && <button className="btn-secondary btn-small" onClick={() => regen(() => { w.slots.splice(i, 1); })}>Remove</button>}
            </div>
          ))}
          {w.slots.length < Math.min(MAX_COLOURS, filaments.length) && <button className="btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => regen(() => { w.slots.push(filaments.findIndex((_, k) => !w.slots.includes(k))); })}>+ Colour</button>}
          {ams && w.slots.length > MAX_COLOURS && <p className="mx-muted bad" style={{ margin: 0 }}>This printer feeds {MAX_COLOURS} filaments at once ({changer === 'toolchanger' ? 'one per head' : `${unit} slots`}): remove {w.slots.length - MAX_COLOURS} colour{w.slots.length - MAX_COLOURS > 1 ? 's' : ''}.</p>}
          {filaments.length < 2 && <p className="mx-muted bad" style={{ margin: 0 }}>Add a second filament in the filament list for colour weave.</p>}
          <label className="mx-field">Layers per colour: {w.layers_per_colour} {w.layers_per_colour === 1 ? '(swap every layer)' : `(half the swaps per ${w.layers_per_colour}, taller pixels)`}
            <input type="range" min={1} max={4} step={1} value={w.layers_per_colour} onChange={(e) => upd(() => { w.layers_per_colour = +e.target.value; })} />
          </label>
        </>
      ) : w.picture?.kind === 'none' ? null : (
        <>
          <div className="mx-two">
            <label className="mx-field">Grey levels
              <select className="select" value={w.picture?.levels ?? 2} onChange={(e) => regen(() => { w.picture = { ...(w.picture ?? { kind: 'motif' }), levels: +e.target.value }; })}>
                {[2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="mx-field">Style
              <select className="select" value={w.mono_style} onChange={(e) => upd(() => { w.mono_style = e.target.value as WeaveSettings['mono_style']; })}>
                <option value="texture">Dark = woven texture</option><option value="emboss">Light out, dark in</option>
              </select>
            </label>
          </div>
          {w.picture?.kind === 'image' && (
            <label className="row" style={{ gap: 8, margin: 0, fontSize: 12 }}>
              <input type="checkbox" checked={!!w.picture.invert} onChange={(e) => regen(() => { w.picture = { ...w.picture!, invert: e.target.checked }; })} /> Swap dark and light
            </label>
          )}
        </>
      )}

      <div className="mx-label">2 · Texture</div>
      <WaveControls value={wave.enabled ? pickStyle(wave) : null} colours={strip} onChange={(st) => upd(() => { w.wave = st ? { ...wave, ...st, enabled: true } : { ...wave, enabled: false }; })} />
      {(wave.enabled || zones.length > 0) && (
        <label className="row" style={{ gap: 8, margin: 0, fontSize: 12 }} title="Thin fins, sharp ribs and tight corners stay smooth: the wave fades out over a stitch or two there">
          <input type="checkbox" checked={wave.smooth_edges} onChange={(e) => upd(() => { w.wave = { ...wave, smooth_edges: e.target.checked }; })} /> Keep ribs and sharp edges smooth
        </label>
      )}

      <div className="mx-label">3 · Where</div>
      <div className="mx-app">
        <div className="mx-app-top"><b style={{ fontSize: 12, flex: 1 }}>Whole part</b><span className="mx-muted" style={{ margin: 0 }}>{wave.enabled ? 'texture on' : 'no texture'}{w.picture?.kind === 'none' ? '' : ' · picture'}</span></div>
        <div className="mx-two">
          <label className="mx-field">From (mm)<input className="input" type="number" min={0} step={0.2} value={w.z_start} onChange={(e) => upd(() => { w.z_start = Math.max(0, +e.target.value); })} /></label>
          <label className="mx-field">To (mm)<input className="input" type="number" min={0} step={0.2} value={w.z_end >= 1e4 ? '' : w.z_end} placeholder="top" onChange={(e) => upd(() => { w.z_end = e.target.value === '' ? 1e4 : +e.target.value; })} /></label>
        </div>
        {wave.enabled && (
          <label className="mx-field">Soft edge: {wave.blend_mm.toFixed(1)} mm
            <input type="range" min={0.5} max={15} step={0.5} value={wave.blend_mm} aria-label="Whole part soft edge" title="How long the wave takes to fade in at the From height and to fade at zone edges" onChange={(e) => upd(() => { w.wave = { ...wave, blend_mm: +e.target.value }; })} />
          </label>
        )}
        <div className="seg mx-seg">
          <button className={!w.objects?.length ? 'on' : ''} onClick={() => upd(() => { w.objects = []; })}>Every object</button>
          <button className={w.objects?.length ? 'on' : ''} disabled={!selected.length} title="The selected objects only" onClick={() => upd(() => { w.objects = [...selected]; })}>Selected ({w.objects?.length || selected.length})</button>
        </div>
      </div>
      {zones.map((z) => {
        const id = z.part?.id ?? z.range!.id, on = z.part ? selectedPart === z.part.id : selectedRange === z.range!.id;
        return (
          <details key={id} className={`mx-app mx-more${on ? ' on' : ''}`} open={on || undefined}>
            <summary className="mx-app-top" style={{ fontSize: 12 }}>
              <b style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{zoneName(z)}{targets.length > 1 ? ` · ${z.obj.name}` : ''}</b>
              <span className="mx-muted" style={{ margin: 0 }}>{z.part ? z.part.overrides.wave_mode : z.range!.overrides.wave_mode === 'plain' ? 'plain' : 'wave'}</span>
              <button className="btn-secondary btn-small" title="Select it: move, turn and stretch it in the 3D view" onClick={(e) => { e.preventDefault(); set({ selected: [z.obj.id], selectedPart: z.part?.id ?? null, selectedRange: z.range?.id ?? null, processMode: 'objects' }); }}>Select</button>
              <button className="btn-secondary btn-small" onClick={(e) => { e.preventDefault(); removeZone(z); }}>Remove</button>
            </summary>
            {z.range && (
              <div className="mx-two">
                <label className="mx-field">From (mm)<input className="input" type="number" min={0} step={0.2} value={z.range.z0} onChange={(e) => updateHeightRange(z.obj.id, z.range!.id, { z0: Math.max(0, +e.target.value) })} /></label>
                <label className="mx-field">To (mm)<input className="input" type="number" min={0} step={0.2} value={z.range.z1} onChange={(e) => updateHeightRange(z.obj.id, z.range!.id, { z1: Math.max(0, +e.target.value) })} /></label>
              </div>
            )}
            <WaveZoneEditor zone={z} base={pickStyle(wave)} colours={strip} blendDefault={wave.blend_mm} />
          </details>
        );
      })}
      <div className="row" style={{ gap: 6, margin: 0 }}>
        <AddZone obj={zoneTarget} />
        <span className="mx-muted" style={{ margin: 0, flex: 1 }}>{zones.length ? 'Later zones win where they overlap.' : 'A zone changes the wave only where it meets the part.'}</span>
      </div>

      <div className="mx-label">Preview</div>
      <div className="seg mx-seg" role="group" aria-label="Preview colours">
        <button className={colorScheme !== 'wave' ? 'on' : ''} title="Lines in your filament colours: what the print will look like" onClick={() => set({ colorScheme: 'filament' })}>Real colours</button>
        <button className={colorScheme === 'wave' ? 'on' : ''} title="The part in grey, the wave texture in colour: see where the wave goes" onClick={() => set({ colorScheme: 'wave' })}>Wave area</button>
      </div>

      <details className="mx-more">
        <summary className="mx-label" style={{ cursor: 'pointer' }}>Advanced</summary>
      <details className="mx-more">
        <summary className="mx-label" style={{ cursor: 'pointer' }}>Wall</summary>
        <label className="mx-field">Stand out: {w.depth_mm.toFixed(2)} mm
          <input type="range" min={0.04} max={Math.max(3, w.depth_mm)} step={0.02} value={w.depth_mm} onChange={(e) => upd(() => { w.depth_mm = +e.target.value; })} />
        </label>
        <div className="mx-muted" style={{ margin: 0, display: 'block' }}>Big values hang the thread out in the air. The drool check and the thick-thread view show where it will sag or drip.</div>
        <label className="mx-field">Largest move from the wall: {w.max_deviation_mm.toFixed(1)} mm
          <input type="range" min={0.2} max={6} step={0.1} value={w.max_deviation_mm} onChange={(e) => upd(() => { w.max_deviation_mm = +e.target.value; })} />
        </label>
        <label className="mx-field">Hidden lines pull in: {Math.round(w.recess * 100)}%
          <input type="range" min={0} max={1} step={0.05} value={w.recess} onChange={(e) => upd(() => { w.recess = +e.target.value; })} />
        </label>
        <label className="mx-field">Stitches: {w.stitch ? `${Math.round(w.stitch * 100)}% dip between pixels` : 'smooth bands'}
          <input type="range" min={0} max={0.8} step={0.05} value={w.stitch} onChange={(e) => upd(() => { w.stitch = +e.target.value; })} />
        </label>
        <label className="mx-field">Ease between pixels: {w.smooth_mm.toFixed(2)} mm
          <input type="range" min={0} max={1} step={0.05} value={w.smooth_mm} onChange={(e) => upd(() => { w.smooth_mm = +e.target.value; })} />
        </label>
        <label className="mx-field">Twist: {w.shift_px_per_row ? `${w.shift_px_per_row > 0 ? '+' : ''}${w.shift_px_per_row} pixel per row` : 'straight'}
          <input type="range" min={-2} max={2} step={0.25} value={w.shift_px_per_row} onChange={(e) => upd(() => { w.shift_px_per_row = +e.target.value; })} />
        </label>
        <div className="seg mx-seg">
          <button className={w.fit_height === 'stretch' ? 'on' : ''} title="The picture fills the woven band once" onClick={() => upd(() => { w.fit_height = 'stretch'; })}>Fit to band</button>
          <button className={w.fit_height === 'tile' ? 'on' : ''} title="Rows keep their height and the picture repeats up the part" onClick={() => upd(() => { w.fit_height = 'tile'; })}>Repeat up</button>
        </div>
        <label className="row" style={{ gap: 8, margin: 0, fontSize: 12 }}>
          <input type="checkbox" checked={w.follow_curve} onChange={(e) => upd(() => { w.follow_curve = e.target.checked; })} /> Measure rows along the curve (bellies and flares keep the picture's shape)
        </label>
      </details>

      <details className="mx-more">
        <summary className="mx-label" style={{ cursor: 'pointer' }}>Seam and colour change</summary>
        <label className="row" style={{ gap: 8, margin: 0, fontSize: 12 }}>
          <input type="checkbox" checked={w.seam.inward} onChange={(e) => upd(() => { w.seam.inward = e.target.checked; })} />
          <span>Seam inside the wall<div className="mx-muted" style={{ margin: 0 }}>Every layer starts and ends inside: the start blob, the end tail and the wipe stay on the inside, out of sight.</div></span>
        </label>
        {w.seam.inward && (
          <label className="mx-field">Tuck in by {w.seam.tuck_mm.toFixed(1)} mm
            <input type="range" min={0.3} max={2} step={0.1} value={w.seam.tuck_mm} onChange={(e) => upd(() => { w.seam.tuck_mm = +e.target.value; })} />
          </label>
        )}
        <label className="mx-field">Seam line: {Math.round(w.seam.angle_deg)}° {w.seam.angle_deg === 90 ? '(back)' : ''}
          <input type="range" min={0} max={359} step={1} value={w.seam.angle_deg} onChange={(e) => upd(() => { w.seam.angle_deg = +e.target.value; })} />
        </label>
        {w.mode === 'colour' && changer === 'toolchanger' && (
          <>
            <div className="mx-label">At each head swap</div>
            <div className="seg mx-seg">
              <button className={w.change.mode !== 'bleed' ? 'on' : ''} title="The new head primes and wipes on the prime tower: cleanest start, slower" onClick={() => upd(() => { w.change.mode = 'purge'; })}>Prime tower</button>
              <button className={w.change.mode === 'bleed' ? 'on' : ''} title="No tower: the new head starts printing straight away (its ooze is caught by the inside seam)" onClick={() => upd(() => { w.change.mode = 'bleed'; })}>No tower (fastest)</button>
            </div>
          </>
        )}
        {w.mode === 'colour' && changer !== 'toolchanger' && (
          <>
            <div className="mx-label">At each colour change</div>
            <select className="select mx-select" aria-label="At each colour change" value={w.change.mode} onChange={(e) => upd(() => { w.change.mode = e.target.value as ChangeMode; })}>
              {([['purge', 'Full purge'], ['reduced', 'Small purge'], ['bleed', 'Bleed (no purge)']] as [ChangeMode, string][]).map(([m, l]) => <option key={m} value={m}>{l}</option>)}
            </select>
            {w.change.mode === 'reduced' && (
              <label className="mx-field">Purge {w.change.volume_mm3} mm³ per change
                <input type="range" min={5} max={120} step={5} value={w.change.volume_mm3} onChange={(e) => upd(() => { w.change.volume_mm3 = +e.target.value; })} />
              </label>
            )}
            {w.change.mode === 'bleed' && <p className="mx-muted" style={{ margin: 0 }}>No flush and no prime tower: the new colour prints straight away, and the old colour left in the nozzle bleeds into the first few cm of the layer. It's fastest and wastes nothing; the bleed blends into the weave. Use the seam line to choose where each layer starts.</p>}
          </>
        )}
      </details>

      <PathTool />
      </details>
      <Estimate w={w} />
      <div className="row" style={{ gap: 6, margin: 0, flexWrap: 'wrap' }}>
        <button className="btn-secondary btn-small" title="1 wall, no infill or top skin, solid floor, spiral vase off, aligned seam, outer wall 80 mm/s, no prime tower when bleeding" onClick={() => {
          const s = useStore.getState();
          for (const [k, v] of Object.entries(weavePrintSettings(w, currentConfig()))) s.setOverride(k, v);
        }}>Set up print settings</button>
        <button className="btn-secondary btn-small" title="A Ø50 × 22 mm ring with a depth ladder (0.5× to 1.5×, bottom to top) to find the best depth for your filaments" onClick={addCalibrationRing}>Add calibration ring</button>
        <button className="btn-secondary btn-small" title="Weave vase shapes: amphora, flared, twisted ovoid, saucer base" onClick={() => set({ dock: { ...useStore.getState().dock, open: true, tab: 'plantex' } })}>Vase shapes →</button>
      </div>
      {w.calibration && (
        <label className="row" style={{ gap: 8, margin: 0, fontSize: 12 }}>
          <input type="checkbox" checked onChange={() => upd(() => { w.calibration = false; })} /> Depth ladder on (5 bands: 0.5×, 0.75×, 1×, 1.25×, 1.5× of {w.depth_mm.toFixed(2)} mm)
        </label>
      )}
      <WeaveReport />
      <button className="btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => upd(() => { const keep = { slots: w.slots, objects: w.objects }; mx.weave = { ...defaultWeave(), enabled: true, ...keep }; fitToPart(mx.weave); })}>Reset weave</button>
    </section>
  );
}

/** The picture as the part will show it, one square per pixel (left = the seam side, +X). */
function PixelView({ w, colours }: { w: WeaveSettings; colours: RGB[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = w.image.w; c.height = w.image.h;
    const g = c.getContext('2d')!;
    const data = g.createImageData(w.image.w, w.image.h);
    w.image.px.forEach((v, i) => { const p = colours[v] ?? [128, 128, 128]; data.data.set([p[0], p[1], p[2], 255], i * 4); });
    g.putImageData(data, 0, 0);
  }, [w.image, colours.map((c) => c.join()).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ background: 'var(--panel-2, #222)', borderRadius: 6, padding: 4 }}>
      <canvas ref={ref} style={{ width: '100%', height: 150, objectFit: 'contain', imageRendering: 'pixelated', display: 'block' }} title={`${w.image.w} × ${w.image.h} pixels`} />
    </div>
  );
}

function Estimate({ w }: { w: WeaveSettings }) {
  const { filaments, flushMatrix, flushMultiplier, objects, printerId } = useStore();
  const est = useMemo(() => {
    void objects; void printerId;
    const cfg = currentConfig();
    const { top } = partSize(w);
    if (!top) return null;
    const band = Math.max(0, Math.min(w.z_end, top) - w.z_start);
    const fl = filaments.length > 1 ? effectiveFlush(filaments.map((f) => f.color), flushMatrix, flushMultiplier) : [[0]];
    let flush = 0, n = 0;
    w.slots.forEach((a, i) => { const b = w.slots[(i + 1) % w.slots.length]; if (a !== b) { flush += fl[a]?.[b] ?? 0; n++; } });
    // a tool changer swaps heads: no flush, only the small prime after the pick-up
    const tc = changerOf(cfg) === 'toolchanger';
    const ww = tc && w.change.mode !== 'bleed' ? { ...w, change: { mode: 'reduced' as const, volume_mm3: Number(cfg.tool_prime_volume) || 0 } } : w;
    return estimateWeave(ww, { bandMm: band, layerHeight: Number(cfg.layer_height) || 0.2, changeTime: Number(cfg.filament_change_time) || (tc ? 8 : 60), flushMm3: n ? flush / n : 0, filamentDensity: Number(cfg.filament_density) || 1.24 });
  }, [w, filaments, flushMatrix, flushMultiplier, objects, printerId, w.change.mode, w.change.volume_mm3, w.layers_per_colour, w.slots.join(), w.z_start, w.z_end]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!est) return <p className="mx-muted" style={{ margin: 0 }}>Put a part on the plate to see the estimate.</p>;
  const cfg = currentConfig(), kind = changerOf(cfg);
  const changeS = Number(cfg.filament_change_time) || (kind === 'toolchanger' ? 8 : 60);
  const what = kind === 'toolchanger' ? 'head swaps' : kind === 'manual' ? 'manual spool swaps' : `${unitName(cfg)} changes`;
  const where = kind === 'toolchanger' ? 'primed' : purgeTarget(cfg) === 'chute' ? 'purged into the chute' : 'purged into the prime tower';
  return (
    <div className="mx-card" style={{ padding: 8, gap: 2 }}>
      <div className="mx-check"><span className="ok">≡</span>{est.wovenLayers} woven layers · {est.rows} picture rows of {est.rowMm.toFixed(2)} mm (picture has {w.image.h})</div>
      {w.mode === 'colour' && <div className="mx-check"><span className={est.changes > 300 ? 'bad' : 'ok'}>⇄</span>{est.changes} {what} at ~{Math.round(changeS)} s each{kind === 'manual' ? '' : ' plus purge'} · +{formatDuration(est.changeSeconds)}</div>}
      {w.mode === 'colour' && kind === 'manual' && est.changes > 0 && <div className="mx-check"><span className="bad">!</span>Someone must swap the spool {est.changes} times: use Mono relief on this printer</div>}
      {w.mode === 'colour' && <div className="mx-check"><span className={est.purgeGrams > 100 ? 'bad' : 'ok'}>◔</span>{w.change.mode === 'bleed' ? 'No purge waste (bleed)' : `${est.purgeGrams.toFixed(0)} g ${where}`}</div>}
      {w.mode === 'mono' && <div className="mx-check"><span className="ok">✓</span>No filament changes</div>}
    </div>
  );
}

function WeaveReport() {
  const result = useStore((s) => s.slice.result);
  const dirty = useStore((s) => s.slice.dirty);
  const rep = (result?.pluginReports?.motionex as MotionexReport | undefined)?.weave;
  if (!rep) return null;
  const rows: [boolean, string][] = [
    [rep.loops > 0, rep.loops ? `${rep.loops} woven loops on ${rep.wovenLayers} layers` : 'No woven loop found: check the band heights and turn spiral vase off'],
    [rep.swing <= 0.6 * rep.lineWidth, `Steps ${rep.swing.toFixed(2)} mm in and out between layers (line ${rep.lineWidth.toFixed(2)} mm)`],
    [true, `${rep.changes} colour changes · ${rep.seamsTucked} seams tucked inside`],
  ];
  const wv = rep.wave;
  if (wv) {
    rows.push([wv.layers > 0, wv.layers ? `Texture on ${wv.layers} layers${wv.stitch ? `, stitches from ${wv.stitch.toFixed(1)} mm` : ''}` : 'No layer got the texture: check the heights and zones']);
    if (wv.zones) rows.push([wv.zonesUsed === wv.zones, `${wv.zonesUsed} of ${wv.zones} zone${wv.zones > 1 ? 's' : ''} meet the wall`]);
    rows.push([wv.swing <= rep.lineWidth, `Layers swing up to ${wv.swing.toFixed(2)} mm apart (line ${rep.lineWidth.toFixed(2)} mm)${wv.swing > rep.lineWidth ? ': they only touch where the waves cross' : ''}`]);
    if (wv.edgeLoops) rows.push([true, `Ribs and sharp edges kept smooth on ${wv.edgeLoops} loops`]);
  }
  return (
    <div>
      <div className="mx-label">Last slice{dirty ? ' (out of date)' : ''}</div>
      {rows.map(([ok, t], k) => <div key={k} className="mx-check"><span className={ok ? 'ok' : 'bad'}>{ok ? '✓' : '!'}</span>{t}</div>)}
    </div>
  );
}
