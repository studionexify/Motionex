// Right side of the Clickex Studio: where the design comes from (image, SVG, icon, text, key blocks or a 3D
// model), with a drop zone, samples and the settings that belong to that source.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { artToSvg } from '../art';
import { SOURCES, type Source } from '../model';
import { sampleArt, SAMPLES } from '../samples';
import { SAMPLE_MODELS } from '../models';
import { SYMBOLS } from '../symbols';
import { fontList } from '../../patternex/tools/text';
import type { IndexedMesh } from '../../../engine/mesh';
import { Ico, Note, Row, Seg, Slider, Toggle } from './controls';
import { artWarnings, cx, edit, importImage, importModel, importSvg, modelInfo, res, say, setSource, useCx, useSampleModel } from './state';
import { loadIcons, type Art } from '../art';

const SRC_ICON: Record<Source, string> = { image: 'image', svg: 'pen-tool', icon: 'sticker', text: 'type', blocks: 'blocks', model: 'cuboid' };

export function SourceTabs() {
  useCx();
  return (
    <div className="cx-sources">
      {SOURCES.map((s) => <button key={s.id} className={cx.spec.source === s.id ? 'on' : ''} onClick={() => setSource(s.id)}><Ico name={SRC_ICON[s.id]} size={20} /><span>{s.name}</span></button>)}
    </div>
  );
}

