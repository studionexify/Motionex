// Wave texture controls, in plain words: ready-made textures, three sliders (how far the line swings,
// how long a stitch is, what the next layer does), the stitch shape, and a strip that shows the line
// seen from above with the next layers on top of it. The same controls set the whole-part wave (Weave
// card) and each wave zone (zone list, Inspector). Zones are modifier shapes and height bands.
import { useMemo } from 'react';
import { useStore, type SceneObject, type ScenePart, type HeightRange } from '../../../state/store';
import { addWaveBand, addWaveZone, updateHeightRange, updatePart } from '../../../state/ops';
import { currentConfig } from '../../../state/slicing';
import { WAVE_KEYS, type Config } from '../../../profiles/settings';
import { effectPhase, waveValue } from '../modifier';
import { WAVE_PRESETS, presetOf, type WaveStyle } from '../weave/model';
import { isWaveZone, ownStyle } from '../weave/zones';
import { pickStyle, waveEffect } from '../weave/wave';
import type { ShapeKind } from '../../../state/ops';

const SHAPES: [WaveStyle['shape'], string, string][] = [
  ['sine', 'Smooth', 'Round, even stitches'], ['triangle', 'Pointed', 'Sharp zigzag stitches'],
  ['square', 'Square', 'Blocky stitches with flat tops'], ['rounded', 'Rounded', 'Blocks with soft corners'],
];

/** What the next layer does, as one choice: flip every n layers, slide on (twill) or never (ribs). */
const NEXT: { id: string; label: string; style: Pick<WaveStyle, 'flip_every' | 'flip_deg' | 'flip_mode'> }[] = [
  { id: 'a1', label: 'Swaps every layer (knit)', style: { flip_every: 1, flip_deg: 180, flip_mode: 'alternate' } },
  { id: 'a2', label: 'Swaps every 2 layers', style: { flip_every: 2, flip_deg: 180, flip_mode: 'alternate' } },
  { id: 'a3', label: 'Swaps every 3 layers', style: { flip_every: 3, flip_deg: 180, flip_mode: 'alternate' } },
  { id: 'a4', label: 'Swaps every 4 layers', style: { flip_every: 4, flip_deg: 180, flip_mode: 'alternate' } },
  { id: 'a6', label: 'Swaps every 6 layers', style: { flip_every: 6, flip_deg: 180, flip_mode: 'alternate' } },
  { id: 'a8', label: 'Swaps every 8 layers', style: { flip_every: 8, flip_deg: 180, flip_mode: 'alternate' } },
  { id: 's1', label: 'Slides along (diagonal)', style: { flip_every: 1, flip_deg: 90, flip_mode: 'steady' } },
  { id: 'n', label: 'Stays put (straight ribs)', style: { flip_every: 0, flip_deg: 180, flip_mode: 'alternate' } },
];
const nextOf = (s: WaveStyle) => {
  if (!(s.flip_every > 0) || !s.flip_deg) return 'n';
  if (s.flip_mode === 'steady') return 's1';
  return NEXT.find((n) => n.style.flip_mode === 'alternate' && n.style.flip_every === s.flip_every)?.id ?? 'a1';
};

/** Outer wall line width (mm) of the current printer settings. */
const lineWidth = () => { const c = currentConfig(); return Number(c.outer_wall_line_width) || Number(c.line_width) || 1.05 * (Number(c.nozzle_diameter) || 0.4); };

/**
 * The line seen from above (in and out of the wall, across) along three stitches, with the next layers
 * drawn over it: crest over trough shows how the layers lock together.
 */
