// Clickex planning: from artwork (or a block layout) to the outlines and switch positions that the 3D build
// uses. This is where "any design" becomes a clicker: the body outline, where the switch sits, whether
// the switch fits, and what to grow when it does not.
import { difference, union } from '../../engine/clipper';
import type { Paths } from '../../engine/types';
import { artBounds, artPaths, placeArt, type Art } from './art';
import { baseShapePaths, switchById, type SwitchSpec } from './catalog';
import { boundsMm, circlePath, components, convexHull, fillHoles, grow, pointDist, pole, rectPath, shrink, simplify, smooth, squareFits, toRings, transformPaths, translatePaths } from './geom';
import type { ClickexSpec } from './model';
import { keyTokens, symbolById } from './symbols';
import { layoutText, type TextSpec } from '../patternex/tools/text';
import type opentype from 'opentype.js';

export interface Unit {
  id: string;
  /** Switch centre and turn. */
  cx: number; cy: number; angle: number;
  /** Button outline. */
  cap: Paths;
  /** Artwork on this button, in plate coordinates. */
  art: Art;
  label?: string;
}

export interface Plan {
  base: Paths;
  loop: Paths;
  units: Unit[];
  /** All artwork as placed (for the preview of colours). */
  art: Art;
  warnings: string[];
  fits: boolean;
  /** Smallest base size (mm, longer side) that hosts the switch, when the current one does not. */
  minSize: number | null;
  /** The base was enlarged (shape) or padded (outline) to host the switch. */
  grown: string | null;
  size: [number, number];
}

/** Switch spec with the user's two height overrides applied. */
export function effectiveSwitch(spec: ClickexSpec): SwitchSpec {
  const s = switchById(spec.sw.id);
  return { ...s, housingTop: spec.sw.housingTop, stemTop: spec.sw.stemTop, cutout: s.cutout, plate: spec.body.plate };
}

/** Distance from a button's outer wall to the rim's outer wall. */
export const rimInset = (spec: ClickexSpec) => spec.body.wall + spec.fit.capClear;
/** Square the switch's top housing needs above the plate. */
export const pocketSize = (spec: ClickexSpec) => effectiveSwitch(spec).flange + spec.fit.pocketTol;

export interface SwitchPos { x: number; y: number; angle: number; fits: boolean }

/** Where the switch goes in a region: deepest point, first turn that fits; manual placement when asked. */
export function findSwitchIn(spec: ClickexSpec, region: Paths, need: number): SwitchPos {
  const b = boundsMm(region);
  if (!spec.sw.auto) {
    const x = b.cx + spec.sw.dx, y = b.cy + spec.sw.dy;
    return { x, y, angle: spec.sw.angle, fits: squareFits(region, x, y, need, spec.sw.angle) };
  }
  if (!region.length) return { x: b.cx, y: b.cy, angle: 0, fits: false };
  const p = pole(region, 0.15);
  const angles = [0, 45, 15, 30, 60, 75];
  for (const a of angles) if (squareFits(region, p.x, p.y, need, a)) return { x: p.x, y: p.y, angle: a, fits: true };
  const reach = Math.max(2, p.d);
  for (let r = 0.5; r <= reach; r += 0.5) {
    const n = Math.max(8, Math.round(r * 8));
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2, x = p.x + r * Math.cos(t), y = p.y + r * Math.sin(t);
      for (const a of [0, 45]) if (squareFits(region, x, y, need, a)) return { x, y, angle: a, fits: true };
    }
  }
  return { x: p.x, y: p.y, angle: 0, fits: false };
}

/** Switch position for a button outline (the rim sits `rimInset` inside it). */
export const findSwitch = (spec: ClickexSpec, cap: Paths): SwitchPos => findSwitchIn(spec, shrink(cap, rimInset(spec)), pocketSize(spec));

// ---------------------------------------------------------------- single clicker
/** The outline around artwork: gaps bridged, holes filled, a border added, corners rounded. */
export function silhouette(paths: Paths, spec: ClickexSpec, bridgeBoost = 1): Paths {
  const { bridge, border, fillHoles: fh } = spec.shape;
  let s = union(paths);
  const r = Math.max(0.01, bridge * bridgeBoost);
  s = shrink(grow(s, r), r);
  s = fillHoles(s, fh ? Infinity : 3);
  return simplify(smooth(grow(s, border), spec.body.baseRound), 0.03);
}