function Drop({ accept, title, hint, onFile }: { accept: string; title: string; hint: string; onFile: (f: File) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const run = (f?: File) => { if (f) onFile(f).catch((e) => say(`Could not open ${f.name}: ${(e as Error).message}`)); };
  return (
    <div className={`cx-drop ${over ? 'over' : ''}`} onClick={() => input.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); run(e.dataTransfer.files[0]); }}>
      <Ico name="upload" size={26} />
      <b>{title}</b>
      <span>{hint}</span>
      <input ref={input} type="file" accept={accept} hidden onChange={(e) => { run(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
}

const sampleThumb = (a: Art) => artToSvg(a, 56, 0.08);
const thumbCache = new Map<string, string>();
const cached = (id: string, f: () => string) => { let t = thumbCache.get(id); if (!t) { t = f(); thumbCache.set(id, t); } return t; };

function Samples({ title = 'Samples' }: { title?: string }) {
  return (
    <>
      <div className="cx-eyebrow">{title}</div>
      <div className="cx-samples">
        {SAMPLES.map((s) => (
          <button key={s.id} className={cx.spec.source === 'svg' && !cx.spec.svg.text && cx.spec.svg.sample === s.id ? 'on' : ''} title={s.name}
            onClick={() => edit((x) => { x.source = 'svg'; x.svg = { name: s.name, text: '', sample: s.id }; x.name = s.name; })}>
            <span dangerouslySetInnerHTML={{ __html: cached(`s:${s.id}`, () => sampleThumb(sampleArt(s.id))) }} />
            <small>{s.name}</small>
          </button>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- image
function ImageSource() {
  const s = cx.spec, [adjust, setAdjust] = useState(false);
  return (
    <>
      <Drop accept="image/*" title="Upload image" hint="Drop an image, or click to browse" onFile={importImage} />
      {s.image && <Note>{s.image.name} · {s.image.w} × {s.image.h}px</Note>}
      <button className="cx-btn" disabled={!s.image} onClick={() => setAdjust(true)}>Adjust image…</button>
      <Toggle label="Remove background" value={s.trace.removeBg} help="Treats the colour that touches the image border as background and leaves it out. PNG transparency is always respected." set={(v) => edit((x) => { x.trace.removeBg = v; })} />
      {artWarnings(s).map((w, i) => <Note key={i} kind="warn">{w}</Note>)}
      <Samples />
      {adjust && (
        <div className="cx-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) setAdjust(false); }}>
          <div className="cx-dialog">
            <div className="cx-title">Adjust image</div>
            <Slider label="Colours" value={s.trace.colors} min={1} max={4} help="How many filament colours the picture is reduced to." set={(v) => edit((x) => { x.trace.colors = v; }, 'tcol')} tag="tcol" />
            <Slider label="Transparency cut-off" value={s.trace.alphaCut} min={1} max={254} help="Pixels more transparent than this are left out." set={(v) => edit((x) => { x.trace.alphaCut = v; }, 'talpha')} tag="talpha" />
            <Slider label="Smoothing" value={s.trace.smooth} min={0.05} max={1.5} step={0.05} unit="mm" set={(v) => edit((x) => { x.trace.smooth = v; }, 'tsm')} tag="tsm" />
            <Slider label="Remove specks" value={s.trace.speck} min={0} max={8} step={0.1} unit="mm²" set={(v) => edit((x) => { x.trace.speck = v; }, 'tsp')} tag="tsp" />
            <button className="cx-btn primary" onClick={() => setAdjust(false)}>Done</button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- svg
function SvgSource() {
  const s = cx.spec;
  const [paste, setPaste] = useState('');
  return (
    <>
      <Drop accept=".svg,image/svg+xml" title="Upload SVG" hint="Drop an SVG, or click to browse · filled shapes only" onFile={importSvg} />
      {s.svg.text && <Note>{s.svg.name || 'SVG'} · <button className="cx-link" onClick={() => edit((x) => { x.svg.text = ''; })}>use a sample instead</button></Note>}
      <details className="cx-more"><summary>Paste SVG code</summary>
        <textarea className="cx-text" rows={4} value={paste} placeholder="<svg viewBox=…>" onChange={(e) => setPaste(e.target.value)} />
        <button className="cx-btn small" disabled={!paste.includes('<svg')} onClick={() => edit((x) => { x.svg = { name: 'Pasted SVG', text: paste, sample: x.svg.sample }; })}>Use this SVG</button>
      </details>
      {artWarnings(s).map((w, i) => <Note key={i} kind="warn">{w}</Note>)}
      <Samples />
    </>
  );
}

// ---------------------------------------------------------------- icons
function IconSource() {
  const s = cx.spec;
  const [q, setQ] = useState('');
  const [all, setAll] = useState<Record<string, [string, Record<string, string>][]> | null>(null);
  useEffect(() => { loadIcons().then((m) => setAll(m)); }, []);
  const names = useMemo(() => (all ? Object.keys(all).filter((n) => n.includes(q.trim().toLowerCase().replace(/\s+/g, '-'))) : []), [all, q]);
  const shown = names.slice(0, 240);
  return (
    <>
      <input className="cx-search" placeholder="Search Lucide icons…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="cx-count">{all ? `${Object.keys(all).length} icons · showing ${shown.length}` : 'Loading icons…'}</div>
      <div className="cx-icons">
        {shown.map((n) => (
          <button key={n} className={s.icon.name === n ? 'on' : ''} title={n} onClick={() => edit((x) => { x.icon.name = n; x.name = n; if (x.shape.baseStyle === 'outline') x.shape.baseStyle = 'shape'; })}>
            <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {all![n].map(([tag, attrs], i) => { const T = tag as 'path'; return <T key={i} {...(attrs as object)} />; })}
            </svg>
          </button>
        ))}
      </div>
      <Slider label="Line weight" value={s.icon.stroke} min={1} max={4} step={0.1} help="Icons are drawn as lines: this thickens them into solid shapes." set={(v) => edit((x) => { x.icon.stroke = v; }, 'istroke')} tag="istroke" />
    </>
  );
}

// ---------------------------------------------------------------- text
function TextSource() {
  const t = cx.spec.text;
  return (
    <>
      <Row label="Text" help="Use a new line for a second line.">
        <textarea className="cx-text" rows={2} value={t.text} onChange={(e) => edit((x) => { x.text.text = e.target.value; x.name = e.target.value.split('\n')[0].slice(0, 24) || x.name; }, 'text')} />
      </Row>
      <Row label="Typeface"><select className="cx-select" value={t.font} onChange={(e) => edit((x) => { x.text.font = e.target.value; })}>{fontList().map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Row>
      <Slider label="Bolden" value={t.weight} min={0} max={1.5} step={0.05} unit="mm" help="Grows the letters so thin strokes survive printing." set={(v) => edit((x) => { x.text.weight = v; }, 'tw')} tag="tw" />
      <Slider label="Letter spacing" value={t.tracking} min={-100} max={400} step={10} set={(v) => edit((x) => { x.text.tracking = v; }, 'tt')} tag="tt" />
      <Slider label="Line spacing" value={t.lineHeight} min={0.8} max={2} step={0.05} set={(v) => edit((x) => { x.text.lineHeight = v; }, 'tl')} tag="tl" />
      <Slider label="Arc" value={t.arc} min={-120} max={120} unit="mm" help="Bends the text along a circle of this radius (0 = straight)." set={(v) => edit((x) => { x.text.arc = v; }, 'ta')} tag="ta" />
    </>
  );
}

// ---------------------------------------------------------------- blocks
function BlocksSource() {
  const b = cx.spec.blocks;
  const multi = b.layout === 'grid' || b.layout === 'custom';
  const fixed = b.layout === 'wasd' || b.layout === 'arrows';
  const [sym, setSym] = useState(false);
  const label = b.layout === 'column' ? 'Column' : b.layout === 'row' ? 'Row' : 'Keys';
  const count = useMemo(() => (b.text.match(/\{[a-z]+\}|[^\n]/g) ?? []).length, [b.text]);
  return (
    <>
      <div className="cx-row-head"><span className="cx-label">Text</span>
        <span className="cx-menu"><button className="cx-btn small" onClick={() => setSym(!sym)}>Add symbol</button>
          {sym && <div className="cx-pop">{SYMBOLS.map((y) => <button key={y.id} onClick={() => { edit((x) => { x.blocks.text += `{${y.id}}`; }); setSym(false); }}>{y.name}</button>)}</div>}
        </span>
      </div>
      {fixed ? <Note>The {b.layout === 'wasd' ? 'W A S D' : 'arrow'} layout has fixed keys.</Note> : (
        <div className="cx-keytext">
          <span>{label}</span>
          {multi
            ? <textarea className="cx-text" rows={3} value={b.text} onChange={(e) => edit((x) => { x.blocks.text = e.target.value; }, 'btext')} />
            : <input className="cx-input" value={b.text.replace(/\n/g, '')} onChange={(e) => edit((x) => { x.blocks.text = e.target.value.replace(/\n/g, ''); }, 'btext')} />}
          <em>{count} keys</em>
        </div>
      )}
      <Note>Type a name or a word: each letter becomes its own key with its own switch. Symbols are written like {'{heart}'}.</Note>
    </>
  );
}

// ---------------------------------------------------------------- 3D model
function modelThumb(m: IndexedMesh, size = 96): string {
  if (typeof document === 'undefined') return '';
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); if (!g) return '';
  const v = m.vertices, ix = m.indices;
  // fixed three-quarter view; Z up
  const ca = Math.cos(0.7), sa = Math.sin(0.7), cb = Math.cos(0.55), sb = Math.sin(0.55);
  const P = (i: number): [number, number, number] => {
    const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
    const x1 = x * ca - y * sa, y1 = x * sa + y * ca;
    return [x1, z * cb - y1 * sb, y1 * cb + z * sb];
  };
  const pts: [number, number, number][] = [];
  for (let i = 0; i < v.length / 3; i++) pts.push(P(i));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const k = (size * 0.86) / Math.max(x1 - x0, y1 - y0, 1e-6);
  const tris: { d: number; s: number; t: number }[] = [];
  for (let t = 0; t < ix.length; t += 3) {
    const a = pts[ix[t]], b = pts[ix[t + 1]], d = pts[ix[t + 2]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    if (nz / l < 0) continue;
    tris.push({ d: (a[2] + b[2] + d[2]) / 3, s: 0.35 + 0.65 * Math.max(0, (nx * -0.3 + ny * 0.7 + nz * 0.6) / l), t });
  }
  tris.sort((p, q) => q.d - p.d);
  for (const tr of tris) {
    const a = pts[ix[tr.t]], b = pts[ix[tr.t + 1]], d = pts[ix[tr.t + 2]];
    const sx = (p: number[]) => (p[0] - (x0 + x1) / 2) * k + size / 2, sy = (p: number[]) => size / 2 - (p[1] - (y0 + y1) / 2) * k;
    g.fillStyle = `rgb(${Math.round(240 * tr.s)},${Math.round(150 * tr.s)},${Math.round(60 * tr.s)})`;
    g.beginPath(); g.moveTo(sx(a), sy(a)); g.lineTo(sx(b), sy(b)); g.lineTo(sx(d), sy(d)); g.closePath(); g.fill();
  }
  return c.toDataURL();
}

function ModelSource() {
  const info = modelInfo();
  const thumbs = useMemo(() => SAMPLE_MODELS.map((m) => ({ id: m.id, name: m.name, url: modelThumb(m.make()) })), []);
  return (
    <>
      <Drop accept=".stl,.obj,.3mf" title="Upload a 3D model" hint="Drop an STL, 3MF or OBJ, or click to browse" onFile={importModel} />
      {info && <div className="cx-count">{info.name} · {info.tris.toLocaleString()} triangles · {info.size.map((v) => v.toFixed(0)).join(' × ')} mm</div>}
      <div className="cx-eyebrow">Or try a sample</div>
      <div className="cx-samples">
        {thumbs.map((t) => <button key={t.id} className={res.model?.name.toLowerCase() === t.id ? 'on' : ''} title={t.name} onClick={() => useSampleModel(t.id)}><img src={t.url} alt={t.name} width={56} height={56} /><small>{t.name}</small></button>)}
      </div>
    </>
  );
}

export function SourcePanel() {
  useCx();
  const body: Record<Source, ReactNode> = { image: <ImageSource />, svg: <SvgSource />, icon: <IconSource />, text: <TextSource />, blocks: <BlocksSource />, model: <ModelSource /> };
  return (
    <>
      <div className="cx-eyebrow big">Import source</div>
      <SourceTabs />
      <div className="cx-source-body">{body[cx.spec.source]}</div>
    </>
  );
}

export { Seg };