export function WaveStrip({ style, colours, layers = 3, height = 64, small = false }: { style: WaveStyle; colours: string[]; layers?: number; height?: number; small?: boolean }) {
  const W = small ? 60 : 300, H = height, mid = H / 2, amp = H * 0.3;
  const paths = useMemo(() => {
    const len = Math.max(0.2, style.length_mm), span = 3 * len, n = small ? 40 : 150;
    return Array.from({ length: layers }, (_, k) => {
      const ph = effectPhase(waveEffect(style), k) ?? 0;
      let d = '';
      for (let i = 0; i <= n; i++) {
        const s = (i / n) * span, y = mid - amp * waveValue(style.shape, s / len + ph / 360);
        d += `${i ? 'L' : 'M'}${((i / n) * W).toFixed(1)},${y.toFixed(1)}`;
      }
      return d;
    });
  }, [style.shape, style.length_mm, style.flip_every, style.flip_deg, style.flip_mode, layers, small, W, mid, amp]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={small ? 'mx-wave sm' : 'wave-strip'} preserveAspectRatio="none" aria-hidden>
      {!small && <line x1={0} x2={W} y1={mid} y2={mid} stroke="var(--text-muted)" strokeDasharray="3 3" strokeWidth={1} opacity={0.5} />}
      {paths.map((d, k) => (
        <path key={k} d={d} fill="none" stroke={colours[k % colours.length] ?? 'var(--accent)'} strokeWidth={small ? 2 : 5 - k}
          strokeLinecap="round" strokeLinejoin="round" opacity={k ? 0.9 - 0.15 * k : 1} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

/** Ready-made textures as tiles; Smooth (null) means no wave. */
function PresetTiles({ value, onPick, colours }: { value: WaveStyle | null; onPick: (s: WaveStyle | null) => void; colours: string[] }) {
  const on = presetOf(value);
  return (
    <div className="mx-lib-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(68px, 1fr))' }}>
      {WAVE_PRESETS.map((p) => (
        <button key={p.id} className={`mx-lib-card ${on === p.id ? 'on' : ''}`} title={p.description} aria-pressed={on === p.id} onClick={() => onPick(p.style ? { ...p.style } : null)}>
          {p.style ? <WaveStrip style={p.style} colours={colours} layers={2} height={22} small /> : <svg viewBox="0 0 60 22" className="mx-wave sm" aria-hidden><path d="M0,11L60,11" stroke={colours[0]} strokeWidth={2} vectorEffect="non-scaling-stroke" /></svg>}
          <span>{p.name}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Wave texture editor. `value` null = smooth wall (no wave). `onChange` gets the whole new style, or null
 * for smooth.
 */
export function WaveControls({ value, onChange, colours, hideTiles = false }: { value: WaveStyle | null; onChange: (s: WaveStyle | null) => void; colours: string[]; hideTiles?: boolean }) {
  const lw = lineWidth();
  const set = (patch: Partial<WaveStyle>) => value && onChange({ ...value, ...patch });
  const preset = presetOf(value);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {!hideTiles && <PresetTiles value={value} onPick={onChange} colours={colours} />}
      {value && (
        <>
          <div className="wave-strip-box" title="The line seen from above, along three stitches: this layer and the next ones on top">
            <WaveStrip style={value} colours={colours} />
            <div className="studio-legend">{colours.slice(0, 3).map((c, k) => <span key={k}><i className="lg" style={{ background: c }} />{k ? `layer ${k + 1}` : 'seen from above · layer 1'}</span>)}</div>
          </div>
          <label className="mx-field">Wave height: {value.height_mm.toFixed(2)} mm {preset === 'custom' ? '' : `(${WAVE_PRESETS.find((p) => p.id === preset)?.name})`}
            <input type="range" min={0.05} max={1.5} step={0.01} value={value.height_mm} aria-label="Wave height" title="How far the line swings in and out of the wall" onChange={(e) => set({ height_mm: +e.target.value })} />
          </label>
          <label className="mx-field">Stitch size: {value.length_mm.toFixed(1)} mm
            <input type="range" min={0.6} max={12} step={0.1} value={value.length_mm} aria-label="Stitch size" title="Length of one stitch along the wall: one swing out and back" onChange={(e) => set({ length_mm: +e.target.value })} />
          </label>
          <label className="mx-field">Next layer
            <select className="select" value={nextOf(value)} aria-label="Next layer" onChange={(e) => set(NEXT.find((n) => n.id === e.target.value)!.style)}>
              {NEXT.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
          </label>
          <div className="seg mx-seg" role="group" aria-label="Stitch shape">
            {SHAPES.map(([id, label, tip]) => <button key={id} className={value.shape === id ? 'on' : ''} title={tip} onClick={() => set({ shape: id })}>{label}</button>)}
          </div>
          {2 * value.height_mm > lw && value.flip_every > 0 && <p className="mx-muted bad" style={{ margin: 0 }}>Neighbouring layers swing {(2 * value.height_mm).toFixed(2)} mm apart, more than the {lw.toFixed(2)} mm line: they only touch where the waves cross, so the wall may be weak. Lower the wave height.</p>}
          {value.length_mm < 4 * value.height_mm && <p className="mx-muted bad" style={{ margin: 0 }}>Short, tall stitches turn very sharply: they print slowly and may blob. Make the stitches longer.</p>}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ zones

/** A wave zone on an object: a modifier shape or a height band. */
export type ZoneRef = { obj: SceneObject; part: ScenePart; range?: undefined } | { obj: SceneObject; range: HeightRange; part?: undefined };

/** The wave zones of some objects, in the order they apply. */
export function zonesOf(objs: SceneObject[]): ZoneRef[] {
  const out: ZoneRef[] = [];
  for (const obj of objs) {
    for (const range of obj.heightRanges ?? []) if (isWaveZone(range.overrides)) out.push({ obj, range });
    for (const part of obj.parts ?? []) if (part.type === 'modifier' && isWaveZone(part.overrides)) out.push({ obj, part });
  }
  return out;
}

const overridesOf = (z: ZoneRef): Config => (z.part ? z.part.overrides : z.range.overrides);
function writeZone(z: ZoneRef, fn: (ov: Config) => Config) {
  if (z.part) updatePart(z.obj.id, z.part.id, (p) => ({ ...p, overrides: fn({ ...p.overrides }) }));
  else updateHeightRange(z.obj.id, z.range.id, { overrides: fn({ ...z.range.overrides }) });
  useStore.getState().markDirty();
  window.dispatchEvent(new Event('nx-plugin-preview'));
}
const styleKeys = WAVE_KEYS.filter((k) => k !== 'wave_mode' && k !== 'wave_blend');

/** Name shown for a zone. */
export const zoneName = (z: ZoneRef) => (z.part ? z.part.name : `Height band ${z.range.z0}–${z.range.z1} mm`);

/**
 * One zone: wave here or keep plain, the whole part's texture or its own, and its soft edge. `base` is the
 * whole-part style the zone follows unless it has its own.
 */
export function WaveZoneEditor({ zone, base, colours, blendDefault }: { zone: ZoneRef; base: WaveStyle; colours: string[]; blendDefault: number }) {
  const ov = overridesOf(zone);
  const plain = ov.wave_mode === 'plain';
  const own = styleKeys.some((k) => k in ov);
  const style: WaveStyle = { ...base, ...ownStyle(ov) };
  const blend = Number(ov.wave_blend ?? blendDefault);
  const setOwn = (s: WaveStyle | null) => writeZone(zone, (o) => {
    if (!s) { o.wave_mode = 'plain'; for (const k of styleKeys) delete o[k]; return o; }
    o.wave_mode = 'wave';
    o.wave_shape = s.shape; o.wave_height = s.height_mm; o.wave_length = s.length_mm;
    o.wave_flip_every = s.flip_every; o.wave_flip_deg = s.flip_deg; o.wave_flip_mode = s.flip_mode;
    return o;
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="seg mx-seg" role="group" aria-label="In this zone">
        <button className={!plain ? 'on' : ''} title="The wave goes on the wall inside this zone" onClick={() => writeZone(zone, (o) => ({ ...o, wave_mode: 'wave' }))}>Wave here</button>
        <button className={plain ? 'on' : ''} title="The wall stays smooth inside this zone (the wave fades out at its edge)" onClick={() => writeZone(zone, (o) => ({ ...o, wave_mode: 'plain' }))}>Keep plain</button>
      </div>
      {!plain && (
        <>
          <div className="seg mx-seg" role="group" aria-label="Texture in this zone">
            <button className={!own ? 'on' : ''} title="Use the whole part's texture here" onClick={() => writeZone(zone, (o) => { for (const k of styleKeys) delete o[k]; return o; })}>Same as whole part</button>
            <button className={own ? 'on' : ''} title="Give this zone a texture of its own" onClick={() => setOwn(pickStyle(style))}>Own texture</button>
          </div>
          {own && <WaveControls value={style} onChange={setOwn} colours={colours} />}
        </>
      )}
      <label className="mx-field">Soft edge: {blend.toFixed(1)} mm {blend < style.length_mm ? `(at least one stitch: ${style.length_mm.toFixed(1)} mm)` : ''}
        <input type="range" min={0.5} max={15} step={0.5} value={blend} aria-label="Soft edge" title="How long the wave takes to fade in and out at the zone's edge, along the wall and from layer to layer" onChange={(e) => writeZone(zone, (o) => ({ ...o, wave_blend: +e.target.value }))} />
      </label>
    </div>
  );
}

const ZONE_SHAPES: [ShapeKind | 'band', string, string][] = [
  ['band', 'Height band', 'A start and an end height, all the way round'], ['box', 'Box', 'A block you can move, turn and stretch'],
  ['cylinder', 'Cylinder', 'A round column'], ['sphere', 'Sphere', 'A ball: scale it for an oval (eye) shape'],
  ['cone', 'Cone', 'A cone'], ['disc', 'Disc', 'A flat round slab'], ['torus', 'Ring', 'A ring round the part'],
];

/** "+ Add zone" menu: a height band or a modifier shape on `obj`, selected so its handles show. */
export function AddZone({ obj, plain = false }: { obj: SceneObject | undefined; plain?: boolean }) {
  const ov: Config = { wave_mode: plain ? 'plain' : 'wave' };
  return (
    <select className="select" disabled={!obj} value="" aria-label="Add zone" title={obj ? `Add a zone on ${obj.name}: the wave changes only where it meets the part` : 'Put a part on the plate first'}
      onChange={(e) => {
        const k = e.target.value as ShapeKind | 'band';
        if (!obj || !k) return;
        if (k === 'band') addWaveBand(obj.id, ov); else addWaveZone(obj.id, k, ov);
        window.dispatchEvent(new Event('nx-plugin-preview'));
      }}>
      <option value="">+ Add zone…</option>
      {ZONE_SHAPES.map(([k, label, tip]) => <option key={k} value={k} title={tip}>{label}</option>)}
    </select>
  );
}
