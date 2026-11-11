// Select & apply: a full-screen window over NexSpiro, opened from the Motionex tab. It shows the sliced print as
// its real lines (orbit, pan, zoom, cut away from the top) and lets the user pick layer ranges, single lines or
// brush an area, then choose what changes there: filament, a motion, speed, flow, temperature. Every rule lives
// here; the slicer applies them (select/engine.ts) and the window shows the same selection the slicer uses.
import { createPortal } from 'react-dom';
import { touchAdd, touchErase, TouchMods } from '../../../ui/TouchMods';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as RPointerEvent } from 'react';
import * as THREE from 'three';
import { useStore } from '../../../state/store';
import { currentConfig, plateMeshes, plateObjects, sliceNow } from '../../../state/slicing';
import { changerOf } from '../../../profiles/changer';
import { MOVE_STRIDE } from '../../../engine/gcode';
import type { SliceOutput } from '../../../engine/types';
import { changed, mx, useMx } from './MotionexPanel';
import { ALL_TARGETS, describePick, draftMode, featuresOf, groupsOfTargets, newRule, pickEmpty, ruleActive, targetOk, type PickKind, type RuleTargets, type SelectRule } from '../select/model';
import { makeDraft, type Draft } from '../select/draft';
import { MotionTabs } from './MotionTabs';
import { wallsFromModel, wallSettings } from '../select/modelWalls';
import { piecesAt, weightAt, type Piece } from '../select/geometry';
import { objectAnchors } from '../select/engine';
import { FEATURE_RGB, featureName, hexRgb, runOf, segmentsOf, SelectView } from './selectView';
import { classifyLines, CLASS_IDS, SHOW_ALL, visibleMask, type LineClasses, type LineFilter } from '../select/classes';
import { ViewCube, type CubeApi } from '../../../ui/PrepareOverlays';

let isOpen = false;
const listeners = new Set<() => void>();
export function openSelectWindow(open = true) { isOpen = open; listeners.forEach((l) => l()); }
const useOpen = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => isOpen);

export function SelectWindowHost() {
  const open = useOpen();
  const installed = useStore((s) => s.plugins.includes('motionex'));
  if (!open || !installed || typeof document === 'undefined') return null;
  return createPortal(<SelectWindow />, document.body);
}

type Tool = 'orbit' | 'layers' | 'lines' | 'brush';
const TOOLS: [Tool, string, string][] = [
  ['orbit', 'Look', 'Left drag turns the view, right drag moves it, the wheel zooms'],
  ['layers', 'Layers', 'Click a line to choose its layer; Shift+click another to choose every layer between. Or drag on the height ruler'],
  ['lines', 'Lines', 'Click a printed line to add the whole line; Alt+click adds just that segment. Click it again to take it out'],
  ['brush', 'Brush', 'Drag over the print to paint an area; hold Alt to erase'],
];
const KIND_OF: Record<Exclude<Tool, 'orbit'>, PickKind> = { layers: 'layers', lines: 'lines', brush: 'brush' };
const ACTIVE = hexRgb('#ff3d7f'), OTHER = hexRgb('#4f8cff');
// kept while the app runs, so the window opens again with the same lines shown and the same projection
let lastFilter: LineFilter = { ...SHOW_ALL };
let lastOrtho = false;
let lastSource: 'model' | 'slice' = 'model';
let lastFill = true;
const cubeListeners = new Set<(m: ArrayLike<number>) => void>();

interface ObjBox { id: string; name: string; min: [number, number, number]; max: [number, number, number] }

function objectInfo(): { boxes: ObjBox[]; now: Record<string, [number, number]> } {
  try {
    const meshes = plateMeshes(plateObjects().filter((o) => o.printable !== false));
    const boxes = meshes.map((m) => {
      const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < m.vertices.length; k += 3) for (let a = 0; a < 3; a++) { const v = m.vertices[k + a]; if (v < min[a]) min[a] = v; if (v > max[a]) max[a] = v; }
      return { id: m.id, name: m.name, min, max };
    });
    return { boxes, now: objectAnchors(meshes) };
  } catch { return { boxes: [], now: {} }; }
}

const objAt = (boxes: ObjBox[], x: number, y: number, z: number) =>
  boxes.find((b) => x >= b.min[0] - 0.6 && x <= b.max[0] + 0.6 && y >= b.min[1] - 0.6 && y <= b.max[1] + 0.6 && z >= b.min[2] - 0.6 && z <= b.max[2] + 0.6)?.id;

/** Makes the rule's selection of this kind, asking before a selection of another kind is thrown away. */
function ensureKind(r: SelectRule, kind: PickKind): boolean {
  if (r.pick.kind === kind) return true;
  // no confirm(): pages in a sandboxed frame (the web app) can't show one, and it then always says no.
  // The old selection is kept for Undo instead.
  if (!pickEmpty(r.pick)) { const old = structuredClone(r.pick); offerUndo(`"${r.name}": ${r.pick.kind} selection replaced`, () => { r.pick = old; }); }
  r.pick = kind === 'layers' ? { kind, z0: 0, z1: 0 } : kind === 'lines' ? { kind, lines: [] } : { kind, dabs: [] };
  return true;
}

/** The last thing that can be undone (a deleted rule, a replaced selection), shown as a bar with an Undo button. */
let undoSlot: { text: string; restore: () => void } | null = null;
const undoListeners = new Set<() => void>();
function offerUndo(text: string, restore: () => void) { undoSlot = { text, restore }; undoListeners.forEach((l) => l()); }
const useUndo = () => useSyncExternalStore((l) => { undoListeners.add(l); return () => undoListeners.delete(l); }, () => undoSlot);

