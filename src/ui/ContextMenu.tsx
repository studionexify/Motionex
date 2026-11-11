// Right-click menus on the 3D view: one for an empty spot on a plate,
// one for an object (or a selection of objects) and one for a part.
import { addHeightRange } from '../state/ops';
import { repairObjects } from '../state/meshTools';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { arrange, autoOrient, importDialog } from '../state/actions';
import {
  addShape, centreObjects, cutAndSeparate, clearPlate, cloneObjects, copyObjects, dropObjects, exportStl, hasClipboard, mirrorObjects,
  pasteObjects, renameObject, selectPlate, setObjectFilament, splitObject, togglePrintable,
} from '../state/objectOps';
import { addPart, addWallPart, addPlate, arrangeAll, deletePlate, moveToPlate, orientPlate, PART_LABELS, SHAPES, updatePlate } from '../state/ops';
import { openFillBed } from './FillBedDialog';
import { openPlateSettings } from './PlateControls';
import { collapseAllObjects, expandAllObjects } from '../state/tree';
import { choiceColors, useStore, type ContextMenuState } from '../state/store';
import { mixLabel } from '../profiles/mixing';
import { Icon, ShapeIcon } from './icons';
import type { PartType } from '../engine/types';
import { applyMotionToObjects } from '../plugins/motionex/ui/MotionexPanel';
import { editObjectArtwork, openPatternLibrary } from '../plugins/patternex/ui/PatternexPanel';
import { generatorOf, stepLabel, stepsOf } from '../state/steps';
import { editStep } from '../plugins/stepEdit';

export interface MenuItem {
  label?: string;
  kbd?: string;
  onClick?: () => void;
  disabled?: boolean;
  checked?: boolean;
  sub?: MenuItem[];
  sep?: true;
  swatch?: string;
  /** Line icon (icons.tsx name) and optional colour; or a coloured primitive icon. */
  icon?: string;
  iconColor?: string;
  shape?: string;
}

/** Shapes offered for parts and modifiers. */
let lastWall = 0.4;
const PART_SHAPES = SHAPES.filter(([k]) => ['box', 'cylinder', 'sphere', 'cone', 'disc', 'torus'].includes(k));

function plateItems(m: ContextMenuState): MenuItem[] {
  const s = useStore.getState();
  const count = s.objects.length;
  const pl = s.plates[m.plate];
  return [
    { label: 'Add model…', icon: 'addCube', kbd: 'Ctrl+I', onClick: importDialog },
    { label: 'Add Primitive', icon: 'primitives', sub: [...SHAPES.map(([k, l]) => ({ label: l, shape: k, onClick: () => addShape(k) })), { sep: true }, { label: 'Text shape…', icon: 'textB', kbd: 'T', onClick: () => s.set({ tool: 'text', selected: [] }) }] },
    { label: 'Paste', icon: 'paste', kbd: 'Ctrl+V', disabled: !hasClipboard(), onClick: () => pasteObjects(m.world) },
    { sep: true },
    { label: 'Select All', icon: 'selectAll', kbd: 'Ctrl+A', disabled: !count, onClick: () => selectPlate(m.plate) },
    { label: 'Arrange', icon: 'arrangeB', disabled: !count || !!pl?.locked, onClick: () => arrange(undefined, m.plate) },
    { label: 'Arrange All Plates', icon: 'arrangeB', kbd: 'A', disabled: !count, onClick: () => arrangeAll() },
    { label: 'Auto Orient', icon: 'autoOrient', disabled: !count || !!pl?.locked, onClick: () => orientPlate(m.plate) },
    { label: 'Expand All', icon: 'expandAll', disabled: !count, onClick: expandAllObjects },
    { label: 'Collapse All', icon: 'collapseAll', disabled: !count, onClick: collapseAllObjects },
    { label: 'Delete All', icon: 'deleteAll', iconColor: '#D93025', disabled: !count, onClick: () => clearPlate(m.plate) },
    { sep: true },
    { label: 'Lock', icon: 'lockB', checked: !!pl?.locked, onClick: () => updatePlate(m.plate, { locked: !pl?.locked }) },
    { label: 'Plate Settings…', icon: 'gear', onClick: () => openPlateSettings(m.plate) },
    { label: 'Add Plate', icon: 'addPlateB', onClick: addPlate },
    { label: 'Delete Plate', icon: 'deleteB', disabled: s.plates.length < 2, onClick: () => deletePlate(m.plate) },
  ];
}

