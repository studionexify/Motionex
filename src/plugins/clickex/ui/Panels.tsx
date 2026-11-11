// Left side of the Clickex Studio: an icon rail and the settings of the selected tab.
import { useState } from 'react';
import { artToSvg } from '../art';
import { BASE_SHAPES, baseShapePaths } from '../catalog';
import { effectiveSwitch } from '../plan';
import { LAYOUTS, type BlockLayout, type ClickexSpec, type DesignMode, type EdgeKind, type EdgeProfile, type ModelCut } from '../model';
import { clampEdge, edgeInset } from '../build';
import { fontList } from '../../patternex/tools/text';
import { SWITCHES } from '../catalog';
import { Cards, Ico, Note, Row, Seg, Slider, Toggle } from './controls';
import { FilamentButton } from '../../../ui/studio/Studio';
import { compute, cx, designColors, edit, matchFilaments, modelInfo, say, setTab, transferFitTest, turnModel, useCx } from './state';
import { blockKeys } from '../plan';

export interface TabDef { id: string; label: string; icon: string }

export function tabsFor(source: ClickexSpec['source']): TabDef[] {
  const common: TabDef[] = [{ id: 'body', label: 'Body', icon: 'flower-2' }, { id: 'colors', label: 'Colors', icon: 'droplet' }, { id: 'switch', label: 'Switch', icon: 'crosshair' }, { id: 'keychain', label: 'Keychain', icon: 'link' }, { id: 'fit', label: 'Fit', icon: 'ruler' }];
  if (source === 'blocks') return [{ id: 'layout', label: 'Layout', icon: 'layout-grid' }, { id: 'font', label: 'Font', icon: 'type' }, { id: 'lettering', label: 'Lettering', icon: 'sliders-horizontal' }, ...common];
  if (source === 'model') return [{ id: 'cut', label: 'Cut', icon: 'layers' }, { id: 'model', label: 'Model', icon: 'box' }, { id: 'colors', label: 'Colors', icon: 'droplet' }, { id: 'switch', label: 'Switch', icon: 'crosshair' }, { id: 'fit', label: 'Fit', icon: 'ruler' }];
  return [{ id: 'shape', label: 'Shape', icon: 'scan' }, ...common];
}

