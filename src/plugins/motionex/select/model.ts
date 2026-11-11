// Select & apply: rules made in the Select window. Each rule is a selection on the sliced print (a range of
// layers, single printed lines, or a brushed area) and what to change there: filament, a motion, speed, flow,
// temperature. Rules are plain data and travel to the slicing worker as part of the Motionex config.
// Selections are stored in plate mm, tied to the object they were made on: if the object moves, they move with it.
import type { FeatureType } from '../../../engine/types';

/** Kinds of printed line a rule can be limited to. */
export type LineGroup = 'outer' | 'inner' | 'infill' | 'solid' | 'support';

export const LINE_GROUPS: [LineGroup, string][] = [
  ['outer', 'Outer wall'], ['inner', 'Inner walls'], ['infill', 'Infill'], ['solid', 'Top / bottom / solid'], ['support', 'Support'],
];

const GROUP_FEATURES: Record<LineGroup, FeatureType[]> = {
  outer: ['outer_wall', 'overhang_wall'],
  inner: ['inner_wall'],
  infill: ['sparse_infill'],
  solid: ['internal_solid_infill', 'top_surface', 'bottom_surface', 'bridge', 'gap_infill', 'ironing'],
  support: ['support', 'support_interface'],
};

/** Features a rule may change: its line groups, or every printed part line when none are chosen. */
export function featuresOf(groups: LineGroup[] | undefined): Set<FeatureType> {
  const g = groups?.length ? groups : (Object.keys(GROUP_FEATURES) as LineGroup[]);
  return new Set(g.flatMap((k) => GROUP_FEATURES[k]).concat(groups?.length ? [] : ['wave_overhang']));
}

export function groupOf(f: FeatureType): LineGroup | undefined {
  for (const [g, fs] of Object.entries(GROUP_FEATURES)) if (fs.includes(f)) return g as LineGroup;
  return undefined;
}

/** One printed line picked in the window (a whole run of one feature between travels), plate mm. */
export interface LinePick {
  /** Object the line belongs to (id), when known. */
  obj?: string;
  /** Layer top (mm) and height. */
  z: number;
  h: number;
  feature: FeatureType;
  /** Line width (mm). */
  w: number;
  pts: [number, number][];
}

/** One brush dab: a ball of radius r (mm) at a point on the print. */
export interface Dab { obj?: string; x: number; y: number; z: number; r: number }

export type Pick =
  | { kind: 'layers'; z0: number; z1: number; obj?: string }
  | { kind: 'lines'; lines: LinePick[] }
  | { kind: 'brush'; dabs: Dab[] };

export type PickKind = Pick['kind'];

/**
 * Exactly which lines a rule changes, by the numbers a person thinks in. Ranges are 1-based and inclusive
 * (inner wall 1 = next to the outer wall, top layer 1 = the top surface); hi 99 = all of them. null = none.
 * shape limits wall lines to their curved or their straight stretches.
 */
export interface RuleTargets {
  outer: boolean;
  inner: [number, number] | null;
  infill: boolean;
  top: [number, number] | null;
  bottom: [number, number] | null;
  solid: boolean;
  support: boolean;
  shape: 'any' | 'curved' | 'straight';
}
export const ALL_TARGETS: RuleTargets = { outer: true, inner: [1, 99], infill: true, top: [1, 99], bottom: [1, 99], solid: true, support: true, shape: 'any' };

/** The coarse line groups a set of targets touches (what the slicer filters on before measuring). */
export function groupsOfTargets(t: RuleTargets): LineGroup[] {
  const g: LineGroup[] = [];
  if (t.outer) g.push('outer');
  if (t.inner) g.push('inner');
  if (t.infill) g.push('infill');
  if (t.top || t.bottom || t.solid) g.push('solid');
  if (t.support) g.push('support');
  return g;
}

/** Do the targets take this line? cls: the line class name from select/classes.ts. */
export function targetOk(t: RuleTargets, cls: string, rank: number, curved: boolean): boolean {
  const inR = (r: [number, number] | null) => !!r && rank >= r[0] && rank <= r[1];
  let ok: boolean;
  switch (cls) {
    case 'outer': ok = t.outer; break;
    case 'inner': ok = inR(t.inner); break;
    case 'infill': ok = t.infill; break;
    case 'top': ok = inR(t.top); break;
    case 'bottom': ok = inR(t.bottom); break;
    case 'solid': ok = t.solid; break;
    case 'support': ok = t.support; break;
    default: return true;
  }
  if (ok && t.shape !== 'any' && (cls === 'outer' || cls === 'inner')) ok = (t.shape === 'curved') === curved;
  return ok;
}

/** Targets that need lines measured (anything finer than whole line kinds). */
export const needsClasses = (r: SelectRule) => !!r.targets;

export interface RuleApply {
  /** Filament slot (0-based) to print the selection with. */
  filament?: number;
  /** A Motionex motion on the selected walls; scale 1 = as designed. */
  motion?: RuleMotion;
  /** Speed and flow in % of normal (100 = unchanged). */
  speed?: number;
  flow?: number;
  /** Nozzle temperature (°C) on the layers the selection touches. */
  temp?: number;
}

