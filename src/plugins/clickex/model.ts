// Clickex design model. Plain data only: it is saved in the browser, in the project file and in the user's
// design library as JSON. Imported bitmaps travel as data URLs; imported 3D models are kept by the UI state.

export type Source = 'image' | 'svg' | 'icon' | 'text' | 'blocks' | 'model';
export type BaseStyle = 'outline' | 'shape';
export type BlockLayout = 'row' | 'column' | 'grid' | 'wasd' | 'arrows' | 'custom';
export type ModelCut = 'split' | 'stand' | 'top';
export type DesignMode = 'color' | 'raise' | 'engrave';
export type Lettering = DesignMode;

export interface ClickexSpec {
  version: 1;
  name: string;
  source: Source;
  svg: { name: string; text: string; sample: string };
  image: { name: string; w: number; h: number; dataUrl: string } | null;
  trace: { colors: number; alphaCut: number; removeBg: boolean; smooth: number; speck: number };
  icon: { name: string; stroke: number };
  text: { text: string; font: string; weight: number; tracking: number; lineHeight: number; arc: number };
  blocks: {
    layout: BlockLayout;
    /** One line per row, one key per character (spaces are empty keys in a custom layout). */
    text: string;
    cols: number;
    rows: number;
    /** Custom layout: which cells carry a key (rows × cols, row-major). */
    cells: boolean[];
    font: string;
    letterSize: number;
    lettering: Lettering;
    pitch: number;
    borders: boolean;
    borderW: number;
    symbols: string[];
  };
  model: { name: string; cut: ModelCut; splitZ: number; hideGap: boolean; scale: number; buttonD: number; standH: number; standD: number; lip: number };
  shape: {
    baseStyle: BaseStyle;
    baseShape: string;
    size: number;
    designSize: number;
    lockBase: boolean;
    dx: number;
    dy: number;
    rot: number;
    flip: boolean;
    /** Outline style: border around the artwork (mm) and gap bridging between separate pieces (mm). */
    border: number;
    bridge: number;
    fillHoles: boolean;
  };
  body: { wall: number; rimWall: number; floor: 'solid' | 'open'; floorT: number; capTop: number; capRound: number; baseRound: number; extraHeight: number; plate: number; hideGap: boolean;
    /** Profile of the button's top edge. */ capEdge: EdgeProfile;
    /** Profile of the base's top edge (around the buttons). */ baseEdge: EdgeProfile };
  colors: { base: string; button: string; ink: string; map: Record<string, string>; mode: DesignMode; raise: number; inlay: number };
  sw: { id: string; travel: number; angle: number; auto: boolean; dx: number; dy: number; housingTop: number; stemTop: number };
  keychain: { enabled: boolean; angle: number; outerD: number; holeD: number; thickness: number; reach: number };
  fit: { switchTol: number; pocketTol: number; capClear: number; bossTol: number; bossD: number; xy: number };
}

export function defaultSpec(): ClickexSpec {
  return {
    version: 1, name: 'My clicker', source: 'svg',
    svg: { name: 'NexSpiro', text: '', sample: 'nexspiro' },
    image: null,
    trace: { colors: 3, alphaCut: 128, removeBg: true, smooth: 0.25, speck: 0.5 },
    icon: { name: 'heart', stroke: 2 },
    text: { text: 'CLICK', font: 'inter', weight: 0, tracking: 0, lineHeight: 1.1, arc: 0 },
    blocks: { layout: 'row', text: 'Name', cols: 3, rows: 3, cells: [true, true, true, true, true, true, true, true, true], font: 'inter', letterSize: 11, lettering: 'color', pitch: 24, borders: true, borderW: 1.6, symbols: [] },
    model: { name: '', cut: 'split', splitZ: 30, hideGap: true, scale: 100, buttonD: 28, standH: 4, standD: 34, lip: 1.2 },
    shape: { baseStyle: 'outline', baseShape: 'circle', size: 35, designSize: 100, lockBase: false, dx: 0, dy: 0, rot: 0, flip: false, border: 2.4, bridge: 1.5, fillHoles: true },
    body: { wall: 1.2, rimWall: 1, floor: 'solid', floorT: 1.5, capTop: 1.6, capRound: 1.2, baseRound: 1, extraHeight: 0, plate: 1.5, hideGap: true, capEdge: { kind: 'fillet', width: 1.2, height: 1.2, steps: 2 }, baseEdge: { kind: 'none', width: 1, height: 1, steps: 2 } },
    colors: { base: '#e9e5dc', button: '#ffffff', ink: '#2f2f33', map: {}, mode: 'color', raise: 0.8, inlay: 0.8 },
    sw: { id: 'mx', travel: 3, angle: 0, auto: true, dx: 0, dy: 0, housingTop: 6.6, stemTop: 10.2 },
    keychain: { enabled: false, angle: 90, outerD: 10, holeD: 4.6, thickness: 2.4, reach: 0 },
    fit: { switchTol: 0.1, pocketTol: 0.3, capClear: 0.25, bossTol: 0.1, bossD: 5.4, xy: 0 },
  };
}