function objectItems(m: ContextMenuState): MenuItem[] {
  const s = useStore.getState();
  const ids = s.selected.length ? s.selected : m.id ? [m.id] : [];
  const one = ids.length === 1 ? s.objects.find((o) => o.id === ids[0]) : undefined;
  const printable = !s.objects.filter((o) => ids.includes(o.id)).every((o) => o.printable === false);
  const PART_ICON: Record<PartType, [string, string]> = { part: ['partAdd', '#1FAA3C'], negative: ['partNeg', '#D93025'], modifier: ['partMod', '#E3A21A'], support_enforcer: ['partEnf', '#1E88E5'], support_blocker: ['partBlk', '#E53935'] };
  const partSub = (type: PartType): MenuItem => ({
    label: `Add ${PART_LABELS[type].toLowerCase()}`, disabled: !one, icon: PART_ICON[type][0], iconColor: PART_ICON[type][1],
    sub: PART_SHAPES.map(([k, l]) => ({ label: l, shape: k, onClick: () => one && addPart(one.id, type, k) })),
  });
  // wall cutters / shells: every primitive, wall asked once (remembered for the next one)
  const wallSub = (mode: 'cut' | 'add'): MenuItem => ({
    label: mode === 'cut' ? 'Add wall cutter (splits along the shape)' : 'Add wall shell (thin-walled shape)', disabled: !one,
    icon: mode === 'cut' ? 'partNeg' : 'partAdd', iconColor: mode === 'cut' ? '#D93025' : '#1FAA3C',
    sub: SHAPES.map(([k, l]) => ({ label: l, shape: k, onClick: () => {
      if (!one) return;
      const v = prompt(mode === 'cut' ? 'Wall cutter thickness (mm): the gap cut along the shape\'s surface' : 'Wall thickness (mm)', String(lastWall));
      const w = v === null ? NaN : parseFloat(v.replace(',', '.'));
      if (!(w > 0)) return;
      lastWall = w;
      addWallPart(one.id, mode, k, w);
    } })),
  });
  // plugin steps of the clicked object (or the one selected): reopen any of them in its Studio, first in the menu
  const target = one ?? s.objects.find((o) => o.id === m.id);
  const steps = target ? stepsOf(target) : [];
  const stepItems: MenuItem[] = target && steps.length ? [...steps.map((st, i) => ({ label: `${i === 0 && generatorOf(target) ? 'Edit design in' : 'Edit in'} ${stepLabel(st.plugin)} Studio`, icon: 'edit', onClick: () => editStep(target, st) })), { sep: true }] : [];
  const items: MenuItem[] = [
    ...stepItems,
    { label: one ? `Rename “${one.name}”…` : `${ids.length} objects`, icon: 'editName', disabled: !one, onClick: () => one && renameObject(one.id) },
    { sep: true },
    { label: 'Copy', icon: 'copy', kbd: 'Ctrl+C', onClick: () => copyObjects(ids) },
    { label: 'Paste', icon: 'paste', kbd: 'Ctrl+V', disabled: !hasClipboard(), onClick: () => pasteObjects() },
    { label: 'Duplicate', icon: 'duplicate', kbd: 'Ctrl+D', onClick: () => cloneObjects(1, ids) },
    { label: 'Clone…', icon: 'clone', onClick: () => { const n = parseInt(prompt('Number of copies', '2') ?? '', 10); if (n > 0) cloneObjects(Math.min(n, 200), ids); } },
    { label: 'Fill bed with copies…', icon: 'fillBed', disabled: !one, onClick: () => one && openFillBed(one.id) },
    { label: 'Delete', icon: 'deleteB', iconColor: '#D93025', kbd: 'Del', onClick: () => s.removeSelected() },
    { sep: true },
    { label: 'Center on plate', icon: 'centre', onClick: () => centreObjects(ids) },
    { label: 'Drop to bed', icon: 'dropBed', onClick: () => dropObjects(ids) },
    { label: 'Auto orient', icon: 'autoOrient', kbd: 'O', onClick: () => autoOrient(ids) },
    { label: 'Mirror', icon: 'mirror', sub: [{ label: 'Along X', icon: 'mirror', onClick: () => mirrorObjects(0, ids) }, { label: 'Along Y', icon: 'mirror', onClick: () => mirrorObjects(1, ids) }, { label: 'Along Z', icon: 'mirror', onClick: () => mirrorObjects(2, ids) }] },
    { label: 'Fix model', icon: 'shield', iconColor: s.objects.some((o) => ids.includes(o.id) && o.openEdges > 0) ? '#E3A21A' : undefined, onClick: () => repairObjects(ids) },
    { label: 'Split to objects', icon: 'splitB', disabled: !one, onClick: () => one && splitObject(one.id) },
    { sep: true },
    { label: 'Filament', icon: 'filamentB', sub: choiceColors(s).map((c, k) => ({ label: k < s.filaments.length ? `Filament ${k + 1}` : `Filament ${k + 1} (mix ${mixLabel(s.mixes[k - s.filaments.length])})`, swatch: c, checked: !!one && (one.filament ?? 0) === k, onClick: () => setObjectFilament(k, ids) })) },
    { label: 'Printable', icon: 'printable', checked: printable, onClick: () => togglePrintable(ids) },
    ...(s.plates.length > 1 ? [{ label: 'Move to plate', icon: 'moveToPlate', sub: s.plates.map((p, k) => ({ label: p.name, disabled: k === m.plate, onClick: () => { s.set({ selected: ids }); moveToPlate(k); } })) }] : []),
    { sep: true },
    partSub('part'),
    partSub('negative'),
    wallSub('cut'),
    wallSub('add'),
    { label: 'Cut along wall cutters and separate', icon: 'splitB', disabled: !one?.parts?.some((p) => p.type === 'negative' || p.type === 'part'), onClick: () => one && cutAndSeparate(one.id) },
    partSub('modifier'),
    partSub('support_enforcer'),
    partSub('support_blocker'),
    { label: 'Add height range modifier', icon: 'heightRange', disabled: !one, onClick: () => one && addHeightRange(one.id) },
    { sep: true },
    { label: 'Paint support', icon: 'supportPaint', kbd: 'L', onClick: () => s.set({ selected: ids, tool: 'paint_support' }) },
    { label: 'Paint seam', icon: 'seamPaint', kbd: 'P', onClick: () => s.set({ selected: ids, tool: 'paint_seam' }) },
    { label: 'Paint colour', icon: 'colorPaint', kbd: 'N', disabled: s.filaments.length < 2, onClick: () => s.set({ selected: ids, tool: 'paint_color' }) },
    { label: 'Cut', icon: 'cutB', kbd: 'C', disabled: !one, onClick: () => s.set({ selected: ids, tool: 'cut' }) },
  ];
  if (s.plugins.includes('motionex')) items.push({ label: 'Motion on whole object (Motionex)', icon: 'motion', onClick: () => applyMotionToObjects(ids) });
  if (s.plugins.includes('patternex')) {
    const placed = s.objects.filter((o) => ids.includes(o.id)).reduce((n, o) => n + (o.patternex?.placements.length ?? 0), 0);
    items.push({ label: 'Artwork (Patternex)', icon: 'artwork', sub: [
      { label: 'Add from pattern library…', onClick: () => { s.set({ selected: ids }); openPatternLibrary(); } },
      { label: `Edit inks and placement${placed ? ` (${placed})` : ''}`, disabled: !placed, onClick: () => editObjectArtwork(ids[0]) },
      { label: 'Remove artwork', disabled: !placed, onClick: () => s.updateObjects((o) => ({ ...o, patternex: undefined }), ids) },
    ] });
  }
  items.push({ sep: true }, { label: 'Export as STL…', icon: 'exportB', onClick: () => exportStl(ids) });
  return items;
}

