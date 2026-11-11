import { Live3DToggle } from '../Live3D';
import { printerSwitchChoice, resetPrinterSwitchChoice } from '../ImportDialog';
// Top menu bar (File / Edit / View / Add / Tools / Help) like a desktop app, plus the Preferences
// dialog and the interface scale that keeps the layout fitting smaller windows.
import { useEffect, useState } from 'react';
import { arrange, autoOrient, exportGcode, importDialog, newProject, sliceAllPlates, sliceAndPreview } from '../../state/actions';
import { exportPlateFile } from '../../state/printjob';
import { openProjectDialog, saveProject } from '../../state/project';
import { useStore, type Workspace } from '../../state/store';
import { addShape, cloneObjects, copyObjects, exportStl, hasClipboard, mirrorObjects, pasteObjects, splitObject } from '../../state/objectOps';
import { addPlate, arrangeAll, deletePlate, SHAPES } from '../../state/ops';
import { useUi, type UiScale } from '../../state/ui';
import { viewApi } from '../../viewport/Viewport';
import { openPrintDialog } from '../PrintModal';
import { openPlateSettings } from '../PlateControls';
import { openFillBed } from '../FillBedDialog';
import { Modal } from '../Modals';
import { PLUGINS } from '../../plugins/registry';
import { togglePlugin } from './Rail';
import { useSliced } from './FileMenu';
import { PlateSelect } from './TopRight';
import { ModeToggle } from '../advanced/ModeToggle';
import { Icon } from '../icons';

interface Item { switch?: boolean; head?: string; keep?: boolean; label?: string; kbd?: string; onClick?: () => void; disabled?: boolean; checked?: boolean; sep?: true }

/** Auto scale: shrink everything a little on smaller windows so the panels never collide. */
function autoScale(w: number, h: number) {
  if (w <= 1024) return 1; // tablet / phone: full-size touch targets, no shrinking
  const fw = w >= 1760 ? 1 : w >= 1500 ? 0.92 : w >= 1320 ? 0.86 : 0.8;
  const fh = h >= 900 ? 1 : h >= 780 ? 0.92 : 0.85;
  return Math.min(fw, fh);
}