export function Rail() {
  useCx();
  const tabs = tabsFor(cx.spec.source);
  const active = tabs.find((t) => t.id === cx.tab) ?? tabs[0];
  return (
    <nav className="cx-rail" aria-label="Settings">
      {tabs.map((t) => (
        <button key={t.id} className={t.id === active.id ? 'on' : ''} onClick={() => setTab(t.id)} title={t.label}>
          <Ico name={t.icon} size={20} /><span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

const shapeThumb = (id: string) => artToSvg([{ color: 'currentColor', paths: baseShapePaths(id, 40) }], 44, 0.08);

function ShapePicker({ value, set }: { value: string; set: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const cur = BASE_SHAPES.find((s) => s.id === value) ?? BASE_SHAPES[0];
  return (
    <div className="cx-row">
      <div className="cx-row-head"><span className="cx-label">Base shape</span></div>
      <button className="cx-pick" onClick={() => setOpen(!open)}><span dangerouslySetInnerHTML={{ __html: shapeThumb(cur.id) }} />{cur.name}<Ico name={open ? 'chevron-up' : 'chevron-down'} size={16} /></button>
      {open && (
        <div className="cx-shapes">
          {BASE_SHAPES.map((s) => (
            <button key={s.id} className={s.id === value ? 'on' : ''} title={s.name} onClick={() => { set(s.id); setOpen(false); }}><span dangerouslySetInnerHTML={{ __html: shapeThumb(s.id) }} /></button>
          ))}
        </div>
      )}
    </div>
  );
}

function ShapePanel() {
  const s = cx.spec, c = compute();
  const outlineOff = s.source === 'icon';
  const outline = s.shape.baseStyle === 'outline' && !outlineOff;
  return (
    <>
      <div className="cx-title">Shape &amp; size</div>
      <Row label="Base style" help="Outline: the body follows the design's outline. Shape: a standard shape with the design on top.">
        <Seg value={outline ? 'outline' : 'shape'} options={[['outline', 'Outline'], ['shape', 'Shape']]}
          set={(v) => { if (v === 'outline' && outlineOff) { say('Icons are line art and need a solid base, so Outline is not available.'); return; } edit((x) => { x.shape.baseStyle = v; }); }} />
      </Row>
      {!outline && <ShapePicker value={s.shape.baseShape} set={(v) => edit((x) => { x.shape.baseShape = v; })} />}
      <Slider label="Size" value={s.shape.size} min={20} max={90} unit="mm" tag="size" help="Length of the longer side of the base." set={(v) => edit((x) => { x.shape.size = v; }, 'size')} />
      <Slider label="Design size" value={s.shape.designSize} min={20} max={200} unit="%" tag="dsize" disabled={outline} help="How large the design is on the base. In Outline style the design is the base." set={(v) => edit((x) => { x.shape.designSize = v; }, 'dsize')} />
      <Toggle label="Lock the base size" value={s.shape.lockBase} help="Off: the base grows by itself when the switch does not fit. On: the size stays exactly as set." set={(v) => edit((x) => { x.shape.lockBase = v; })} />
      {outline && (
        <>
          <Slider label="Border" value={s.shape.border} min={0.8} max={8} step={0.1} unit="mm" tag="border" help="Wall of base around the design's edge." set={(v) => edit((x) => { x.shape.border = v; }, 'border')} />
          <Slider label="Bridge gaps" value={s.shape.bridge} min={0} max={6} step={0.1} unit="mm" tag="bridge" help="Fills gaps between separate pieces so the body is one solid piece." set={(v) => edit((x) => { x.shape.bridge = v; }, 'bridge')} />
          <Toggle label="Fill holes" value={s.shape.fillHoles} help="Off: holes in the design stay open (small ones are always filled)." set={(v) => edit((x) => { x.shape.fillHoles = v; })} />
        </>
      )}
      {!outline && (
        <Row label="Move design" help="Nudge the design on the base (2 mm per click).">
          <div className="cx-dpad">
            <span /><button onClick={() => edit((x) => { x.shape.dy += 2; })} aria-label="Up"><Ico name="move-up" size={16} /></button><span />
            <button onClick={() => edit((x) => { x.shape.dx -= 2; })} aria-label="Left"><Ico name="move-left" size={16} /></button>
            <button onClick={() => edit((x) => { x.shape.dx = 0; x.shape.dy = 0; })} aria-label="Centre"><Ico name="crosshair" size={16} /></button>
            <button onClick={() => edit((x) => { x.shape.dx += 2; })} aria-label="Right"><Ico name="move-right" size={16} /></button>
            <span /><button onClick={() => edit((x) => { x.shape.dy -= 2; })} aria-label="Down"><Ico name="move-down" size={16} /></button><span />
          </div>
        </Row>
      )}
      <Slider label="Rotate design" value={s.shape.rot} min={-180} max={180} unit="°" tag="rot" set={(v) => edit((x) => { x.shape.rot = v; }, 'rot')} />
      <Toggle label="Mirror design" value={s.shape.flip} set={(v) => edit((x) => { x.shape.flip = v; })} />
      {c.plan?.warnings.map((w, i) => <Note key={i} kind="warn">{w}</Note>)}
    </>
  );
}

/** Side view of an edge profile: the part's corner, top face up, outside to the right. */
function EdgeSketch({ p }: { p: EdgeProfile }) {
  const W = 56, H = 34, pad = 4, sx = (W - 2 * pad) / Math.max(p.width, p.height, 0.5) * 0.6, x0 = W - pad, y0 = pad;
  const pts: [number, number][] = [[pad, y0]];
  const q = clampEdge(p, 99, 99);
  if (q.kind === 'none') pts.push([x0, y0], [x0, H - pad]);
  else {
    const n = 40;
    for (let j = 0; j <= n; j++) { const d = (q.height * j) / n; const e = edgeInset(q, Math.min(d, q.height - 1e-6)); pts.push([x0 - e * sx, y0 + d * sx]); if (q.kind === 'step' && j < n) { const d2 = (q.height * (j + 1)) / n; const e2 = edgeInset(q, Math.min(d2, q.height - 1e-6)); if (e2 !== e) pts.push([x0 - e * sx, y0 + d2 * sx]); } }
    pts.push([x0, y0 + q.height * sx], [x0, H - pad]);
  }
  pts.push([pad, H - pad]);
  return <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="cx-edge-sketch" aria-hidden><polygon points={pts.map((p) => p.join(',')).join(' ')} /></svg>;
}

const EDGE_KINDS: [EdgeKind, string][] = [['none', 'Square'], ['fillet', 'Fillet'], ['chamfer', 'Chamfer'], ['step', 'Steps']];

/** Edge profile of the button or the base: kind and its sizes. */
function EdgeEditor({ label, which, maxH, help }: { label: string; which: 'capEdge' | 'baseEdge'; maxH: number; help: string }) {
  const p = cx.spec.body[which];
  const set = (f: (e: EdgeProfile) => void, tag = '') => edit((x) => { f(x.body[which]); if (which === 'capEdge') x.body.capRound = x.body.capEdge.kind === 'fillet' ? x.body.capEdge.width : 0; }, tag && `${which}-${tag}`);
  return (
    <div className="cx-edge">
      <Row label={label} help={help} right={<EdgeSketch p={p} />}>
        <Seg value={p.kind} options={EDGE_KINDS} set={(v) => set((e) => { e.kind = v; })} />
      </Row>
      {p.kind === 'fillet' && <Slider label="Radius" value={p.width} min={0.2} max={Math.max(0.4, Math.min(4, maxH))} step={0.1} unit="mm" tag={`${which}-r`} set={(v) => set((e) => { e.width = v; e.height = v; }, 'r')} />}
      {(p.kind === 'chamfer' || p.kind === 'step') && <>
        <Slider label={p.kind === 'step' ? 'Total width' : 'Width'} value={p.width} min={0.2} max={5} step={0.1} unit="mm" tag={`${which}-w`} help="How far the edge reaches in from the side." set={(v) => set((e) => { e.width = v; }, 'w')} />
        <Slider label={p.kind === 'step' ? 'Total height' : 'Height'} value={Math.min(p.height, maxH)} min={0.2} max={Math.max(0.4, maxH)} step={0.1} unit="mm" tag={`${which}-h`} help="How far down the edge reaches." set={(v) => set((e) => { e.height = v; }, 'h')} />
      </>}
      {p.kind === 'step' && <Slider label="Steps" value={p.steps} min={1} max={8} step={1} tag={`${which}-n`} help="Number of ledges; each is one even part of the width and height." set={(v) => set((e) => { e.steps = Math.round(v); }, 'n')} />}
    </div>
  );
}

function BodyPanel() {
  const s = cx.spec, b = s.body;
  return (
    <>
      <div className="cx-title">Body</div>
      <Slider label="Button wall" value={b.wall} min={0.8} max={3} step={0.1} unit="mm" tag="wall" help="Wall of the button's skirt." set={(v) => edit((x) => { x.body.wall = v; }, 'wall')} />
      <Slider label="Button top" value={b.capTop} min={1.2} max={3.2} step={0.1} unit="mm" tag="captop" help="Thickness of the button's top plate (the coloured layer is cut into it)." set={(v) => edit((x) => { x.body.capTop = v; }, 'captop')} />
      <EdgeEditor label="Button top edge" which="capEdge" maxH={b.capTop} help="Shape of the button's top edge: a round, a straight bevel or a stair of ledges." />
      <EdgeEditor label="Base top edge" which="baseEdge" maxH={6} help="Shape of the base's top edge around the buttons." />
      <Slider label="Corner rounding" value={b.baseRound} min={0} max={8} step={0.1} unit="mm" tag="baseround" help="Rounds the corners of the outline in plan view." set={(v) => edit((x) => { x.body.baseRound = v; }, 'baseround')} />
      <Slider label="Rim wall" value={b.rimWall} min={0.8} max={2.5} step={0.1} unit="mm" tag="rim" help="The ring the button slides over; it hides the gap." set={(v) => edit((x) => { x.body.rimWall = v; }, 'rim')} />
      <Toggle label="Hide the gap" value={b.hideGap} help="Prints the rim in the button's colour so the gap under the button looks like part of the button." set={(v) => edit((x) => { x.body.hideGap = v; })} />
      <Row label="Floor" help="Solid: a closed bottom. Open: no floor, the switch pins stay reachable and the base prints with less material.">
        <Seg value={b.floor} options={[['solid', 'Solid'], ['open', 'Open']]} set={(v) => edit((x) => { x.body.floor = v; })} />
      </Row>
      <Slider label="Extra base height" value={b.extraHeight} min={0} max={20} step={0.5} unit="mm" tag="extra" help="Makes the base taller (more weight, more grip)." set={(v) => edit((x) => { x.body.extraHeight = v; }, 'extra')} />
    </>
  );
}

function ColorsPanel() {
  const s = cx.spec, colors = designColors();
  const mode = s.colors.mode;
  return (
    <>
      <div className="cx-title">Colors</div>
      <Row label="Base"><FilamentButton label="Base" hex={s.colors.base} onPick={(_, f) => edit((x) => { x.colors.base = f.color; })} /></Row>
      <Row label="Button"><FilamentButton label="Button" hex={s.colors.button} onPick={(_, f) => edit((x) => { x.colors.button = f.color; })} /></Row>
      {(s.source === 'icon' || s.source === 'text' || s.source === 'blocks') && <Row label={s.source === 'blocks' ? 'Lettering' : 'Design'}><FilamentButton label={s.source === 'blocks' ? 'Lettering' : 'Design'} hex={s.colors.ink} onPick={(_, f) => edit((x) => { x.colors.ink = f.color; })} /></Row>}
      {colors.length > 0 && s.source !== 'icon' && s.source !== 'text' && (
        <Row label="Design colours" help="Each colour of the artwork prints in its own filament. Change one to recolour it everywhere." right={<button className="cx-link" onClick={matchFilaments} title="Snap every design colour to the nearest loaded filament">Match loaded filaments</button>}>
          <div className="cx-colours">
            {colors.map((c) => <div key={c} className="cx-colour-row"><span className="cx-orig" style={{ background: c }} title={`Artwork colour ${c}`} /><FilamentButton label={`Artwork ${c}`} hex={s.colors.map[c] ?? c} onPick={(_, f) => edit((x) => { x.colors.map[c] = f.color; })} /></div>)}
          </div>
        </Row>
      )}
      <Row label="Design style" help="Color: the design is inlaid flush in its own colours. Raise: the design stands proud. Engrave: the design is cut into the button.">
        <Seg<DesignMode> value={mode} options={[['color', 'Color'], ['raise', 'Raise'], ['engrave', 'Engrave']]} set={(v) => edit((x) => { x.colors.mode = v; })} />
      </Row>
      {mode === 'raise'
        ? <Slider label="Raise height" value={s.colors.raise} min={0.2} max={3} step={0.1} unit="mm" tag="raise" help="Relief hangs below the face when printing: switch on supports for the button." set={(v) => edit((x) => { x.colors.raise = v; }, 'raise')} />
        : <Slider label={mode === 'engrave' ? 'Engrave depth' : 'Inlay depth'} value={s.colors.inlay} min={0.2} max={Math.max(0.4, s.body.capTop)} step={0.1} unit="mm" tag="inlay" set={(v) => edit((x) => { x.colors.inlay = v; }, 'inlay')} />}
      <Note>Every colour is a filament from the machine's list. A colour marked “Pick” is not loaded: choose a loaded filament, or keep it and it is added as “load before printing”.</Note>
    </>
  );
}

function SwitchPanel() {
  const s = cx.spec, sw = effectiveSwitch(s);
  const c = compute();
  return (
    <>
      <div className="cx-title">Switch</div>
      <Row label="Switch type" help="The shipped catalogue is MX-style (14 × 14 mm cut-out). Choc and others follow.">
        <select className="cx-select" value={s.sw.id} onChange={(e) => edit((x) => { x.sw.id = e.target.value; })}>{SWITCHES.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
      </Row>
      <Slider label="Button travel" value={s.sw.travel} min={2} max={4} step={0.1} unit="mm" tag="travel" help="How far the button moves. MX clicks at about 2 mm; 3 mm leaves a comfortable margin." set={(v) => edit((x) => { x.sw.travel = v; }, 'travel')} />
      <Toggle label="Place the switch automatically" value={s.sw.auto} help="Finds the widest spot of the body and turns the switch to whatever angle fits best." set={(v) => edit((x) => { x.sw.auto = v; })} />
      {!s.sw.auto && (
        <>
          <Slider label="Offset X" value={s.sw.dx} min={-30} max={30} step={0.5} unit="mm" tag="swx" set={(v) => edit((x) => { x.sw.dx = v; }, 'swx')} />
          <Slider label="Offset Y" value={s.sw.dy} min={-30} max={30} step={0.5} unit="mm" tag="swy" set={(v) => edit((x) => { x.sw.dy = v; }, 'swy')} />
          <Slider label="Turn" value={s.sw.angle} min={0} max={90} step={1} unit="°" tag="swa" set={(v) => edit((x) => { x.sw.angle = v; }, 'swa')} />
        </>
      )}
      <Slider label="Plate thickness" value={s.body.plate} min={1.2} max={2} step={0.1} unit="mm" tag="plate" help="The ledge the switch clips under. MX clips hold best between 1.2 and 2 mm." set={(v) => edit((x) => { x.body.plate = v; }, 'plate')} />
      <details className="cx-more"><summary>Switch dimensions</summary>
        <Slider label="Housing top above plate" value={s.sw.housingTop} min={4} max={9} step={0.1} unit="mm" tag="ht" help="Nominal 6.6 mm. Measure your switches with calipers if they come from another maker." set={(v) => edit((x) => { x.sw.housingTop = v; }, 'ht')} />
        <Slider label="Stem top above plate" value={s.sw.stemTop} min={8} max={13} step={0.1} unit="mm" tag="st" help="Nominal 10.2 mm at rest." set={(v) => edit((x) => { x.sw.stemTop = v; }, 'st')} />
        <Note>Plate cut-out {sw.cutout} mm · housing {sw.flange} mm · stem cross {sw.armLen} × {sw.armWid} mm · stem engagement {c.built ? c.built.report.engage : '…'} mm.</Note>
      </details>
    </>
  );
}

function KeychainPanel() {
  const k = cx.spec.keychain;
  return (
    <>
      <div className="cx-title">Keychain</div>
      <Toggle label="Add a keychain loop" value={k.enabled} set={(v) => edit((x) => { x.keychain.enabled = v; })} />
      {k.enabled && (
        <>
          <Slider label="Position" value={k.angle} min={0} max={360} unit="°" tag="kcangle" help="Direction around the body: 0° right, 90° top, 180° left, 270° bottom." set={(v) => edit((x) => { x.keychain.angle = v; }, 'kcangle')} />
          <Slider label="Loop diameter" value={k.outerD} min={7} max={16} step={0.5} unit="mm" tag="kcd" set={(v) => edit((x) => { x.keychain.outerD = v; }, 'kcd')} />
          <Slider label="Hole diameter" value={k.holeD} min={3} max={9} step={0.2} unit="mm" tag="kch" set={(v) => edit((x) => { x.keychain.holeD = v; }, 'kch')} />
          <Slider label="Thickness" value={k.thickness} min={1.2} max={5} step={0.2} unit="mm" tag="kct" set={(v) => edit((x) => { x.keychain.thickness = v; }, 'kct')} />
          <Slider label="Reach" value={k.reach} min={-2} max={4} step={0.5} unit="mm" tag="kcr" help="Moves the loop away from (+) or into (−) the body." set={(v) => edit((x) => { x.keychain.reach = v; }, 'kcr')} />
        </>
      )}
    </>
  );
}

function FitPanel() {
  const f = cx.spec.fit;
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="cx-title">Fit</div>
      <Note>Printers differ by a few hundredths of a millimetre. Print the fit test (a small plain clicker) first, then adjust these.</Note>
      <button className="cx-btn" disabled={busy} onClick={() => { setBusy(true); const r = transferFitTest(); setBusy(false); say(r ? `Fit test placed on ${r.plate}.` : 'Could not place the fit test.'); }}>Send a fit test to the plate</button>
      <Slider label="Switch hole" value={f.switchTol} min={-0.1} max={0.4} step={0.01} unit="mm" tag="stol" help="Added to the 14 mm hole. Tight? Raise it. Loose? Lower it." set={(v) => edit((x) => { x.fit.switchTol = v; }, 'stol')} />
      <Slider label="Housing pocket" value={f.pocketTol} min={0.1} max={0.8} step={0.05} unit="mm" tag="ptol" help="Clearance around the 15.6 mm top housing." set={(v) => edit((x) => { x.fit.pocketTol = v; }, 'ptol')} />
      <Slider label="Button clearance" value={f.capClear} min={0.1} max={0.6} step={0.05} unit="mm" tag="cclr" help="Gap between the button's skirt and the rim." set={(v) => edit((x) => { x.fit.capClear = v; }, 'cclr')} />
      <Slider label="Stem socket" value={f.bossTol} min={-0.1} max={0.4} step={0.01} unit="mm" tag="btol" help="Added to the 4 × 1.35 mm cross. Button loose on the stem? Lower it." set={(v) => edit((x) => { x.fit.bossTol = v; }, 'btol')} />
      <Slider label="Boss diameter" value={f.bossD} min={4.8} max={6} step={0.05} unit="mm" tag="bossd" help="Outer diameter of the part that slides into the switch housing." set={(v) => edit((x) => { x.fit.bossD = v; }, 'bossd')} />
    </>
  );
}

// ---------------------------------------------------------------- blocks
function LayoutPanel() {
  const s = cx.spec, b = s.blocks, keys = blockKeys(s);
  const sample = (id: BlockLayout) => {
    const cells = id === 'wasd' || id === 'arrows' ? [[0, 1, 0], [1, 1, 1]] : id === 'row' ? [[1, 1, 1, 1]] : id === 'column' ? [[1], [1], [1]] : id === 'grid' ? [[1, 1, 1], [1, 1, 1], [1, 1, 1]] : [[1, 1, 0], [0, 1, 1], [1, 0, 1]];
    return <span className="cx-layout">{cells.map((r, i) => <span key={i}>{r.map((v, j) => <i key={j} className={v ? 'k' : ''} />)}</span>)}</span>;
  };
  return (
    <>
      <div className="cx-title">Layout</div>
      <div className="cx-grid3">
        {LAYOUTS.map((l) => <button key={l.id} className={`cx-tile ${b.layout === l.id ? 'on' : ''}`} onClick={() => edit((x) => { x.blocks.layout = l.id; })}>{sample(l.id)}<span>{l.name}</span></button>)}
      </div>
      {(b.layout === 'grid' || b.layout === 'custom') && <Slider label="Columns" value={b.cols} min={1} max={6} tag="cols" set={(v) => edit((x) => { x.blocks.cols = v; x.blocks.cells = Array.from({ length: x.blocks.rows * v }, (_, i) => x.blocks.cells[i] ?? true); }, 'cols')} />}
      {b.layout === 'custom' && (
        <>
          <Slider label="Rows" value={b.rows} min={1} max={6} tag="rows" set={(v) => edit((x) => { x.blocks.rows = v; x.blocks.cells = Array.from({ length: v * x.blocks.cols }, (_, i) => x.blocks.cells[i] ?? true); }, 'rows')} />
          <Row label="Keys" help="Click a cell to add or remove a key.">
            <div className="cx-cells" style={{ gridTemplateColumns: `repeat(${b.cols}, 1fr)` }}>
              {Array.from({ length: b.rows * b.cols }, (_, i) => <button key={i} className={b.cells[i] ? 'on' : ''} onClick={() => edit((x) => { x.blocks.cells[i] = !x.blocks.cells[i]; })} aria-label={`Cell ${i + 1}`} />)}
            </div>
          </Row>
        </>
      )}
      <Toggle label="Borders" value={b.borders} help="On: every key sits in its own frame. Off: the keys almost touch." set={(v) => edit((x) => { x.blocks.borders = v; })} />
      {b.borders && <Slider label="Border width" value={b.borderW} min={0.8} max={4} step={0.1} unit="mm" tag="bw" set={(v) => edit((x) => { x.blocks.borderW = v; }, 'bw')} />}
      <Slider label="Key pitch" value={b.pitch} min={20} max={40} step={0.5} unit="mm" tag="pitch" help="Centre to centre. Raised automatically if the switch would not fit." set={(v) => edit((x) => { x.blocks.pitch = v; }, 'pitch')} />
      <Note>{keys.keys.length} key{keys.keys.length === 1 ? '' : 's'} · {keys.cols} × {keys.rows}</Note>
    </>
  );
}

function FontPanel() {
  const b = cx.spec.blocks;
  return (
    <>
      <div className="cx-title">Font</div>
      <Row label="Typeface"><select className="cx-select" value={b.font} onChange={(e) => edit((x) => { x.blocks.font = e.target.value; })}>{fontList().map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Row>
      <Slider label="Letter size" value={b.letterSize} min={5} max={22} step={0.5} unit="mm" tag="ls" set={(v) => edit((x) => { x.blocks.letterSize = v; }, 'ls')} />
    </>
  );
}

function LetteringPanel() {
  const s = cx.spec;
  return (
    <>
      <div className="cx-title">Lettering</div>
      <Row label="Style" help="Color: letters inlaid flush in their own colour. Raise: letters stand proud. Engrave: letters cut into the key.">
        <Seg<DesignMode> value={s.colors.mode} options={[['color', 'Color'], ['raise', 'Raise'], ['engrave', 'Engrave']]} set={(v) => edit((x) => { x.colors.mode = v; })} />
      </Row>
      <Row label="Lettering colour"><FilamentButton label="Lettering colour" hex={s.colors.ink} onPick={(_, f) => edit((x) => { x.colors.ink = f.color; })} /></Row>
      {s.colors.mode === 'raise'
        ? <Slider label="Raise height" value={s.colors.raise} min={0.2} max={3} step={0.1} unit="mm" tag="raise" set={(v) => edit((x) => { x.colors.raise = v; }, 'raise')} />
        : <Slider label="Depth" value={s.colors.inlay} min={0.2} max={Math.max(0.4, s.body.capTop)} step={0.1} unit="mm" tag="inlay" set={(v) => edit((x) => { x.colors.inlay = v; }, 'inlay')} />}
    </>
  );
}

// ---------------------------------------------------------------- 3D model
function CutPanel() {
  const s = cx.spec, m = s.model, info = modelInfo();
  const h = info ? info.size[2] : 40;
  const cards: { id: ModelCut; title: string; text: string }[] = [
    { id: 'split', title: 'Split in two', text: 'The top comes off as the button.' },
    { id: 'stand', title: 'On a stand', text: 'The whole model is the button.' },
    { id: 'top', title: 'Button on top', text: 'A button cut into its top.' },
  ];
  return (
    <>
      <div className="cx-title">How it clicks</div>
      <Cards value={m.cut} options={cards} set={(v) => edit((x) => { x.model.cut = v; })} />
      {m.cut === 'split' && (
        <>
          <Slider label="Where it splits" value={m.splitZ} min={8} max={Math.max(12, Math.floor(h - 8))} unit="mm" tag="splitz" help="Height of the cut above the bottom of the model. The switch lives under it." set={(v) => edit((x) => { x.model.splitZ = v; }, 'splitz')} />
          <Toggle label="Hide the gap" value={m.hideGap} help="Adds a tongue and groove so you cannot see into the gap." set={(v) => edit((x) => { x.model.hideGap = v; })} />
        </>
      )}
      {m.cut === 'stand' && <Slider label="Stand diameter" value={m.standD} min={28} max={70} unit="mm" tag="standd" set={(v) => edit((x) => { x.model.standD = v; }, 'standd')} />}
      {m.cut === 'top' && <Slider label="Button diameter" value={m.buttonD} min={22} max={60} unit="mm" tag="buttond" help="Round button cut out of the top of the model." set={(v) => edit((x) => { x.model.buttonD = v; }, 'buttond')} />}
      <details className="cx-more"><summary>More settings</summary>
        {m.cut === 'split' && <Slider label="Groove width" value={m.lip} min={0.8} max={2.4} step={0.1} unit="mm" tag="lip" set={(v) => edit((x) => { x.model.lip = v; }, 'lip')} />}
        <Slider label="Button travel" value={s.sw.travel} min={2} max={4} step={0.1} unit="mm" tag="travel" set={(v) => edit((x) => { x.sw.travel = v; }, 'travel')} />
      </details>
    </>
  );
}

function ModelPanel() {
  const s = cx.spec, info = modelInfo();
  return (
    <>
      <div className="cx-title">Model</div>
      {info ? <Note kind={info.open ? 'warn' : 'ok'}>{info.name} · {info.tris.toLocaleString()} triangles · {info.size.map((v) => v.toFixed(0)).join(' × ')} mm{info.open ? ` · ${info.open} open edges` : ''}</Note> : <Note>Pick a sample or drop a model on the right.</Note>}
      <Slider label="Scale" value={s.model.scale} min={20} max={300} unit="%" tag="mscale" set={(v) => edit((x) => { x.model.scale = v; }, 'mscale')} />
      <Row label="Turn the model" help="Stand the model the way you want it to sit, then pick where it splits.">
        <div className="cx-btns">
          <button className="cx-btn small" onClick={() => turnModel('x')}>90° X</button>
          <button className="cx-btn small" onClick={() => turnModel('y')}>90° Y</button>
          <button className="cx-btn small" onClick={() => turnModel('z')}>90° Z</button>
        </div>
      </Row>
    </>
  );
}

export function Panel() {
  useCx();
  const tabs = tabsFor(cx.spec.source);
  return <PanelById id={(tabs.find((t) => t.id === cx.tab) ?? tabs[0]).id} />;
}

/** The settings of one tab (the Studio shows every tab as its own card). */
export function PanelById({ id }: { id: string }) {
  switch (id) {
    case 'shape': return <ShapePanel />;
    case 'body': return <BodyPanel />;
    case 'colors': return <ColorsPanel />;
    case 'switch': return <SwitchPanel />;
    case 'keychain': return <KeychainPanel />;
    case 'fit': return <FitPanel />;
    case 'layout': return <LayoutPanel />;
    case 'font': return <FontPanel />;
    case 'lettering': return <LetteringPanel />;
    case 'cut': return <CutPanel />;
    case 'model': return <ModelPanel />;
    default: return null;
  }
}