const merge = <T>(d: T, s: Partial<T> | undefined): T => ({ ...d, ...(s ?? {}) });

/** Fill gaps in stored data with defaults (older saves, partial presets). */
/** Edge profile: none, a round (fillet), a straight bevel (chamfer) or a stair of `steps` ledges. width is how far
 *  the profile reaches in from the edge, height how far down; a fillet uses width as its radius. */
export type EdgeKind = 'none' | 'fillet' | 'chamfer' | 'step';
export interface EdgeProfile { kind: EdgeKind; width: number; height: number; steps: number }

/** Body settings; designs saved before edge profiles keep their rounded button edge (capRound). */
function bodyOf(d: ClickexSpec['body'], s: Partial<ClickexSpec['body']> | undefined): ClickexSpec['body'] {
  const b = { ...d, ...(s ?? {}) };
  if (!s?.capEdge) b.capEdge = s?.capRound !== undefined ? { kind: s.capRound > 0.05 ? 'fillet' : 'none', width: s.capRound || 1, height: s.capRound || 1, steps: 2 } : { ...d.capEdge };
  else b.capEdge = { ...d.capEdge, ...s.capEdge };
  b.baseEdge = { ...d.baseEdge, ...(s?.baseEdge ?? {}) };
  return b;
}

export function normalizeSpec(s: Partial<ClickexSpec> | undefined): ClickexSpec {
  const d = defaultSpec();
  if (!s) return d;
  return {
    ...d, ...s, version: 1,
    svg: merge(d.svg, s.svg), image: s.image ?? null, trace: merge(d.trace, s.trace), icon: merge(d.icon, s.icon), text: merge(d.text, s.text),
    blocks: { ...merge(d.blocks, s.blocks), cells: s.blocks?.cells?.length ? [...s.blocks.cells] : d.blocks.cells, symbols: [...(s.blocks?.symbols ?? [])] },
    model: merge(d.model, s.model), shape: merge(d.shape, s.shape), body: bodyOf(d.body, s.body),
    colors: { ...merge(d.colors, s.colors), map: { ...(s.colors?.map ?? {}) } },
    sw: merge(d.sw, s.sw), keychain: merge(d.keychain, s.keychain), fit: merge(d.fit, s.fit),
  };
}

export const SOURCES: { id: Source; name: string }[] = [
  { id: 'image', name: 'Image' }, { id: 'svg', name: 'SVG' }, { id: 'icon', name: 'Icon' },
  { id: 'text', name: 'Text' }, { id: 'blocks', name: 'Blocks' }, { id: 'model', name: '3D model' },
];

export const LAYOUTS: { id: BlockLayout; name: string }[] = [
  { id: 'row', name: 'Row' }, { id: 'column', name: 'Column' }, { id: 'grid', name: 'Grid' },
  { id: 'wasd', name: 'WASD' }, { id: 'arrows', name: 'Arrows' }, { id: 'custom', name: 'Custom' },
];