/** Applies the interface scale (Preferences → Interface size) to the app root. */
export function useUiScale() {
  const scale = useUi((s) => s.uiScale);
  useEffect(() => {
    const apply = () => {
      const z = scale === 'auto' ? autoScale(window.innerWidth, window.innerHeight) : scale;
      document.documentElement.style.setProperty('--ui-zoom', String(z));
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [scale]);
}

const go = (workspace: Workspace) => useStore.getState().set({ workspace });

function useMenus(openPrefs: () => void): [string, Item[]][] {
  const s = useStore();
  const sliced = useSliced();
  const sel = s.selected.length > 0;
  const prep = s.workspace === 'prepare';
  const has = s.objects.length > 0;
  const hasProgram = !!s.plates[s.activePlate]?.program;
  const tool = (t: typeof s.tool) => () => s.set({ workspace: 'prepare', tool: s.tool === t ? 'select' : t });
  return [
    ['File', [
      { label: 'New project', kbd: 'Ctrl+N', onClick: newProject },
      { label: 'Open project (.3mf)…', kbd: 'Ctrl+O', onClick: () => void openProjectDialog() },
      { label: 'Save project…', kbd: 'Ctrl+S', onClick: () => void saveProject(), disabled: !has },
      { sep: true },
      { label: 'Import STL / OBJ / 3MF / AMF / STEP…', kbd: 'Ctrl+I', onClick: importDialog },
      { label: 'Export selection as STL…', onClick: () => void exportStl(), disabled: !sel },
      { sep: true },
      { label: 'Slice plate', kbd: 'Ctrl+R', onClick: sliceAndPreview, disabled: !has && !hasProgram },
      { label: 'Slice all plates', onClick: () => void sliceAllPlates(), disabled: !has || s.plates.length < 2 },
      { label: 'Export G-code…', kbd: 'Ctrl+G', onClick: exportGcode, disabled: !sliced },
      { label: 'Export sliced plate (.gcode.3mf)…', onClick: () => void exportPlateFile('3mf'), disabled: !sliced },
      { label: 'Print plate…', kbd: 'Ctrl+P', onClick: () => void openPrintDialog(), disabled: !sliced },
      { sep: true },
      { label: 'Preferences…', kbd: 'Ctrl+,', onClick: openPrefs },
    ]],
    ['Edit', [
      { label: 'Undo', kbd: 'Ctrl+Z', onClick: s.undo, disabled: !s.undoStack.length },
      { label: 'Redo', kbd: 'Ctrl+Y', onClick: s.redo, disabled: !s.redoStack.length },
      { sep: true },
      { label: 'Copy', kbd: 'Ctrl+C', onClick: () => copyObjects(), disabled: !sel },
      { label: 'Paste', kbd: 'Ctrl+V', onClick: () => pasteObjects(), disabled: !hasClipboard() },
      { label: 'Duplicate', kbd: 'Ctrl+D', onClick: s.duplicateSelected, disabled: !sel },
      { label: 'Clone…', onClick: () => { const n = Number(prompt('Number of copies', '2')); if (n > 0) cloneObjects(Math.min(100, Math.round(n))); }, disabled: !sel },
      { label: 'Delete', kbd: 'Del', onClick: s.removeSelected, disabled: !sel },
      { sep: true },
      { label: 'Select all', kbd: 'Ctrl+A', onClick: () => s.set({ selected: s.objects.map((o) => o.id) }), disabled: !has },
      { label: 'Clear selection', kbd: 'Esc', onClick: () => s.set({ selected: [], selectedPart: null }), disabled: !sel },
      { sep: true },
      { label: 'Mirror X', onClick: () => mirrorObjects(0), disabled: !sel },
      { label: 'Mirror Y', onClick: () => mirrorObjects(1), disabled: !sel },
      { label: 'Split into parts', onClick: () => s.selected[0] && splitObject(s.selected[0]), disabled: s.selected.length !== 1 },
      { sep: true },
      { label: 'Find setting', kbd: 'Ctrl+F', onClick: () => { go('prepare'); setTimeout(() => document.getElementById('param-search')?.focus(), 0); } },
      { label: 'Preferences…', kbd: 'Ctrl+,', onClick: openPrefs },
    ]],
    ['View', [
      { label: 'Motionex workbench', onClick: () => go('workbench'), checked: s.workspace === 'workbench' },
      { label: 'Home', onClick: () => go('home'), checked: s.workspace === 'home' },
      { label: 'Prepare', onClick: () => go('prepare'), checked: prep },
      { label: 'Preview', onClick: () => go('preview'), checked: s.workspace === 'preview' },
      { label: 'Device', onClick: () => go('device'), checked: s.workspace === 'device' },
      { label: 'Project', onClick: () => go('project'), checked: s.workspace === 'project' },
      { label: 'Calibration', onClick: () => go('calibration'), checked: s.workspace === 'calibration' },
      { sep: true },
      { label: 'Fit to view', kbd: 'Z', onClick: () => viewApi.current?.fit() },
      { label: 'Isometric', kbd: 'Ctrl+0', onClick: () => viewApi.current?.setView('iso') },
      { label: 'Top', kbd: 'Ctrl+1', onClick: () => viewApi.current?.setView('top') },
      { label: 'Front', kbd: 'Ctrl+3', onClick: () => viewApi.current?.setView('front') },
      { label: 'Left', kbd: 'Ctrl+5', onClick: () => viewApi.current?.setView('left') },
      { label: 'Right', kbd: 'Ctrl+6', onClick: () => viewApi.current?.setView('right') },
      { sep: true },
      { label: 'Toolpath view', checked: s.liveToolpaths, onClick: () => s.set({ liveToolpaths: !s.liveToolpaths }) },
      { label: 'Highlight overhangs', checked: s.showOverhangs, onClick: () => s.set({ showOverhangs: !s.showOverhangs }) },
      { label: 'Dark theme', checked: s.theme === 'dark', onClick: () => s.set({ theme: s.theme === 'dark' ? 'light' : 'dark' }) },
      { sep: true },
      { label: 'Command palette', kbd: 'Ctrl+K', onClick: () => useUi.getState().set({ paletteOpen: true }) },
    ]],
    ['Add', [
      ...SHAPES.slice(0, 8).map(([k, l]): Item => ({ label: l, onClick: () => { go('prepare'); addShape(k); } })),
      { label: 'Text shape…', kbd: 'T', onClick: tool('text') },
      { sep: true },
      { label: 'Add plate', onClick: addPlate },
      { label: 'Delete plate', onClick: () => deletePlate(), disabled: s.plates.length < 2 },
      { label: 'Plate settings…', onClick: () => openPlateSettings(s.activePlate) },
      { label: 'Fill bed with copies…', onClick: () => s.selected[0] && openFillBed(s.selected[0]), disabled: s.selected.length !== 1 },
    ]],
    ['Tools', [
      { label: 'Arrange plate', kbd: 'A', onClick: () => arrange(), disabled: !has },
      { label: 'Arrange all plates', onClick: () => arrangeAll(), disabled: !has },
      { label: 'Auto orient', kbd: 'O', onClick: () => autoOrient(), disabled: !has },
      { sep: true },
      { label: 'Move', kbd: 'M', onClick: tool('move'), checked: prep && s.tool === 'move' },
      { label: 'Rotate', kbd: 'R', onClick: tool('rotate'), checked: prep && s.tool === 'rotate' },
      { label: 'Scale', kbd: 'S', onClick: tool('scale'), checked: prep && s.tool === 'scale' },
      { label: 'Lay on face', kbd: 'F', onClick: tool('face'), checked: prep && s.tool === 'face' },
      { label: 'Cut', kbd: 'C', onClick: tool('cut'), checked: prep && s.tool === 'cut' },
      { label: 'Boolean', kbd: 'B', onClick: tool('boolean'), checked: prep && s.tool === 'boolean' },
      { label: 'Measure', kbd: 'U', onClick: tool('measure'), checked: prep && s.tool === 'measure' },
      { sep: true },
      { label: 'Support painting', kbd: 'L', onClick: tool('paint_support'), checked: prep && s.tool === 'paint_support' },
      { label: 'Seam painting', kbd: 'P', onClick: tool('paint_seam'), checked: prep && s.tool === 'paint_seam' },
      { label: 'Colour painting', kbd: 'N', onClick: tool('paint_color'), checked: prep && s.tool === 'paint_color' },
      { label: 'Variable layer height', kbd: 'H', onClick: tool('vlh'), checked: prep && s.tool === 'vlh' },
      { label: 'Brim ears', kbd: 'E', onClick: tool('brim_ears'), checked: prep && s.tool === 'brim_ears' },
      { sep: true },
      { label: 'Calibration…', onClick: () => go('calibration') },
    ]],
    ['Plugins', PLUGINS.map((p): Item => ({ label: p.name, switch: true, checked: s.plugins.includes(p.id), keep: true, onClick: () => togglePlugin(p.id) }))],
    ['Help', [
      { label: 'Keyboard shortcuts', kbd: '?', onClick: () => s.set({ shortcutsOpen: true }) },
      { label: 'Search everything', kbd: 'Ctrl+K', onClick: () => useUi.getState().set({ paletteOpen: true }) },
    ]],
  ];
}

const SCALES: [UiScale, string][] = [['auto', 'Auto (fit window)'], [0.8, 'Compact (80%)'], [0.9, 'Small (90%)'], [1, 'Default (100%)'], [1.1, 'Large (110%)']];

function Preferences({ onClose }: { onClose: () => void }) {
  const { theme, liveToolpaths, showOverhangs, set } = useStore();
  const { uiScale, set: setUi } = useUi();
  return (
    <Modal title="Preferences" onClose={onClose}>
      <div className="prefs">
        <label>Interface size
          <select value={String(uiScale)} onChange={(e) => setUi({ uiScale: e.target.value === 'auto' ? 'auto' : Number(e.target.value) as UiScale })}>
            {SCALES.map(([v, l]) => <option key={String(v)} value={String(v)}>{l}</option>)}
          </select>
        </label>
        <label>Theme
          <select value={theme} onChange={(e) => set({ theme: e.target.value as typeof theme })}>
            <option value="light">Light</option><option value="dark">Dark</option>
          </select>
        </label>
        <label className="row"><input type="checkbox" checked={liveToolpaths} onChange={() => set({ liveToolpaths: !liveToolpaths })} />Show toolpath view while preparing</label>
        <label className="row"><input type="checkbox" checked={showOverhangs} onChange={() => set({ showOverhangs: !showOverhangs })} />Highlight overhangs</label>
        <div className="row" style={{ gap: 8 }}><span style={{ flex: 1 }}>Studio previews (Plantex, Lumonex, Flenex, Clickex)</span><Live3DToggle /></div>
        <PrinterSwitchReset />
      </div>
    </Modal>
  );
}

export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const [prefs, setPrefs] = useState(false);
  const menus = useMenus(() => setPrefs(true));
  const { undo, redo, undoStack, redoStack, workspace, theme } = useStore();
  const is3d = workspace === 'prepare' || workspace === 'preview';
  useUiScale();
  const compact = useCompactMenu();
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') { setPrefs(true); e.preventDefault(); }
      if (e.key === 'Escape') setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <nav className="sh-menubar" role="menubar" aria-label="Main menu">
      <img className="sh-mb-logo" src={theme === 'dark' ? './logo-dark.svg' : './logo-light.svg'} alt="NexSpiro" />
      {compact && (
        <button className={`sh-mb sh-mb-burger ${sheet ? 'on' : ''}`} aria-label="Menu" aria-expanded={sheet} onClick={() => setSheet(!sheet)}>
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      )}
      {compact && sheet && (
        <>
          <div className="sh-msheet-scrim" onClick={() => setSheet(false)} />
          <div className="sh-msheet" role="menu" aria-label="Main menu">
            {menus.map(([name, items]) => (
              <details key={name} className="sh-msec" open={name === 'File'}>
                <summary>{name}</summary>
                {items.map((it, i) => it.sep ? <div key={i} className="sh-mb-sep" /> : it.head ? <div key={i} className="sh-mb-head">{it.head}</div> : (
                  <button key={i} role={it.keep ? 'menuitemcheckbox' : 'menuitem'} aria-checked={it.keep ? !!it.checked : undefined} className="menu-item" disabled={it.disabled}
                    onClick={() => { if (!it.keep) setSheet(false); it.onClick?.(); }}>
                    <span className="sh-mb-check">{!it.switch && it.checked ? '✓' : ''}</span><span className="sh-mb-label">{it.label}</span>
                    {it.switch ? <span className={`sh-switch ${it.checked ? 'on' : ''}`} aria-hidden /> : null}
                  </button>
                ))}
              </details>
            ))}
          </div>
        </>
      )}
      {!compact && menus.map(([name, items]) => (
        <div key={name} className="menu">
          <button role="menuitem" aria-haspopup="menu" aria-expanded={open === name} className={`sh-mb ${open === name ? 'on' : ''}`}
            onPointerDown={stop} onClick={() => setOpen(open === name ? null : name)} onPointerEnter={(e) => e.pointerType === 'mouse' && open && setOpen(name)}>{name}</button>
          {open === name && (
            <div className="menu-pop sh-mb-pop" role="menu" onPointerDown={stop}>
              {items.map((it, i) => it.sep ? <div key={i} className="sh-mb-sep" /> : it.head ? <div key={i} className="sh-mb-head">{it.head}</div> : (
                <button key={i} role={it.keep ? 'menuitemcheckbox' : 'menuitem'} aria-checked={it.keep ? !!it.checked : undefined} className="menu-item" disabled={it.disabled}
                  onClick={() => { if (!it.keep) setOpen(null); it.onClick?.(); }}>
                  <span className="sh-mb-check">{!it.switch && it.checked ? '✓' : ''}</span><span className="sh-mb-label">{it.label}</span>
                  {it.switch ? <span className={`sh-switch ${it.checked ? 'on' : ''}`} aria-hidden /> : <kbd>{it.kbd ?? ''}</kbd>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <span className="sh-div" />
      <button className="sh-ib" title="Import (Ctrl+I)" aria-label="Import" onClick={importDialog}><Icon name="download" size={15} /></button>
      <button className="sh-ib" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!undoStack.length} onClick={undo}><Icon name="undo" size={15} /></button>
      <button className="sh-ib" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!redoStack.length} onClick={redo}><Icon name="redo" size={15} /></button>
      <span className="sh-div" />
      <ModeToggle compact />
      <span className="spacer" />
      <button className="sh-ib" title="Search (Ctrl+K)" aria-label="Search" onClick={() => useUi.getState().set({ paletteOpen: true })}><Icon name="search" size={15} /></button>
      {is3d && <PlateSelect />}
      {prefs && <Preferences onClose={() => setPrefs(false)} />}
    </nav>
  );
}

/** "Don't show again" on the different-printer question: shows the remembered answer and brings the question back. */
function PrinterSwitchReset() {
  const [v, setV] = useState(() => printerSwitchChoice());
  return (
    <div className="row" style={{ gap: 8 }}>
      <span style={{ flex: 1 }}>File made for another printer: {v === 'switch' ? 'always switch' : v === 'keep' ? 'always keep current' : 'ask each time'}</span>
      <button className="btn-secondary btn-small" disabled={!v} onClick={() => { resetPrinterSwitchChoice(); setV(null); }}>Reset</button>
    </div>
  );
}

/** Tablets and phones (≤1024px or no hover-capable pointer) get one Menu button with a full-height sheet. */
function useCompactMenu() {
  const q = '(max-width: 1024px), (hover: none)';
  const [c, set] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches);
  useEffect(() => { const m = matchMedia(q); const f = () => set(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return c;
}