function partItems(m: ContextMenuState): MenuItem[] {
  const s = useStore.getState();
  return [
    { label: 'Delete part', icon: 'deleteB', iconColor: '#D93025', kbd: 'Del', onClick: () => { s.set({ selected: [m.id!], selectedPart: m.partId! }); useStore.getState().removeSelected(); } },
    { label: 'Move', icon: 'moveB', kbd: 'M', onClick: () => s.set({ tool: 'move' }) },
    { label: 'Rotate', icon: 'rotateB', kbd: 'R', onClick: () => s.set({ tool: 'rotate' }) },
    { label: 'Scale', icon: 'scaleB', kbd: 'S', onClick: () => s.set({ tool: 'scale' }) },
    { label: 'Edit settings', icon: 'gear', onClick: () => s.set({ processMode: 'objects' }) },
  ];
}

export function ContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const set = useStore((s) => s.set);
  useEffect(() => {
    if (!menu) return;
    const close = () => set({ contextMenu: null });
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); window.removeEventListener('resize', close); };
  }, [menu, set]);
  if (!menu) return null;
  const items = menu.kind === 'plate' ? plateItems(menu) : menu.kind === 'part' ? partItems(menu) : objectItems(menu);
  return <MenuList items={items} x={menu.x} y={menu.y} onDone={() => set({ contextMenu: null })} />;
}