function SelectWindow() {
  const undo = useUndo();
  // the Undo bar goes away after a while
  useEffect(() => { if (!undo) return; const t = setTimeout(() => { if (undoSlot === undo) { undoSlot = null; undoListeners.forEach((l) => l()); } }, 10000); return () => clearTimeout(t); }, [undo]);
  useMx();
  const sliced = useStore((s) => s.slice.result);
  const objects = useStore((s) => s.objects);
  const overrides = useStore((s) => s.overrides);
  const presetId = useStore((s) => s.presetId);
  const [fill, setFillState] = useState(lastFill);
  const setFill = (v: boolean) => { lastFill = v; setFillState(v); };
  const [source, setSourceState] = useState<'model' | 'slice'>(lastSource);
  const setSource = (v: 'model' | 'slice') => { lastSource = v; setSourceState(v); if (v === 'slice' && !useStore.getState().slice.result) void sliceNow(); };
  // walls straight from the 3D model: layer height and wall count changes show at once, without slicing
  const fromModel = useMemo(() => {
    if (source !== 'model') return null;
    try { return wallsFromModel(plateMeshes(plateObjects().filter((o) => o.printable !== false)), { ...wallSettings(currentConfig()), fill }); } catch (e) { console.warn('model walls failed', e); return null; }
  }, [source, objects, overrides, presetId, fill]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = source === 'model' ? fromModel : sliced;
  const ws = wallSettings(currentConfig());
  const status = useStore((s) => s.slice.status);
  const progress = useStore((s) => s.slice.progress);
  const dirty = useStore((s) => s.slice.dirty);
  const filaments = useStore((s) => s.filaments);
  const theme = useStore((s) => s.theme);
  const host = useRef<HTMLDivElement>(null);
  const had = useRef(false);
  const view = useRef<SelectView | null>(null);
  const [tool, setTool] = useState<Tool>('lines');
  const [brushR, setBrushR] = useState(1.5);
  const [colorBy, setColorBy] = useState<'feature' | 'filament'>('feature');
  const [activeId, setActiveId] = useState<string | null>(mx.rules[0]?.id ?? null);
  const [cutLayer, setCutLayer] = useState<number>(Infinity);
  const [oneObject, setOneObject] = useState(false);
  const [info, setInfo] = useState(objectInfo);
  const [filter, setFilterState] = useState<LineFilter>(lastFilter);
  const setFilter = (f: LineFilter) => { lastFilter = f; setFilterState(f); };
  const [ortho, setOrthoState] = useState(lastOrtho);
  const rule = mx.rules.find((r) => r.id === activeId) ?? null;

  // slice when the window opens with nothing (or something out of date) to show
  useEffect(() => {
    // motions are drawn here as a draft while the window is open: the slice under them is made without them
    draftMode.on = true;
    const hasMotion = () => mx.rules.some((r) => ruleActive(r) && r.apply.motion);
    if (hasMotion()) useStore.getState().markDirty();
    const s = useStore.getState().slice;
    if (lastSource === 'slice' && s.status !== 'slicing' && (!s.result || s.dirty)) void sliceNow();
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) openSelectWindow(false); };
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('keydown', close);
      // closing: the exact path, with the motions, from a real slice
      draftMode.on = false;
      if (hasMotion()) { useStore.getState().markDirty(); void sliceNow(); }
    };
  }, []);

  useEffect(() => {
    const v = new SelectView(host.current!);
    view.current = v;
    had.current = false; // a new view (React may make it twice) frames the print again
    v.onProjection = (o) => { lastOrtho = o; setOrthoState(o); };
    v.cameraListeners.add((m) => { for (const l of cubeListeners) l(m); });
    return () => { v.dispose(); view.current = null; };
  }, []);
  useEffect(() => { view.current?.setBackground(getComputedStyle(document.body).getPropertyValue('--surface-primary').trim() || (theme === 'light' ? '#f4f4f6' : '#16181d')); }, [theme]);
  useEffect(() => { view.current?.setPickMode(tool !== 'orbit'); if (tool !== 'brush') view.current?.showBrush(null); }, [tool]);

  const segs = useMemo(() => (result ? segmentsOf(result) : null), [result]);
  useEffect(() => {
    if (!segs || !view.current) return;
    view.current.setData(segs, had.current);
    if (!had.current && lastOrtho) view.current.setOrtho(true);
    had.current = true;
    setInfo(objectInfo());
  }, [segs]);

  // which lines are drawn: hidden lines can't be clicked, brushed or chosen by layer either
  const classes = useMemo<LineClasses | null>(() => (segs && result ? classifyLines(segs, result.layers.length, (k) => result.moves[segs.move[k] * MOVE_STRIDE + 3]) : null), [segs, result]);
  useEffect(() => { if (classes) view.current?.setShown(visibleMask(classes, filter)); }, [classes, filter, segs]);
  const cubeApi = useMemo<CubeApi>(() => ({
    // the cube mounts before the 3D view exists, so it listens through a set the view forwards to
    listen: (l) => { cubeListeners.add(l); return () => { cubeListeners.delete(l); }; },
    // a face of the cube gives a straight-on orthographic view of that side; the toggle beside it switches back
    setView: (f) => { const v = view.current; if (!v) return; v.setOrtho(true); v.look(f, true); },
    orbit: (a, b) => view.current?.orbit(a, b),
    fit: () => view.current?.frame(),
  }), []);

  const layers = result?.layers ?? [];
  const top = Math.max(0, layers.length - 1);
  const cut = Math.min(cutLayer, top);
  const cutZ = layers[cut]?.z ?? 1e4;
  useEffect(() => { view.current?.setCut(cutZ); }, [cutZ, segs]);

  // colours: line kind or filament, the active rule in pink and the others in blue, both fading with the blend
  const rulesKey = JSON.stringify(mx.rules);
  useEffect(() => {
    const v = view.current;
    if (!v || !segs || !result) return;
    const fil = filaments.map((f) => hexRgb(f.color));
    const live = mx.rules.filter((r) => r.enabled && !pickEmpty(r.pick));
    const feats = live.map((r) => featuresOf(r.lines));
    const cache = new Map<number, Piece[][]>();
    const pieces = (li: number) => {
      let p = cache.get(li);
      if (!p) { const L = layers[li]; p = live.map((r) => piecesAt(r, L.z, L.height, info.now)); cache.set(li, p); }
      return p;
    };
    const boxOf = new Map(info.boxes.map((b) => [b.id, b]));
    const P = segs.pos;
    v.paint((s, out, at) => {
      const base = colorBy === 'filament' ? fil[segs.tool[s]] ?? fil[0] ?? [0.8, 0.8, 0.8] : FEATURE_RGB[segs.feature[s]] ?? [0.7, 0.7, 0.7];
      let r = base[0] * 0.55, g = base[1] * 0.55, b = base[2] * 0.55;
      if (live.length) {
        const ps = pieces(segs.layer[s]);
        const x = (P[s * 6] + P[s * 6 + 3]) / 2, y = (P[s * 6 + 1] + P[s * 6 + 4]) / 2;
        const f = featureName(segs.feature[s]);
        live.forEach((rl, k) => {
          if (!ps[k].length || !feats[k].has(f)) return;
          if (rl.targets && classes && !targetOk(rl.targets, CLASS_IDS[classes.cls[s]], classes.rank[s], classes.curved[s] === 1)) return;
          const w = weightAt(ps[k], rl.blend_mm, x, y, f, (id) => { const bx = boxOf.get(id); return !bx || (x >= bx.min[0] - 0.6 && x <= bx.max[0] + 0.6 && y >= bx.min[1] - 0.6 && y <= bx.max[1] + 0.6); });
          if (w <= 0) return;
          const c = rl.id === activeId ? ACTIVE : OTHER, m = rl.id === activeId ? w : w * 0.7;
          r += (c[0] - r) * m; g += (c[1] - g) * m; b += (c[2] - b) * m;
        });
      }
      out[at] = r; out[at + 1] = g; out[at + 2] = b;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segs, rulesKey, activeId, colorBy, filaments, info, classes]);

  // the motions, drawn at once from the geometry on screen (the slice is made without them while the window is open)
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (!result) { setDraft(null); return; }
    const raf = requestAnimationFrame(() => {
      try {
        setDraft(makeDraft({ result, rules: mx.rules, now: info.now, boxes: info.boxes, brushOf: (id) => mx.library.get(id), cfg: currentConfig(), printerId: useStore.getState().printerId, options: mx.options }));
      } catch (e) { console.warn('Select draft failed', e); setDraft(null); }
    });
    return () => cancelAnimationFrame(raf);
  }, [result, rulesKey, info]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const v = view.current;
    if (!v || !segs) return;
    v.setDraft(draft?.pos ?? null, ACTIVE);
    if (draft?.replaced.size) { const m = new Uint8Array(segs.count); for (let k = 0; k < segs.count; k++) if (draft.replaced.has(segs.move[k])) m[k] = 1; v.setCovered(m); }
    else v.setCovered(null);
    const sliced = result?.pauses, mine = draft?.pauses;
    v.setPauses(mine?.length ? (sliced?.length ? concat(sliced, mine) : mine) : sliced, ACTIVE);
  }, [draft, segs, result]);

  const addRule = () => {
    const r = newRule(mx.rules.length + 1);
    if (tool !== 'orbit') r.pick = KIND_OF[tool] === 'layers' ? { kind: 'layers', z0: 0, z1: 0 } : KIND_OF[tool] === 'lines' ? { kind: 'lines', lines: [] } : { kind: 'brush', dabs: [] };
    mx.rules.push(r);
    setActiveId(r.id);
    changed();
    return r;
  };
  const target = () => rule ?? addRule();

  // ---- picking on the 3D view
  const painting = useRef<{ erase: boolean; last: THREE.Vector3 | null } | null>(null);
  const hoverRaf = useRef(0);
  const anchor = (r: SelectRule, obj: string | undefined) => { if (obj && info.now[obj] && !r.anchors[obj]) r.anchors[obj] = [...info.now[obj]]; };

  const dab = (r: SelectRule, p: THREE.Vector3, erase: boolean) => {
    if (r.pick.kind !== 'brush') return;
    if (erase) { r.pick.dabs = r.pick.dabs.filter((d) => Math.hypot(d.x - p.x, d.y - p.y, d.z - p.z) > brushR); return; }
    const obj = objAt(info.boxes, p.x, p.y, p.z);
    anchor(r, obj);
    r.pick.dabs.push({ obj, x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3), r: brushR });
  };

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || tool === 'orbit' || !result || !segs || !view.current) return;
    const hit = view.current.pick(e.clientX, e.clientY, cutZ);
    if (tool === 'brush') {
      const r = target();
      if (!ensureKind(r, 'brush')) return;
      painting.current = { erase: e.altKey || touchErase(), last: hit?.point ?? null };
      if (hit) dab(r, hit.point, e.altKey || touchErase());
      (e.target as Element).setPointerCapture?.(e.pointerId);
      changed();
      return;
    }
    if (!hit) return;
    const r = target();
    const move = segs.move[hit.seg], li = segs.layer[hit.seg], L = layers[li];
    if (tool === 'layers') {
      if (!ensureKind(r, 'layers') || r.pick.kind !== 'layers') return;
      const obj = oneObject ? objAt(info.boxes, hit.point.x, hit.point.y, hit.point.z) : undefined;
      if ((e.shiftKey || touchAdd()) && !pickEmpty(r.pick)) { r.pick.z0 = Math.min(r.pick.z0, L.z); r.pick.z1 = Math.max(r.pick.z1, L.z); }
      else { r.pick.z0 = L.z; r.pick.z1 = L.z; }
      r.pick.obj = obj;
      anchor(r, obj);
      changed();
      return;
    }
    if (!ensureKind(r, 'lines') || r.pick.kind !== 'lines') return;
    const one = e.altKey;
    const { from, to } = one ? { from: move, to: move } : runOf(result, move);
    const pts: [number, number][] = [];
    for (let k = Math.max(0, from - 1); k <= to; k++) pts.push([+result.moves[k * MOVE_STRIDE].toFixed(3), +result.moves[k * MOVE_STRIDE + 1].toFixed(3)]);
    const feature = featureName(result.moveFeatures[move]);
    const w = result.moves[move * MOVE_STRIDE + 3] || 0.42;
    const p = hit.point;
    // the same line (or for a segment, the same segment) again takes it out
    const near = (l: { pts: [number, number][] }) => one ? l.pts.length === 2 && Math.hypot((l.pts[0][0] + l.pts[1][0]) / 2 - (pts[0][0] + pts[1][0]) / 2, (l.pts[0][1] + l.pts[1][1]) / 2 - (pts[0][1] + pts[1][1]) / 2) < 0.05
      : l.pts.length > 2 && l.pts.some(([x, y]) => Math.hypot(x - p.x, y - p.y) < Math.max(w, 0.5));
    const same = r.pick.lines.findIndex((l) => Math.abs(l.z - L.z) < 1e-3 && l.feature === feature && near(l));
    if (same >= 0) r.pick.lines.splice(same, 1);
    else {
      const obj = objAt(info.boxes, p.x, p.y, p.z);
      anchor(r, obj);
      // long lines are thinned to every 0.2 mm or so: picks stay small in the project file
      const thin = one ? pts : pts.filter((q, k) => k === 0 || k === pts.length - 1 || Math.hypot(q[0] - pts[k - 1][0], q[1] - pts[k - 1][1]) > 0.05);
      r.pick.lines.push({ obj, z: +L.z.toFixed(4), h: +L.height.toFixed(4), feature, w: +w.toFixed(3), pts: thin });
    }
    changed();
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (tool !== 'brush' || !view.current) return;
    const x = e.clientX, y = e.clientY, down = painting.current, alt = e.altKey || touchErase();
    cancelAnimationFrame(hoverRaf.current);
    hoverRaf.current = requestAnimationFrame(() => {
      const v = view.current;
      if (!v) return;
      const hit = v.pick(x, y, cutZ);
      v.showBrush(hit?.point ?? null, brushR);
      if (!down || !hit || !rule || rule.pick.kind !== 'brush') return;
      if (down.last && hit.point.distanceTo(down.last) < brushR * 0.5) return;
      down.last = hit.point.clone();
      dab(rule, hit.point, alt || down.erase);
      changed();
    });
  };
  const onUp = () => { painting.current = null; };

  // ---- height ruler: drag to choose a layer range for the active rule
  const ruler = useRef<HTMLDivElement>(null);
  const zMax = layers[top]?.z ?? 1;
  const zFromY = (clientY: number) => {
    const b = ruler.current!.getBoundingClientRect();
    const z = (1 - (clientY - b.top) / b.height) * zMax;
    // snap to the nearest layer top
    let best = layers[0]?.z ?? 0;
    for (const L of layers) if (Math.abs(L.z - z) < Math.abs(best - z)) best = L.z;
    return best;
  };
  const rulerDrag = useRef<number | null>(null);
  const onRulerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!layers.length) return;
    const r = target();
    if (!ensureKind(r, 'layers') || r.pick.kind !== 'layers') return;
    const z = zFromY(e.clientY);
    rulerDrag.current = z;
    r.pick.z0 = z; r.pick.z1 = z;
    setTool('layers');
    (e.target as Element).setPointerCapture?.(e.pointerId);
    changed();
  };
  const onRulerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (rulerDrag.current === null || !rule || rule.pick.kind !== 'layers') return;
    const z = zFromY(e.clientY), a = rulerDrag.current;
    rule.pick.z0 = Math.min(a, z); rule.pick.z1 = Math.max(a, z);
    changed();
  };
  const band = rule?.pick.kind === 'layers' && !pickEmpty(rule.pick) ? rule.pick : null;

  const cost = useMemo(() => estimateCost(mx.rules, result, info.now, filaments.length), [rulesKey, result, info, filaments.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mxw-back" role="dialog" aria-label="Select and apply">
      <div className="mxw sxw">
        <header className="mxw-head">
          <b>Select &amp; apply</b>
          <span className="sxw-hint">{TOOLS.find((t) => t[0] === tool)?.[2]}</span>
          <span style={{ flex: 1 }} />
          {status === 'slicing' ? <span className="sxw-status">Slicing… {Math.round(progress * 100)}%</span>
            : <>
              {draft && <span className="sxw-status" title="Motions are drawn straight from the geometry as you change them. The exact path and G-code are made by a real slice when you press Done.">Live draft · {draft.layers} layers · {Math.round(draft.ms)} ms</span>}
              <button className="btn-secondary btn-small" onClick={() => void sliceNow()} title="Slice again for speed, flow, filament and temperature changes and the real time and filament (motions stay a live draft until Done)">{dirty ? 'Update slice' : 'Re-slice'}</button>
            </>}
          <button className="btn-primary btn-small" onClick={() => openSelectWindow(false)} title="Close and make the exact path with every rule">Done</button>
        </header>
        <div className="sxw-body">
          <aside className="sxw-side">
            <div className="sxw-sec">
              <div className="sxw-title">Rules<span style={{ flex: 1 }} /><button className="btn-secondary btn-small" onClick={addRule}>New rule</button></div>
              {!mx.rules.length && <p className="sxw-muted">Make a rule, choose Layers, Lines or Brush above the view, and pick on the print. Then choose what changes there.</p>}
              {undo?.text && <div className="sxw-undo" role="status"><span>{undo.text}</span><button className="btn-secondary btn-small" onClick={() => { undo.restore(); undoSlot = null; undoListeners.forEach((l) => l()); changed(); }}>Undo</button></div>}
              <div className="sxw-rules">
                {mx.rules.map((r, i) => (
                  <div key={r.id} className={`sxw-rule${r.id === activeId ? ' on' : ''}${ruleActive(r) ? '' : ' idle'}`} onClick={() => setActiveId(r.id)}>
                    <input type="checkbox" checked={r.enabled} aria-label="Rule on" onClick={(e) => e.stopPropagation()} onChange={(e) => { r.enabled = e.target.checked; changed(); }} />
                    <div className="sxw-rule-text"><b>{r.name}</b><span>{describePick(r.pick)} · {summary(r, filaments.length)}</span></div>
                    {r.id === activeId && <button className="sxw-x sxw-rule-x" aria-label="Deselect rule" title="Deselect this rule (it stays in the list)" onClick={(e) => { e.stopPropagation(); setActiveId(null); }}>×</button>}
                    <div className="sxw-rule-btns">
                      <button disabled={i === 0} onClick={(e) => { e.stopPropagation(); mx.rules.splice(i - 1, 0, ...mx.rules.splice(i, 1)); changed(); }} title="Earlier: rules lower in the list win where they set the same thing">Up</button>
                      <button disabled={i === mx.rules.length - 1} onClick={(e) => { e.stopPropagation(); mx.rules.splice(i + 1, 0, ...mx.rules.splice(i, 1)); changed(); }}>Down</button>
                      <button onClick={(e) => {
                        e.stopPropagation();
                        const k = mx.rules.indexOf(r);
                        if (k < 0) return;
                        mx.rules.splice(k, 1);
                        if (r.id === activeId) setActiveId(mx.rules[0]?.id ?? null);
                        offerUndo(`Deleted "${r.name}"`, () => { mx.rules.splice(Math.min(k, mx.rules.length), 0, r); setActiveId(r.id); });
                        changed();
                      }} title="Delete this rule (Undo brings it back)">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <ShowLines f={filter} set={setFilter} lc={classes} />
            {rule && <RuleEditor r={rule} oneObject={oneObject} setOneObject={setOneObject} lc={classes} limited={draft?.limited.find((l) => l.id === rule.id)} />}
          </aside>
          <main className="sxw-main">
            <div className="sxw-tools">
              {TOOLS.map(([t, label, tip]) => <button key={t} className={`sxw-tool${tool === t ? ' on' : ''}`} onClick={() => setTool(t)} title={tip}>{label}</button>)}
              {tool === 'brush' && <label className="sxw-inline">Brush size<input type="range" min={0.3} max={10} step={0.1} value={brushR} onChange={(e) => setBrushR(+e.target.value)} /><span>{brushR.toFixed(1)} mm</span></label>}
              {tool === 'layers' && <label className="sxw-inline"><input type="checkbox" checked={oneObject} onChange={(e) => setOneObject(e.target.checked)} />Only the clicked object</label>}
              <span style={{ flex: 1 }} />
              <div className="sxw-proj sxw-source" role="group" aria-label="Show">
                <button className={source === 'model' ? 'on' : ''} onClick={() => setSource('model')} title="Walls built straight from the 3D model: layer height and wall changes show at once. Infill and skins come with the real slice">From model</button>
                <button className={source === 'slice' ? 'on' : ''} onClick={() => setSource('slice')} title="The last real slice: every line, infill and skins included">Last slice</button>
              </div>
              {source === 'model' && <>
                <label className="sxw-inline" title="Layer height (a real setting: the slice uses it too)">Layer<input className="input sxw-num" type="number" min={0.04} max={1} step={0.02} value={ws.layerH} onChange={(e) => { const v = +e.target.value; if (v >= 0.04 && v <= 1) useStore.getState().setOverride('layer_height', v); }} />mm</label>
                <label className="sxw-inline" title="First layer height (a real setting)">First<input className="input sxw-num" type="number" min={0.04} max={1} step={0.02} value={ws.firstH} onChange={(e) => { const v = +e.target.value; if (v >= 0.04 && v <= 1) useStore.getState().setOverride('initial_layer_print_height', v); }} />mm</label>
                <label className="sxw-inline" title="Number of walls (a real setting)">Walls<input className="input sxw-num" type="number" min={1} max={12} step={1} value={ws.walls} onChange={(e) => { const v = Math.round(+e.target.value); if (v >= 1 && v <= 12) useStore.getState().setOverride('wall_loops', v); }} /></label>
                <label className="sxw-inline" title="Also build the inside from the model: top and bottom skins (from the shell layer counts) and sparse infill (at the infill density), as straight lines"><input type="checkbox" checked={fill} onChange={(e) => setFill(e.target.checked)} />Infill &amp; skins</label>
              </>}
              <label className="sxw-inline">Colour by
                <select className="select" value={colorBy} onChange={(e) => setColorBy(e.target.value as 'feature' | 'filament')}><option value="feature">Line kind</option><option value="filament">Filament</option></select>
              </label>
            </div>
            <div className="sxw-stage">
              <TouchMods erase />
              <div ref={host} className={`sxw-canvas tool-${tool}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => view.current?.showBrush(null)} onContextMenu={(e) => e.preventDefault()} />
              <ViewCube api={cubeApi} className="sxw-cube">
                <div className="sxw-proj" role="group" aria-label="Projection">
                  <button className={ortho ? 'on' : ''} onClick={() => view.current?.setOrtho(true)} title="Orthographic: true sizes, parallel lines stay parallel">Ortho</button>
                  <button className={!ortho ? 'on' : ''} onClick={() => view.current?.setOrtho(false)} title="Perspective: far lines look smaller, like a photo">Persp</button>
                </div>
              </ViewCube>
              {!result && <div className="sxw-empty">{source === 'model' ? 'Add a model to the plate to see its walls.' : status === 'slicing' ? 'Slicing the plate to show its lines…' : 'Nothing sliced yet. Add a model to the plate, then Re-slice.'}</div>}
              <div className="sxw-rails">
                <div className="sxw-rail">
                  <span>Cut</span>
                  <input type="range" className="sxw-vrange" min={0} max={top} value={cut} onChange={(e) => setCutLayer(+e.target.value >= top ? Infinity : +e.target.value)} aria-label="Hide layers above" />
                  <span>{layers[cut] ? `${cut + 1}` : ''}</span>
                </div>
                <div className="sxw-rail">
                  <span>Layers</span>
                  <div ref={ruler} className="sxw-ruler" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={() => { rulerDrag.current = null; }} title="Drag to choose a range of layers for the selected rule">
                    {band && <div className="sxw-band" style={{ bottom: `${(Math.min(band.z0, band.z1) / zMax) * 100}%`, height: `${Math.max(0.6, ((Math.abs(band.z1 - band.z0)) / zMax) * 100)}%` }} />}
                    <div className="sxw-cutmark" style={{ bottom: `${(cutZ / zMax) * 100}%` }} />
                  </div>
                  <span>{zMax.toFixed(1)}</span>
                </div>
              </div>
            </div>
            <footer className="sxw-cost">
              <span><b>Estimate</b> for the rules{cost.layers ? ` (${cost.layers} layers touched)` : ''}:</span>
              <span>{cost.swaps ? `+${cost.swaps} filament ${cost.kind === 'toolchanger' ? 'head swaps' : 'changes'}` : 'no extra filament changes'}</span>
              {cost.swaps > 0 && <span>+{fmtTime(cost.seconds)}</span>}
              {cost.swaps > 0 && <span>{cost.purgeG > 0 ? `+${cost.purgeG.toFixed(1)} g purged` : 'no purge (tool changer)'}</span>}
              {cost.missing > 0 && <span className="sxw-warn">{cost.missing} rule{cost.missing > 1 ? 's use' : ' uses'} a filament that is not loaded: add it in the filament list</span>}
              {cost.kind === 'manual' && cost.swaps > 0 && <span className="sxw-warn">this printer changes filament by hand: {cost.swaps} pauses</span>}
              <span style={{ flex: 1 }} />
              {sliced && <span className="sxw-actual" title={dirty ? 'From the last slice, which is out of date' : 'From the last slice'}>{dirty ? 'Last slice' : 'Sliced'}: {fmtTime(sliced.stats.timeSeconds)} · {sliced.stats.toolChanges} changes · {(sliced.stats.flushGrams ?? 0).toFixed(1)} g purge · {sliced.stats.towerGrams.toFixed(1)} g tower</span>}
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}

const concat = (a: Float32Array, b: Float32Array) => { const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

const fmtTime = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

function summary(r: SelectRule, nFil: number): string {
  const a = r.apply, out: string[] = [];
  if (a.filament !== undefined) out.push(`filament ${a.filament + 1}${a.filament >= nFil ? ' (not loaded)' : ''}`);
  if (a.motion) out.push(mx.library.get(a.motion.brush_id)?.name ?? 'motion');
  if (a.speed !== undefined && a.speed !== 100) out.push(`speed ${a.speed}%`);
  if (a.flow !== undefined && a.flow !== 100) out.push(`flow ${a.flow}%`);
  if (a.temp !== undefined) out.push(`${a.temp} °C`);
  return out.length ? out.join(', ') : 'nothing to change yet';
}

/** Extra filament changes the rules cause on the last slice: whole layers change twice at the range ends, part layers twice per layer. */
function estimateCost(rules: SelectRule[], r: SliceOutput | null, now: Record<string, [number, number]>, loaded: number) {
  const cfg = currentConfig() as Record<string, unknown>;
  const kind = changerOf(cfg as never);
  const out = { swaps: 0, seconds: 0, purgeG: 0, layers: 0, kind, missing: 0 };
  if (!r) return out;
  out.missing = rules.filter((x) => ruleActive(x) && (x.apply.filament ?? -1) >= loaded).length;
  const fil = rules.filter((x) => ruleActive(x) && x.apply.filament !== undefined && x.apply.filament < loaded);
  if (!fil.length) return out;
  let prevWhole = new Set<string>();
  for (const L of r.layers) {
    const whole = new Set<string>();
    let touched = false;
    for (const x of fil) {
      const ps = piecesAt(x, L.z, L.height, now, true).filter((p) => p.zf >= 1);
      if (!ps.length) continue;
      touched = true;
      if (ps.some((p) => !p.polys) && !x.lines.length) { whole.add(x.id); if (!prevWhole.has(x.id)) out.swaps += 2; }
      else out.swaps += 2;
    }
    if (touched) out.layers++;
    prevWhole = whole;
  }
  const n = (k: string, d: number) => { const v = Number(cfg[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  out.seconds = out.swaps * n('filament_change_time', kind === 'toolchanger' ? 8 : 60);
  const vol = kind === 'toolchanger' ? n('tool_prime_volume', 0) : n('flush_volume', 140);
  out.purgeG = kind === 'toolchanger' && !cfg.tool_prime_volume ? 0 : (out.swaps * vol * n('filament_density', 1.24)) / 1000;
  return out;
}

function Num({ label, value, unit, min, max, step = 1, onChange, title }: { label: string; value: number | undefined; unit: string; min: number; max: number; step?: number; onChange(v: number | undefined): void; title?: string }) {
  const on = value !== undefined;
  return (
    <div className="sxw-row" title={title}>
      <label className="sxw-check"><input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? (unit === '%' ? 100 : unit === '°C' ? 220 : min) : undefined)} />{label}</label>
      <input className="input" type="number" disabled={!on} min={min} max={max} step={step} value={on ? value : ''} onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v))); }} />
      <span className="sxw-unit">{unit}</span>
    </div>
  );
}

function RuleEditor({ r, oneObject, setOneObject, lc, limited }: { r: SelectRule; oneObject: boolean; setOneObject(v: boolean): void; lc: LineClasses | null; limited?: { mm: number } }) {
  const filaments = useStore((s) => s.filaments);
  const set = (f: () => void) => { f(); changed(); };
  const brushes = mx.library.all();
  const groups = [...new Set(brushes.map((b) => b.category ?? 'Motions'))];
  const p = r.pick;
  return (
    <div className="sxw-sec sxw-edit">
      <div className="sxw-title">Selected rule</div>
      <div className="sxw-row"><span className="sxw-lbl">Name</span><input className="input" value={r.name} onChange={(e) => set(() => { r.name = e.target.value; })} /></div>
      <div className="sxw-row"><span className="sxw-lbl">Selection</span><span className="sxw-val">{describePick(p)}</span>
        <button className="btn-secondary btn-small" disabled={pickEmpty(p)} onClick={() => set(() => { r.pick = p.kind === 'layers' ? { kind: 'layers', z0: 0, z1: 0 } : p.kind === 'lines' ? { kind: 'lines', lines: [] } : { kind: 'brush', dabs: [] }; r.anchors = {}; })}>Clear</button>
      </div>
      {p.kind === 'lines' && p.lines.length > 0 && (
        <div className="sxw-picks">
          {p.lines.map((l, k) => (
            <div key={k} className="sxw-pick">
              <span>{l.pts.length === 2 ? 'Segment' : 'Line'} · {featureLabel(l.feature)} · {l.z.toFixed(2)} mm</span>
              <button className="sxw-x" aria-label="Take this line out" title="Take this line out of the selection" onClick={() => set(() => { p.lines.splice(k, 1); })}>×</button>
            </div>
          ))}
        </div>
      )}
      {p.kind !== 'layers' && <SpreadEditor r={r} />}
      {p.kind === 'layers' && <>
        <div className="sxw-row"><span className="sxw-lbl">From</span><input className="input" type="number" step={0.01} value={p.z0} onChange={(e) => set(() => { p.z0 = +e.target.value || 0; })} /><span className="sxw-unit">mm</span></div>
        <div className="sxw-row"><span className="sxw-lbl">To</span><input className="input" type="number" step={0.01} value={p.z1} onChange={(e) => set(() => { p.z1 = +e.target.value || 0; })} /><span className="sxw-unit">mm</span></div>
        <div className="sxw-row"><label className="sxw-check"><input type="checkbox" checked={!!p.obj} disabled={!p.obj && !oneObject} onChange={(e) => set(() => { if (!e.target.checked) { p.obj = undefined; setOneObject(false); } })} />{p.obj ? 'Only on one object' : 'On every object'}</label></div>
      </>}
      <Targets r={r} lc={lc} />
      <div className="sxw-sub">Change there</div>
      <div className="sxw-row"><span className="sxw-lbl">Filament</span>
        <select className="select" value={r.apply.filament ?? ''} onChange={(e) => set(() => { r.apply.filament = e.target.value === '' ? undefined : +e.target.value; })}>
          <option value="">Keep as sliced</option>
          {filaments.map((f, k) => <option key={k} value={k}>Filament {k + 1} ({f.color})</option>)}
          {filaments.length < 4 && Array.from({ length: 4 - filaments.length }, (_, j) => <option key={`x${j}`} value={filaments.length + j}>Filament {filaments.length + j + 1} (not loaded)</option>)}
        </select>
        {r.apply.filament !== undefined && <span className="sxw-swatch" style={{ background: filaments[r.apply.filament]?.color ?? 'transparent' }} />}
      </div>
      <div className="sxw-row"><span className="sxw-lbl">Motion</span>
        <select className="select" value={r.apply.motion?.brush_id ?? ''} onChange={(e) => set(() => { r.apply.motion = e.target.value ? { brush_id: e.target.value, scale: r.apply.motion?.scale ?? 1 } : undefined; })}>
          <option value="">None</option>
          {groups.map((g) => <optgroup key={g} label={g}>{brushes.filter((b) => (b.category ?? 'Motions') === g).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</optgroup>)}
        </select>
      </div>
      {r.apply.motion && <div className="sxw-row"><span className="sxw-lbl">Motion size</span><input type="range" min={0.2} max={3} step={0.05} value={r.apply.motion.scale} onChange={(e) => set(() => { r.apply.motion!.scale = +e.target.value; })} /><span className="sxw-unit">×{r.apply.motion.scale.toFixed(2)}</span></div>}
      {r.apply.motion && limited && <p className="sxw-warn">Made smaller to {limited.mm.toFixed(2)} mm each way so it doesn't run into the next wall. Choose the neighbouring walls too to let it swing further.</p>}
      {r.apply.motion && <MotionTabs m={r.apply.motion} onChange={() => changed()} />}
      <Num label="Speed" value={r.apply.speed} unit="%" min={10} max={300} onChange={(v) => set(() => { r.apply.speed = v; })} />
      <Num label="Flow" value={r.apply.flow} unit="%" min={10} max={200} onChange={(v) => set(() => { r.apply.flow = v; })} />
      <Num label="Temperature" value={r.apply.temp} unit="°C" min={150} max={320} onChange={(v) => set(() => { r.apply.temp = v; })} title="Set per layer: a hotend needs 10–30 s to settle, so it cannot change for single lines" />
      <div className="sxw-row" title="Speed, flow and motion fade in and out over this distance around the selection along the layer (and up and down for layer ranges). Filament changes are always sharp."><span className="sxw-lbl">Soft edge</span><input className="input" type="number" min={0} max={20} step={0.5} value={r.blend_mm} onChange={(e) => set(() => { r.blend_mm = Math.max(0, Math.min(20, +e.target.value || 0)); })} /><span className="sxw-unit">mm</span></div>
      <p className="sxw-muted">Rules lower in the list win where two set the same thing; different changes add up.</p>
    </div>
  );
}

/** "Show lines": a checkbox per line kind, and for walls and top/bottom skins how many to show, counted from the outside in. */
function ShowLines({ f, set, lc }: { f: LineFilter; set(f: LineFilter): void; lc: LineClasses | null }) {
  const n = (c: keyof LineClasses['count']) => (lc ? lc.count[c] : 0);
  const row = (key: 'outer' | 'infill' | 'solid' | 'support' | 'other', label: string, tip: string) => (n(key) > 0 || key === 'outer') && (
    <label className="sxw-check sxw-show" title={tip}><input type="checkbox" checked={f[key]} onChange={(e) => set({ ...f, [key]: e.target.checked })} />{label}</label>
  );
  const counted = (key: 'inner' | 'top' | 'bottom', upKey: 'innerUpTo' | 'topUpTo' | 'bottomUpTo', label: string, tip: string) => {
    const most = lc?.max[key] ?? 0;
    if (!most) return null;
    const v = Math.min(f[upKey], most);
    return (
      <div className="sxw-row sxw-show" title={tip}>
        <label className="sxw-check"><input type="checkbox" checked={f[key]} onChange={(e) => set({ ...f, [key]: e.target.checked })} />{label}</label>
        <input className="input" type="number" min={1} max={most} step={1} disabled={!f[key]} value={v} aria-label={`${label}: how many`}
          onChange={(e) => { const x = Math.round(+e.target.value); if (x >= 1) set({ ...f, [upKey]: x >= most ? 99 : x }); }} />
        <span className="sxw-unit">of {most}</span>
      </div>
    );
  };
  return (
    <div className="sxw-sec">
      <div className="sxw-title">Show lines<span style={{ flex: 1 }} />
        <button className="btn-secondary btn-small" onClick={() => set({ ...SHOW_ALL })} title="Show every line again">All</button>
      </div>
      {row('outer', 'Outer wall', 'The wall you see from outside')}
      {counted('inner', 'innerUpTo', 'Inner walls', 'Walls inside the outer wall, counted inwards: 1 is the wall right behind the outer wall')}
      {row('infill', 'Infill', 'Sparse infill inside the part')}
      {counted('top', 'topUpTo', 'Top layers', 'Solid skin under a top surface, counted down: 1 is the top surface itself')}
      {counted('bottom', 'bottomUpTo', 'Bottom layers', 'Solid skin over a bottom surface, counted up: 1 is the bottom surface itself')}
      {row('solid', 'Other solid infill', 'Solid infill that is not part of a top or bottom skin')}
      {row('support', 'Support', 'Support and support interface')}
      {row('other', 'Other lines', 'Anything else that prints')}
      <p className="sxw-muted">Hidden lines can't be picked or brushed, so you can hide the rest and work on one kind at a time.</p>
    </div>
  );
}

/** Which lines the rule changes: each kind on or off, walls and top / bottom layers by number, curved or straight. */
function Targets({ r, lc }: { r: SelectRule; lc: LineClasses | null }) {
  const t: RuleTargets = r.targets ?? fromLines(r);
  const put = (n: RuleTargets) => {
    const all = JSON.stringify(n) === JSON.stringify(ALL_TARGETS);
    r.targets = all ? undefined : n;
    r.lines = all ? [] : groupsOfTargets(n);
    changed();
  };
  // kinds the shown lines don't have (walls from the model have no infill or skins) are left out
  const none = (k: 'outer' | 'inner' | 'infill' | 'top' | 'bottom' | 'solid' | 'support') => !!lc && lc.count[k] === 0;
  const flag = (key: 'outer' | 'infill' | 'solid' | 'support', label: string, tip: string) => !none(key) && (
    <label className="sxw-check sxw-show" title={tip}><input type="checkbox" checked={t[key]} onChange={(e) => put({ ...t, [key]: e.target.checked })} />{label}</label>
  );
  const range = (key: 'inner' | 'top' | 'bottom', label: string, tip: string) => {
    if (none(key)) return null;
    const most = Math.max(1, lc?.max[key] ?? 1), v = t[key];
    const lo = v ? Math.min(v[0], most) : 1, hi = v ? Math.min(v[1], most) : most;
    const num = (val: number, f: (x: number) => [number, number]) => (
      <input className="input" type="number" min={1} max={most} step={1} disabled={!v} value={val} aria-label={`${label} ${val === lo ? 'from' : 'to'}`}
        onChange={(e) => { const x = Math.round(+e.target.value); if (x >= 1) { const [a, b] = f(Math.min(x, most)); put({ ...t, [key]: [Math.min(a, b), Math.max(a, b) >= most ? 99 : Math.max(a, b)] }); } }} />
    );
    return (
      <div className="sxw-row sxw-show" title={tip}>
        <label className="sxw-check"><input type="checkbox" checked={!!v} onChange={(e) => put({ ...t, [key]: e.target.checked ? [1, 99] : null })} />{label}</label>
        {num(lo, (x) => [x, hi])}<span className="sxw-unit">to</span>{num(hi, (x) => [lo, x])}<span className="sxw-unit">of {most}</span>
      </div>
    );
  };
  return (
    <>
      <div className="sxw-sub">Lines to change<span style={{ flex: 1 }} /><button className="btn-secondary btn-small" onClick={() => put({ ...ALL_TARGETS })}>All</button></div>
      {flag('outer', 'Outer wall', 'The wall you see from outside')}
      {range('inner', 'Inner walls', 'By number, counted inwards: 1 is right behind the outer wall. 2 to 2 changes only the second inner wall')}
      {flag('infill', 'Infill', 'Sparse infill')}
      {range('top', 'Top layers', 'By number, counted down: 1 is the top surface itself')}
      {range('bottom', 'Bottom layers', 'By number, counted up: 1 is the bottom surface itself')}
      {flag('solid', 'Other solid infill', 'Solid infill that is not part of a top or bottom skin')}
      {flag('support', 'Support', 'Support and support interface')}
      <div className="sxw-row" title="On walls: change only where the wall curves, or only its straight stretches. Corners count as neither.">
        <span className="sxw-lbl">Wall shape</span>
        <div className="sxw-chips">
          {(['any', 'curved', 'straight'] as const).map((k) => <button key={k} className={t.shape === k ? 'on' : ''} onClick={() => put({ ...t, shape: k })}>{k === 'any' ? 'All' : k === 'curved' ? 'Curved parts' : 'Straight parts'}</button>)}
        </div>
      </div>
    </>
  );
}

/** Targets matching an older rule's line kinds. */
function fromLines(r: SelectRule): RuleTargets {
  if (!r.lines.length) return { ...ALL_TARGETS };
  const h = (g: string) => r.lines.includes(g as never);
  return { outer: h('outer'), inner: h('inner') ? [1, 99] : null, infill: h('infill'), top: h('solid') ? [1, 99] : null, bottom: h('solid') ? [1, 99] : null, solid: h('solid'), support: h('support'), shape: 'any' };
}

const FEATURE_LABEL: Record<string, string> = { outer_wall: 'outer wall', overhang_wall: 'overhang wall', inner_wall: 'inner wall', sparse_infill: 'infill', internal_solid_infill: 'solid infill', top_surface: 'top', bottom_surface: 'bottom', bridge: 'bridge', gap_infill: 'gap fill', support: 'support', support_interface: 'support interface' };
const featureLabel = (f: string) => FEATURE_LABEL[f] ?? f.replace(/_/g, ' ');

/** How many layers above and below a picked line or brushed area reaches, and whether the change fades over them. */
function SpreadEditor({ r }: { r: SelectRule }) {
  const sp = r.spread ?? { above: 0, below: 0, fade: 'gradual' as const };
  const put = (n: Partial<typeof sp>) => { r.spread = { ...sp, ...n }; changed(); };
  const num = (key: 'above' | 'below', label: string) => (
    <div className="sxw-row" title={`Also change the same lines this many layers ${key}`}>
      <span className="sxw-lbl">{label}</span>
      <input className="input" type="number" min={0} max={200} step={1} value={sp[key]} onChange={(e) => { const v = Math.round(+e.target.value); if (v >= 0) put({ [key]: Math.min(200, v) }); }} />
      <span className="sxw-unit">layers</span>
    </div>
  );
  return (
    <>
      <div className="sxw-sub">Reach up and down</div>
      {num('above', 'Layers above')}
      {num('below', 'Layers below')}
      {(sp.above > 0 || sp.below > 0) && (
        <div className="sxw-row" title="Gradual: the change gets weaker layer by layer away from the pick. Sudden: full strength on every layer it reaches, then stops">
          <span className="sxw-lbl">Change</span>
          <div className="sxw-chips">
            <button className={sp.fade === 'gradual' ? 'on' : ''} onClick={() => put({ fade: 'gradual' })}>Gradual</button>
            <button className={sp.fade === 'sudden' ? 'on' : ''} onClick={() => put({ fade: 'sudden' })}>Sudden</button>
          </div>
        </div>
      )}
      {!r.spread && <p className="sxw-muted">This older rule fades over the soft edge instead. Set a number to choose layers exactly.</p>}
    </>
  );
}