function outlineFromArt(spec: ClickexSpec, art: Art, size: number): { base: Paths; placed: Art } {
  const border = spec.shape.border;
  const b0 = artBounds(art);
  let k = Math.max(0.01, (size - 2 * border) / Math.max(1e-6, Math.max(b0.w, b0.h)));
  let placed: Art = art, base: Paths = [];
  for (let pass = 0; pass < 2; pass++) {
    placed = placeArt(art, { scale: k, angle: spec.shape.rot, dx: 0, dy: 0, flip: spec.shape.flip });
    base = silhouette(artPaths(placed), spec);
    // separate pieces cannot be one body: bridge wider gaps, then fall back to the hull
    if (components(base).length > 1) {
      for (const boost of [2, 3, 5, 8]) { base = silhouette(artPaths(placed), spec, boost); if (components(base).length === 1) break; }
      if (components(base).length > 1) base = smooth(grow(convexHull(artPaths(placed)), border), spec.body.baseRound);
    }
    const bb = boundsMm(base);
    k *= size / Math.max(1e-6, Math.max(bb.w, bb.h));
  }
  placed = placeArt(art, { scale: k, angle: spec.shape.rot, dx: 0, dy: 0, flip: spec.shape.flip });
  base = silhouette(artPaths(placed), spec);
  if (components(base).length > 1) {
    for (const boost of [2, 3, 5, 8]) { base = silhouette(artPaths(placed), spec, boost); if (components(base).length === 1) break; }
    if (components(base).length > 1) base = smooth(grow(convexHull(artPaths(placed)), border), spec.body.baseRound);
  }
  return { base, placed };
}

function shapeFromArt(spec: ClickexSpec, art: Art, size: number): { base: Paths; placed: Art } {
  const base = baseShapePaths(spec.shape.baseShape, size, spec.body.baseRound);
  const b = artBounds(art);
  const scale = art.length ? ((size * 0.78 * spec.shape.designSize) / 100) / Math.max(1e-6, Math.max(b.w, b.h)) : 1;
  return { base, placed: placeArt(art, { scale, angle: spec.shape.rot, dx: spec.shape.dx, dy: spec.shape.dy, flip: spec.shape.flip }) };
}