/** A motion and this rule's own tuning of it (the Top view and Side view tabs); unset fields keep the motion's own. */
export interface RuleMotion {
  brush_id: string;
  scale: number;
  /** Top view: how far the line moves in and out (mm) and the length of one repeat (mm). */
  amp?: number;
  period?: number;
  /** Side view: how the pattern changes from layer to layer; null = the same on every layer. */
  layers?: import('../model').LayerEffect | null;
  /** Side view: up-and-down movement along the line (mm); 0 = flat. */
  z?: number;
}

/** The motion with the rule's own tuning. */
export function tunedBrush(m: RuleMotion, b: import('../model').MotionBrush): import('../model').MotionBrush {
  if (m.amp === undefined && m.period === undefined && m.layers === undefined && m.z === undefined) return b;
  const out = { ...b };
  if (m.amp !== undefined) out.amplitude = Math.max(0, m.amp);
  if (m.period !== undefined) out.period_mm = Math.max(0.2, m.period);
  if (m.layers !== undefined) out.layers = m.layers;
  if (m.z !== undefined) {
    out.z_amplitude = Math.max(0, m.z);
    // a flat motion has no up-and-down curve: give it one that follows the side-to-side shape
    if (m.z > 0 && b.curves.z_offset.points.every((p) => Math.abs(p.v) < 1e-6)) out.curves = { ...b.curves, z_offset: b.curves.lateral_offset };
  }
  return out;
}

export interface Spread { above: number; below: number; fade: 'gradual' | 'sudden' }

export interface SelectRule {
  id: string;
  name: string;
  enabled: boolean;
  pick: Pick;
  /** Line kinds the rule changes (empty = all). With targets, kept in step with them. */
  lines: LineGroup[];
  /** Finer choice of lines (wall numbers, top / bottom layer numbers, curved or straight); unset = by `lines`. */
  targets?: RuleTargets;
  apply: RuleApply;
  /**
   * Picked lines and brush dabs: how many layers above and below they reach, and whether the change fades out
   * over them (gradual) or stays full strength to the last one (sudden). Unset (older rules) = fade over blend_mm.
   */
  spread?: Spread;
  /** Soft edge (mm): speed, flow and motion fade out over this distance around the selection. */
  blend_mm: number;
  /** Where each object was (bounding box min x, y in plate mm) when the selection was made. */
  anchors: Record<string, [number, number]>;
}

let seq = 0;
export function newRule(n: number): SelectRule {
  return {
    id: `r${Date.now().toString(36)}${(seq++).toString(36)}`, name: `Selection ${n}`, enabled: true,
    pick: { kind: 'layers', z0: 0, z1: 0 }, lines: [], apply: {}, blend_mm: 2, anchors: {}, spread: { above: 0, below: 0, fade: 'gradual' },
  };
}

export const pickEmpty = (p: Pick) => (p.kind === 'layers' ? p.z1 <= 0 && p.z0 <= 0 : p.kind === 'lines' ? !p.lines.length : !p.dabs.length);

/** Does the rule change anything? */
export const applies = (a: RuleApply) => a.filament !== undefined || !!a.motion || (a.speed !== undefined && a.speed !== 100) || (a.flow !== undefined && a.flow !== 100) || a.temp !== undefined;

export const ruleActive = (r: SelectRule) => r.enabled && !pickEmpty(r.pick) && applies(r.apply);

/** Saved rules, cleaned of anything malformed. */
export function loadRules(d: unknown): SelectRule[] {
  if (!Array.isArray(d)) return [];
  return d.filter((r) => r && typeof r === 'object' && r.pick && typeof r.pick.kind === 'string').map((r) => ({
    ...newRule(0), ...r, spread: r.spread ? { above: Math.max(0, r.spread.above | 0), below: Math.max(0, r.spread.below | 0), fade: r.spread.fade === 'sudden' ? 'sudden' : 'gradual' } : undefined, lines: Array.isArray(r.lines) ? r.lines : [], apply: { ...(r.apply ?? {}) }, anchors: { ...(r.anchors ?? {}) },
  }));
}

export function describePick(p: Pick): string {
  if (p.kind === 'layers') return pickEmpty(p) ? 'No layers chosen' : `Heights ${p.z0.toFixed(2)}–${p.z1.toFixed(2)} mm`;
  if (p.kind === 'lines') { const seg = p.lines.filter((l) => l.pts.length === 2).length, n = p.lines.length - seg; return [n ? `${n} line${n === 1 ? '' : 's'}` : '', seg ? `${seg} segment${seg === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ') || '0 lines'; }
  return `${p.dabs.length} brush dab${p.dabs.length === 1 ? '' : 's'}`;
}

/**
 * While the Select window is open its motions are drawn by the window itself, straight from the geometry
 * (select/draft.ts), so the slicer leaves rule motions out; the exact path is made when the window closes.
 */
export const draftMode = { on: false };