function MenuList({ items, x, y, onDone }: { items: MenuItem[]; x: number; y: number; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [open, setOpen] = useState<number | null>(null);
  const [subAt, setSubAt] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: Math.max(4, Math.min(x, innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, innerHeight - r.height - 4)) });
  }, [x, y]);
  return (
    <>
      <div ref={ref} className="menu-pop ctx-menu" role="menu" style={{ left: pos.x, top: pos.y }} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
        {items.map((it, k) => it.sep ? <div key={k} className="ctx-sep" /> : (
          <button key={k} role="menuitem" className={`menu-item ${open === k ? 'open' : ''}`} disabled={it.disabled}
            onPointerEnter={(e) => { if (it.sub) { const r = e.currentTarget.getBoundingClientRect(); setSubAt({ x: r.right + 2, y: r.top - 6 }); setOpen(k); } else setOpen(null); }}
            onClick={() => { if (it.sub) return; it.onClick?.(); onDone(); }}>
            <span className="ctx-label">
              <span className="ctx-check">{it.checked ? '✓' : ''}</span>
              <span className="ctx-icon">{it.shape ? <ShapeIcon kind={it.shape} size={18} /> : it.icon ? <Icon name={it.icon} size={18} style={it.iconColor ? { color: it.iconColor } : undefined} /> : null}</span>
              {it.swatch && <i className="ctx-swatch" style={{ background: it.swatch }} />}
              {it.label}
            </span>
            {it.sub ? <span className="ctx-arrow"><Icon name="chevronRight" size={14} /></span> : it.kbd ? <kbd>{it.kbd}</kbd> : null}
          </button>
        ))}
      </div>
      {open !== null && items[open]?.sub && !items[open].disabled && <MenuList key={open} items={items[open].sub!} x={subAt.x} y={subAt.y} onDone={onDone} />}
    </>
  );
}