/** Attach a keychain loop at an angle around the body. */
export function keychainLoop(spec: ClickexSpec, base: Paths): Paths {
  const k = spec.keychain;
  if (!k.enabled || !base.length) return [];
  const b = boundsMm(base);
  const rings = toRings(base);
  const a = (k.angle * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
  // walk out from the centre until the ray leaves the body
  let t = 0;
  const step = 0.25, max = Math.max(b.w, b.h);
  for (let s = 0; s <= max; s += step) { if (pointDist(rings, b.cx + dx * s, b.cy + dy * s) > 0) t = s; }
  const R = k.outerD / 2, rh = k.holeD / 2;
  const reach = Math.max(R - 2, rh + 1) + k.reach;
  const cx = b.cx + dx * (t + reach), cy = b.cy + dy * (t + reach);
  return difference([circlePath(cx, cy, R, 48)], [circlePath(cx, cy, rh, 40)]);
}

export function planSingle(spec: ClickexSpec, art: Art): Plan {
  const warnings: string[] = [];
  const outlineOk = spec.source !== 'icon';
  const style = spec.shape.baseStyle === 'outline' && outlineOk && art.length ? 'outline' : 'shape';
  let size = spec.shape.size;
  let grown: string | null = null;
  let made = style === 'outline' ? outlineFromArt(spec, art, size) : shapeFromArt(spec, art, size);
  let pos = findSwitch(spec, made.base);

  if (!pos.fits && !spec.shape.lockBase) {
    if (style === 'shape') {
      // grow the shape until the switch fits
      let s = size;
      for (let i = 0; i < 80 && !pos.fits; i++) {
        s += 1;
        made = shapeFromArt(spec, art, s);
        pos = findSwitch(spec, made.base);
      }
      if (pos.fits) { grown = `Base grown from ${size} to ${s} mm so the switch fits.`; size = s; }
    } else {
      // outline: pad the body around the switch location
      for (let i = 0; i < 5 && !pos.fits; i++) {
        const region = shrink(made.base, rimInset(spec));
        const p = region.length ? pole(region, 0.15) : { x: boundsMm(made.base).cx, y: boundsMm(made.base).cy };
        const need = pocketSize(spec);
        made = { ...made, base: smooth(union(made.base, [circlePath(p.x, p.y, (need * Math.SQRT2) / 2 + rimInset(spec) + 0.3, 72)]), spec.body.baseRound) };
        pos = findSwitch(spec, made.base);
        grown = 'The outline is too narrow for the switch, so a round pad was added around it.';
      }
    }
  }

  let minSize: number | null = null;
  if (!pos.fits) {
    // report the smallest size that would work
    let s = size;
    for (let i = 0; i < 60 && s < 200; i++) {
      s += 1;
      const m = style === 'outline' ? outlineFromArt(spec, art, s) : shapeFromArt(spec, art, s);
      if (findSwitch(spec, m.base).fits) { minSize = s; break; }
    }
    warnings.push(minSize
      ? `The switch does not fit at ${size} mm. Make the base at least ${minSize} mm, or turn off Lock the base size.`
      : 'The switch does not fit this design. Pick a bolder shape, use Shape style, or raise the size.');
  }
  if (grown) warnings.push(grown);

  const loop = keychainLoop(spec, made.base);
  const bb = boundsMm(union(made.base, loop));
  const unit: Unit = { id: 'u0', cx: pos.x, cy: pos.y, angle: pos.angle, cap: made.base, art: made.placed };
  return { base: made.base, loop, units: [unit], art: made.placed, warnings, fits: pos.fits, minSize, grown, size: [bb.w, bb.h] };
}

// ---------------------------------------------------------------- blocks
interface Key { r: number; c: number; token: string }

export function blockKeys(spec: ClickexSpec): { keys: Key[]; rows: number; cols: number } {
  const bl = spec.blocks;
  const toks = keyTokens(bl.text.replace(/\n/g, ' '));
  const lines = bl.text.split('\n');
  switch (bl.layout) {
    case 'row': return { keys: keyTokens(lines[0] ?? '').map((token, c) => ({ r: 0, c, token })), rows: 1, cols: Math.max(1, keyTokens(lines[0] ?? '').length) };
    case 'column': { const t = keyTokens(lines.join('')); return { keys: t.map((token, r) => ({ r, c: 0, token })), rows: Math.max(1, t.length), cols: 1 }; }
    case 'grid': {
      const cols = Math.max(1, bl.cols);
      const t = lines.length > 1 ? lines.map((l) => keyTokens(l)) : (() => { const all = keyTokens(lines[0] ?? ''); const rows: string[][] = []; for (let i = 0; i < all.length; i += cols) rows.push(all.slice(i, i + cols)); return rows; })();
      const keys: Key[] = [];
      t.forEach((row, r) => row.forEach((token, c) => keys.push({ r, c, token })));
      return { keys, rows: Math.max(1, t.length), cols: Math.max(cols, ...t.map((x) => x.length)) };
    }
    case 'wasd': return { keys: [{ r: 0, c: 1, token: 'W' }, { r: 1, c: 0, token: 'A' }, { r: 1, c: 1, token: 'S' }, { r: 1, c: 2, token: 'D' }], rows: 2, cols: 3 };
    case 'arrows': return { keys: [{ r: 0, c: 1, token: '{up}' }, { r: 1, c: 0, token: '{left}' }, { r: 1, c: 1, token: '{down}' }, { r: 1, c: 2, token: '{right}' }], rows: 2, cols: 3 };
    case 'custom': {
      const keys: Key[] = [];
      let n = 0;
      for (let r = 0; r < bl.rows; r++) for (let c = 0; c < bl.cols; c++) if (bl.cells[r * bl.cols + c]) keys.push({ r, c, token: toks[n++] ?? ' ' });
      return { keys, rows: bl.rows, cols: bl.cols };
    }
  }
}

/** Glyph paths for a key token, centred on the origin, `size` mm tall. */
function glyph(token: string, spec: ClickexSpec, font: opentype.Font | undefined): Paths {
  const size = spec.blocks.letterSize;
  if (token.length > 1 && token.startsWith('{')) {
    const s = symbolById(token.slice(1, -1));
    return s ? transformPaths(s.make(), size, 0, 0, 0) : [];
  }
  if (!font || token.trim() === '') return [];
  const ts: TextSpec = { text: token, font: spec.blocks.font, size_mm: size, tracking: 0, kerning: false, line_height: 1.2, align: 'center', arc_radius_mm: 0, weight_mm: 0, color: spec.colors.ink };
  const lay = layoutText(font, ts);
  const paths = union(lay.rings.map((r) => r.map(([x, y]) => ({ X: Math.round(x * 1e4), Y: Math.round(y * 1e4) }))));
  const b = boundsMm(paths);
  return translatePaths(paths, -b.cx, -b.cy);
}

export function planBlocks(spec: ClickexSpec, font: opentype.Font | undefined): Plan {
  const bl = spec.blocks, warnings: string[] = [];
  const { keys, rows, cols } = blockKeys(spec);
  const need = pocketSize(spec) + 2 * (rimInset(spec) + spec.body.rimWall);
  const gap = bl.borders ? bl.borderW : 0.3;
  let pitch = bl.pitch;
  const minPitch = need + 2 * gap;
  if (pitch < minPitch) { warnings.push(`Key pitch raised from ${pitch} to ${+minPitch.toFixed(1)} mm so the switch fits.`); pitch = minPitch; }
  if (!keys.length) return { base: [], loop: [], units: [], art: [], warnings: ['Type some text for the keys.'], fits: false, minSize: null, grown: null, size: [0, 0] };
  const ink = spec.colors.ink;
  const units: Unit[] = keys.map((k, i) => {
    const cx = (k.c - (cols - 1) / 2) * pitch, cy = -(k.r - (rows - 1) / 2) * pitch;
    const cap = smooth([rectPath(cx, cy, pitch - 2 * gap, pitch - 2 * gap)], spec.body.baseRound);
    const g = glyph(k.token, spec, font);
    const art: Art = g.length ? [{ color: ink, paths: translatePaths(g, cx, cy) }] : [];
    return { id: `u${i}`, cx, cy, angle: 0, cap, art, label: k.token };
  });
  const cells = keys.map((k) => rectPath((k.c - (cols - 1) / 2) * pitch, -(k.r - (rows - 1) / 2) * pitch, pitch, pitch));
  const base = smooth(union(cells), spec.body.baseRound);
  const loop = keychainLoop(spec, base);
  const bb = boundsMm(union(base, loop));
  return { base, loop, units, art: units.flatMap((u) => u.art), warnings, fits: true, minSize: null, grown: null, size: [bb.w, bb.h] };
}

