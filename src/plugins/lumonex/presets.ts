// Lumonex presets: the 72 designs of the Lumonex 2026 catalogue (rebuilt parametrically from their
// family, silhouette, pattern and materials), studio forms in the style of popular printed lamps
// (twisted vase shades, fin stacks, ribbons, minis) and starters for every lamp type.
import type { MaterialKind } from './catalog';
import { defaultJoint } from './joinery';
import { defaultDesign, section, type LampDesign, type LampKind } from './model';
import { defaultShape, pattern, SILHOUETTES, type PatternLayer, type ShapeSpec } from './shape';

export type Family = 'Fluted columns' | 'Pleats & cones' | 'Glow orbs' | 'Mushrooms & blooms' | 'Stacks & accordions' | 'Lattice & pattern' | 'Pendants';

interface Catalogue { code: string; name: string; family: Family; type: 'Table' | 'Pendant'; shade: [MaterialKind, string]; base?: [MaterialKind, string]; heights: [number, number, number, number] }

const M = (m: string): MaterialKind => (m === 'PETG' ? 'PETG Translucent' : m === 'Matte' ? 'PLA Matte' : m === 'Plus' ? 'PLA+' : m === 'Stone' ? 'PLA Stone' : m === 'Wood' ? 'PLA Wood' : 'PLA Silk');
const c = (code: string, name: string, family: Family, type: 'Table' | 'Pendant', sm: string, sc: string, bm: string | null, bc: string | null, h: [number, number, number, number]): Catalogue =>
  ({ code, name, family, type, shade: [M(sm), sc], base: bm ? [M(bm), bc!] : undefined, heights: h });

const FC: Family = 'Fluted columns', PC: Family = 'Pleats & cones', GO: Family = 'Glow orbs', MB: Family = 'Mushrooms & blooms', SA: Family = 'Stacks & accordions', LP: Family = 'Lattice & pattern', PD: Family = 'Pendants';
const T = 'Table' as const, P = 'Pendant' as const;
const H = (m: number): [number, number, number, number] => [Math.round(m * 0.75), m, Math.round(m * 1.25), Math.round(m * 1.5)];

export const CATALOGUE: Catalogue[] = [
  c('LX-01', 'Pagoda', PC, T, 'Matte', 'Beige', 'Matte', 'Beige', H(240)),
  c('LX-02', 'Colonna', FC, T, 'Plus', 'Terracotta Orange', 'Plus', 'Terracotta Orange', [180, 240, 300, 360]),
  c('LX-03', 'Totem Trio', SA, T, 'PETG', 'Orange', 'Wood', 'Natural', H(260)),
  c('LX-04', 'Doric', FC, T, 'Matte', 'Navy Blue', 'Matte', 'Navy Blue', [165, 220, 275, 330]),
  c('LX-05', 'Lantern Cube', SA, T, 'PETG', 'Yellow', 'Matte', 'Beige', H(220)),
  c('LX-06', 'Bulb Verde', GO, T, 'PETG', 'Green', 'Stone', 'White', H(230)),
  c('LX-07', 'Flare', FC, T, 'Plus', 'Outrageous Orange', 'Plus', 'Apricot', [190, 250, 310, 375]),
  c('LX-08', 'Lumen', GO, T, 'PETG', 'Arctic', 'Matte', 'Black', H(230)),
  c('LX-09', 'Totem Mist', SA, T, 'PETG', 'Arctic', 'Matte', 'Moon Gray', H(260)),
  c('LX-10', 'Gear', PD, P, 'Plus', 'Outrageous Orange', null, null, H(220)),
  c('LX-11', 'Cog', FC, T, 'Plus', 'Terracotta Orange', 'Plus', 'Terracotta Orange', [220, 295, 370, 440]),
  c('LX-12', 'Vortex Azure', GO, T, 'PETG', 'Ice Blue', 'Stone', 'White', H(240)),
  c('LX-13', 'Luna', PD, P, 'Matte', 'White', null, null, [205, 275, 345, 410]),
  c('LX-14', 'Halo Silver', PC, T, 'Silk', 'Silk Silver', 'Matte', 'White', H(240)),
  c('LX-15', 'Vortex Ember', GO, T, 'PETG', 'Orange', 'Matte', 'Black', H(240)),
  c('LX-16', 'Bloom Blue', PC, T, 'Matte', 'Ice Blue', 'Matte', 'Navy Blue', H(240)),
  c('LX-17', 'Origa', PD, P, 'Plus', 'Terracotta Orange', null, null, [160, 210, 260, 315]),
  c('LX-18', 'Kirie Amber', PC, T, 'PETG', 'Orange', 'Matte', 'Beige', H(240)),
  c('LX-19', 'Plissé Rosa', PC, T, 'Matte', 'Sakura Pink', 'Matte', 'Sakura Pink', H(240)),
  c('LX-20', 'Ribb Aqua', GO, T, 'PETG', 'Ice Blue', 'Matte', 'Black', H(230)),
  c('LX-21', 'Flute Sand', FC, T, 'Matte', 'Skin', 'Wood', 'Natural', [270, 360, 450, 540]),
  c('LX-22', 'Moss', MB, T, 'Plus', 'Army Green', 'Plus', 'Army Green', [195, 260, 325, 390]),
  c('LX-23', 'Rhombo', LP, T, 'PETG', 'Arctic', 'Stone', 'White', [235, 315, 395, 470]),
  c('LX-24', 'Prism Azure', PC, T, 'PETG', 'Blue', 'Matte', 'Moon Gray', H(240)),
  c('LX-25', 'Origa Table', PC, T, 'Plus', 'Terracotta Orange', 'Plus', 'Terracotta Orange', H(240)),
  c('LX-26', 'Bell Noir', PC, T, 'Silk', 'Silk Antique Gold', 'Matte', 'Black', H(240)),
  c('LX-27', 'Lilac Column', FC, T, 'Matte', 'Lilac Purple', 'Matte', 'Lilac Purple', H(240)),
  c('LX-28', 'Spool', FC, T, 'Plus', 'Rust Copper', 'Plus', 'Rust Copper', H(240)),
  c('LX-29', 'Crown Silver', FC, T, 'PETG', 'Arctic', 'Silk', 'Silk Silver', H(240)),
  c('LX-30', 'Corolla', FC, T, 'PETG', 'Yellow', 'PETG', 'Yellow', H(240)),
  c('LX-31', 'Colonna Pendant', PD, P, 'Plus', 'Teal Blue', null, null, H(240)),
  c('LX-32', 'Fungi Sage', MB, T, 'Matte', 'Mint Green', 'Matte', 'Mint Green', [185, 245, 305, 370]),
  c('LX-33', 'Dome Sol', PD, P, 'Matte', 'Sunshine Yellow', null, null, H(200)),
  c('LX-34', 'Cobalt Tube', FC, T, 'PETG', 'Blue', 'Matte', 'Moon Gray', H(240)),
  c('LX-35', 'Obsidian', FC, T, 'Matte', 'Black', 'Silk', 'Silk Antique Gold', H(240)),
  c('LX-36', 'Corona', PD, P, 'Matte', 'Ruby Red', null, null, H(220)),
  c('LX-37', 'Morel', MB, T, 'PETG', 'Orange', 'Matte', 'Beige', [200, 270, 340, 405]),
  c('LX-38', 'Fungi Terra', MB, T, 'Plus', 'Terracotta Orange', 'Plus', 'Terracotta Orange', [170, 230, 290, 345]),
  c('LX-39', 'Kirie Mist', PC, T, 'PETG', 'Arctic', 'Matte', 'Moon Gray', H(240)),
  c('LX-40', 'Parasol', PC, T, 'Matte', 'Beige', 'Wood', 'Natural', H(240)),
  c('LX-41', 'Coral Orb', GO, T, 'PETG', 'Red', 'Stone', 'White', H(230)),
  c('LX-42', 'Ice Orb', GO, T, 'PETG', 'Ice Blue', 'Stone', 'White', H(230)),
  c('LX-43', 'Facet', PC, T, 'Silk', 'Silk Silver', 'PETG', 'Orange', H(240)),
  c('LX-44', 'Chalice', FC, T, 'Matte', 'Navy Blue', 'Matte', 'Navy Blue', H(240)),
  c('LX-45', 'Luna Terra', PD, P, 'Plus', 'Terracotta Orange', null, null, [185, 245, 305, 370]),
  c('LX-46', 'Cobalt Orb', GO, T, 'PETG', 'Blue', 'Matte', 'Moon Gray', H(230)),
  c('LX-47', 'Hourglass', FC, T, 'Wood', 'Natural', 'Wood', 'Natural', H(240)),
  c('LX-48', 'Accordion', SA, T, 'PETG', 'Green', 'Matte', 'Moon Gray', H(240)),
  c('LX-49', 'Accordion Amber', SA, T, 'PETG', 'Yellow', 'Matte', 'Beige', H(240)),
  c('LX-50', 'Strata', PD, P, 'Plus', 'Teal Blue', null, null, H(220)),
  c('LX-51', 'Ripple Coral', GO, T, 'PETG', 'Red', 'Matte', 'Black', H(230)),
  c('LX-52', 'Cascade', SA, T, 'Plus', 'Rust Copper', 'Plus', 'Rust Copper', H(240)),
  c('LX-53', 'Gourd Silver', MB, T, 'Silk', 'Silk Silver', 'Plus', 'Outrageous Orange', [180, 240, 300, 360]),
  c('LX-54', 'Bloom Azure', GO, T, 'PETG', 'Blue', 'Matte', 'Moon Gray', H(230)),
  c('LX-55', 'Rhombo Amber', LP, T, 'PETG', 'Orange', 'Plus', 'Terracotta Orange', [165, 220, 275, 330]),
  c('LX-56', 'Lattice', LP, T, 'PETG', 'Arctic', 'Stone', 'White', [180, 240, 300, 360]),
  c('LX-57', 'Strata Cube', SA, T, 'PETG', 'Orange', 'Matte', 'White', H(220)),
  c('LX-58', 'Chevron', PD, P, 'Matte', 'Beige', null, null, [200, 270, 340, 405]),
  c('LX-59', 'Saucer', PC, T, 'PETG', 'Orange', 'Matte', 'White', H(220)),
  c('LX-60', 'Plisse', PD, P, 'Plus', 'Teal Blue', null, null, H(220)),
  c('LX-61', 'Helix Lime', GO, T, 'PETG', 'Green', 'Matte', 'Black', H(230)),
  c('LX-62', 'Quill Noir', SA, T, 'Matte', 'Black', 'Matte', 'Black', H(240)),
  c('LX-63', 'Helix Amber', GO, T, 'PETG', 'Orange', 'Matte', 'Black', H(230)),
  c('LX-64', 'Bell', PD, P, 'Plus', 'Apricot', null, null, H(220)),
  c('LX-65', 'Morel Mint', MB, T, 'Matte', 'Mint Green', 'Matte', 'Mint Green', [220, 295, 370, 440]),
  c('LX-66', 'Kite', PC, T, 'Matte', 'Ruby Red', 'Matte', 'White', H(240)),
  c('LX-67', 'Facet Noir', PD, P, 'Matte', 'Black', null, null, H(220)),
  c('LX-68', 'Frost Tube', LP, T, 'PETG', 'Arctic', 'Matte', 'White', [165, 220, 275, 330]),
  c('LX-69', 'Scala', PD, P, 'Plus', 'Terracotta Orange', null, null, [245, 325, 405, 480]),
  c('LX-70', 'Amphora', LP, T, 'PETG', 'Yellow', 'Wood', 'Natural', [170, 230, 290, 345]),
  c('LX-71', 'Dome Lime', PD, P, 'Plus', 'Grass Green', null, null, H(200)),
  c('LX-72', 'Spira', PD, P, 'Wood', 'Natural', null, null, [165, 220, 275, 330]),
];

const sil = (id: string) => (SILHOUETTES.find((s) => s.id === id) ?? SILHOUETTES[0]).handles.slice();

// ---------------------------------------------------------------- per-design recipes (from the catalogue photos)
/** One part of a recipe: silhouette id or 7 handles, height and diameter as fractions of the lamp height. */
interface P { s: string | number[]; h: number; d: number; sec?: ShapeSpec['section']; sides?: number; sd?: number; round?: number; pat?: PatternLayer[]; twist?: number }
interface Recipe { base: P[]; shade: P; gallery: number; legs?: number }

const F = (count: number, depth: number, sharpness = 1.5) => pattern('flutes', { count, depth, sharpness });
const PL = (count: number, depth: number) => pattern('pleats', { count, depth });
const FIN = (count: number, depth: number, sharpness = 3) => pattern('cog', { count, depth, sharpness });
const HX = (count: number, depth: number, twist = 0.3) => pattern('helix', { count, rows: 1, depth, twist, sharpness: 1.6 });
const NZ = () => pattern('noise', { count: 30, rows: 8, depth: 0.4 });
const p = (s: string | number[], h: number, d: number, x: Partial<P> = {}): P => ({ s, h, d, ...x });
const SQ = { sec: 'polygon' as const, sides: 4, round: 0.12 };
const CONE: number[] = [1, 0.9, 0.8, 0.72, 0.65, 0.6, 0.56];

const RECIPES: Record<string, Recipe> = {
  // 01 Fluted columns
  'LX-02': { base: [p('cylinder', 0.04, 0.3), p('cylinder', 0.52, 0.38, { pat: [F(32, 2.2)] })], shade: p('drum', 0.4, 0.62, { pat: [F(56, 2.4)] }), gallery: 0.3 },
  'LX-04': { base: [p('cylinder', 0.45, 0.45, { pat: [F(44, 1.8, 2)] })], shade: p('drum', 0.42, 0.72, { pat: [F(76, 2, 2)] }), gallery: 0.1 },
  'LX-21': { base: [p(CONE, 0.32, 0.42, { pat: [NZ()] })], shade: p('cylinder', 0.55, 0.4, { pat: [F(64, 1.2, 2)] }), gallery: 0.05 },
  'LX-07': { base: [p('cylinder', 0.03, 0.56), p(CONE, 0.45, 0.45, { pat: [NZ()] })], shade: p('drum', 0.35, 0.78, { pat: [FIN(26, 8, 1.5), NZ()] }), gallery: 0.08 },
  'LX-11': { base: [p([1, 0.86, 0.74, 0.64, 0.56, 0.5, 0.46], 0.45, 0.5, { pat: [NZ()] })], shade: p('drum', 0.3, 0.78, { pat: [FIN(22, 12, 1.4)] }), gallery: 0.1 },
  'LX-28': { base: [p('cylinder', 0.22, 0.9, { pat: [FIN(40, 12, 3)] }), p('cylinder', 0.12, 0.5)], shade: p('cylinder', 0.55, 0.9, { pat: [FIN(40, 14, 3)] }), gallery: 0.05 },
  'LX-30': { base: [p('cylinder', 0.4, 0.4, { pat: [FIN(36, 6, 3)] })], shade: p('cylinder', 0.38, 0.78, { pat: [FIN(56, 10, 3)] }), gallery: 0.1 },
  'LX-44': { base: [p([1, 0.8, 0.66, 0.58, 0.54, 0.52, 0.5], 0.45, 0.55, { pat: [FIN(20, 8, 2.5)] })], shade: p('cylinder', 0.4, 0.62, { pat: [FIN(16, 10, 2.5)] }), gallery: 0.1 },
  'LX-47': { base: [p('barrel', 0.38, 0.55, { pat: [F(60, 2)] }), p('cylinder', 0.08, 0.3)], shade: p('barrel', 0.45, 0.62, { pat: [F(64, 2)] }), gallery: 0.03 },
  'LX-27': { base: [p([0.95, 1, 1, 1, 0.95, 0.75, 0.45], 0.6, 0.38, { pat: [F(40, 2.4)] })], shade: p('empire', 0.3, 0.7, { pat: [NZ()] }), gallery: 0.05 },
  'LX-35': { base: [p('cylinder', 0.3, 0.55, { pat: [FIN(32, 10, 3)] }), p('cylinder', 0.06, 0.3)], shade: p('cylinder', 0.6, 0.55, { pat: [NZ()] }), gallery: 0.03 },
  'LX-34': { base: [p('cylinder', 0.06, 0.26), p('cylinder', 0.35, 0.3, { pat: [FIN(16, 2, 2)] })], shade: p('cylinder', 0.45, 0.4, { pat: [F(48, 0.8)] }), gallery: 0.04 },
  'LX-29': { base: [p('cylinder', 0.45, 0.3, { pat: [F(24, 1.5)] })], shade: p('drum', 0.38, 0.7, { pat: [pattern('cog', { count: 20, depth: 6, sharpness: 1.2 })] }), gallery: 0.2 },
  // 02 Pleats & cones
  'LX-01': { base: [p('cylinder', 0.45, 0.32, { pat: [pattern('accordion', { rows: 6, depth: 10, sharpness: 1 })] })], shade: p([1, 0.8, 0.6, 0.4, 0.22, 0.18, 0.32], 0.38, 1, { pat: [NZ()] }), gallery: 0.12 },
  'LX-25': { base: [p([0.35, 0.7, 1, 0.85, 0.6, 0.4, 0.3], 0.5, 0.45, { pat: [PL(32, 3)] })], shade: p('empire', 0.35, 0.78, { pat: [PL(40, 5)] }), gallery: 0.08 },
  'LX-40': { base: [p([1, 0.96, 0.92, 0.88, 0.84, 0.8, 0.76], 0.5, 0.3, { pat: [NZ()] })], shade: p([1, 0.75, 0.5, 0.3, 0.15, 0.13, 0.14], 0.38, 0.9, { pat: [PL(64, 3)] }), gallery: 0.75 },
  'LX-18': { base: [p('cylinder', 0.03, 0.42), p('trumpet', 0.12, 0.22), p([1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7], 0.45, 0.3)], shade: p('empire', 0.3, 0.78, { pat: [PL(30, 5)] }), gallery: 0.2 },
  'LX-39': { base: [p('cylinder', 0.04, 0.55), p('trumpet', 0.1, 0.25), p([1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7], 0.5, 0.35, { pat: [F(36, 1.4)] })], shade: p([1, 0.8, 0.6, 0.42, 0.28, 0.22, 0.22], 0.32, 0.82, { pat: [PL(48, 4)] }), gallery: 0.3 },
  'LX-24': { base: [p([0.18, 0.4, 0.65, 0.88, 1, 0.82, 0.55], 0.55, 0.45, { pat: [PL(40, 3)] })], shade: p('empire', 0.38, 0.78, { pat: [PL(48, 4)] }), gallery: 0.05 },
  'LX-19': { base: [p([1, 0.88, 0.76, 0.66, 0.56, 0.48, 0.42], 0.45, 0.45)], shade: p('empire', 0.35, 0.7, { pat: [PL(24, 6)] }), gallery: 0.12 },
  'LX-43': { base: [p(CONE, 0.4, 0.5, { pat: [PL(16, 3)] })], shade: p('cylinder', 0.3, 0.6, { pat: [pattern('cog', { count: 14, depth: 4, sharpness: 1 })] }), gallery: 0.05 },
  'LX-59': { base: [p('cylinder', 0.2, 0.2), p([0.5, 0.62, 0.76, 1, 0.86, 0.76, 0.42], 0.2, 0.82), p('cylinder', 0.12, 0.3)], shade: p('empire', 0.38, 0.75, { pat: [PL(28, 4)] }), gallery: 0.1 },
  'LX-66': { base: [p('cylinder', 0.08, 0.3, SQ), p([0.82, 0.86, 0.9, 0.94, 0.97, 1, 1], 0.4, 0.45, SQ)], shade: p('empire', 0.38, 0.72, { ...SQ, pat: [F(6, 0.8)] }), gallery: 0.05 },
  'LX-14': { base: [p('cylinder', 0.08, 0.25), p('orb', 0.5, 0.62, { pat: [F(20, 3, 3)] })], shade: p('empire', 0.32, 1), gallery: 0.2 },
  'LX-16': { base: [p('orb', 0.5, 0.62, { pat: [F(20, -3, 3)] })], shade: p('empire', 0.38, 0.85, { pat: [NZ()] }), gallery: 0.1 },
  'LX-26': { base: [p('cylinder', 0.1, 0.22), p('capsule', 0.5, 0.5, { pat: [F(24, 3)] })], shade: p('empire', 0.25, 0.75), gallery: 0.1 },
  // 03 Glow orbs
  'LX-12': { base: [p('cylinder', 0.5, 0.45, { pat: [NZ()] })], shade: p('lantern', 0.38, 0.75, { pat: [HX(16, 3, 0.35)] }), gallery: 0.05 },
  'LX-15': { base: [p('cylinder', 0.45, 0.35, { pat: [NZ()] })], shade: p('lantern', 0.42, 0.75, { pat: [HX(16, 3, 0.35)] }), gallery: 0.05 },
  'LX-63': { base: [p(CONE, 0.45, 0.35, { pat: [NZ()] })], shade: p('cylinder', 0.35, 0.7, { pat: [HX(24, 2.4, 0.3)] }), gallery: 0.05 },
  'LX-61': { base: [p('cylinder', 0.1, 0.5), p('cylinder', 0.35, 0.38, { pat: [NZ()] })], shade: p('drum', 0.38, 0.75, { pat: [HX(28, 2.4, 0.3)] }), gallery: 0.05 },
  'LX-42': { base: [p('orb', 0.45, 0.45, { pat: [NZ()] })], shade: p('lantern', 0.45, 0.7, { pat: [F(48, 1.5)] }), gallery: 0.05 },
  'LX-41': { base: [p([0.3, 0.8, 0.98, 1, 0.9, 0.7, 0.5], 0.5, 0.45, { pat: [NZ()] })], shade: p('lantern', 0.4, 0.6, { pat: [F(20, 3, 1.5)] }), gallery: 0.05 },
  'LX-46': { base: [p('dome', 0.08, 0.4), p('orb', 0.38, 0.55, { pat: [F(40, 2)] })], shade: p('capsule', 0.45, 0.62, { pat: [F(40, 2)] }), gallery: 0.03 },
  'LX-54': { base: [p(CONE, 0.4, 0.42)], shade: p([0.62, 0.9, 1, 0.95, 0.75, 0.55, 0.5], 0.48, 0.8, { pat: [F(48, 2.5)] }), gallery: 0.03 },
  'LX-06': { base: [p('cylinder', 0.45, 0.38, { pat: [pattern('fins', { rows: 3, depth: -0.8, sharpness: 2 })] })], shade: p([0.7, 0.92, 1, 1, 0.95, 0.8, 0.6], 0.55, 0.5, { pat: [F(24, 2)] }), gallery: 0.03 },
  'LX-08': { base: [p('cylinder', 0.3, 0.45, { pat: [NZ()] })], shade: p('capsule', 0.65, 0.55, { pat: [F(40, 1.5)] }), gallery: 0.03 },
  'LX-20': { base: [p('cylinder', 0.05, 0.75), p([1, 0.86, 0.76, 0.68, 0.63, 0.6, 0.58], 0.35, 0.5, { pat: [NZ()] })], shade: p('cylinder', 0.55, 0.65, { pat: [F(72, 1)] }), gallery: 0.03 },
  'LX-51': { base: [p('cylinder', 0.55, 0.3)], shade: p('drum', 0.3, 0.85, { sec: 'petal', sides: 10, sd: 0.08 }), gallery: 0.1 },
  // 04 Mushrooms & blooms
  'LX-38': { base: [p([1, 0.85, 0.75, 0.7, 0.68, 0.66, 0.65], 0.55, 0.38, { pat: [F(40, 1.2, 2)] })], shade: p('dome', 0.4, 1, { pat: [F(90, 1.5, 2)] }), gallery: 0.05 },
  'LX-32': { base: [p('orb', 0.38, 0.48, { pat: [F(24, 2)] })], shade: p([0.6, 0.95, 1, 0.9, 0.7, 0.5, 0.4], 0.5, 0.62, { pat: [PL(24, 3)] }), gallery: 0.05 },
  'LX-65': { base: [p([0.8, 0.9, 0.95, 0.9, 0.75, 0.6, 0.55], 0.55, 0.3, { pat: [F(30, 1.5)] })], shade: p('dome', 0.35, 0.65, { pat: [F(60, 1.5)] }), gallery: 0.05 },
  'LX-22': { base: [p('cylinder', 0.2, 0.2, { pat: [NZ()] }), p([0.55, 0.6, 1, 1, 1, 0.85, 0.7], 0.38, 0.42, { pat: [NZ()] })], shade: p('cylinder', 0.3, 0.6, { pat: [NZ()] }), gallery: 0.1 },
  'LX-53': { base: [p('cylinder', 0.03, 0.45), p('cylinder', 0.12, 0.16), p('cylinder', 0.2, 0.42, { pat: [F(48, 1.5)] })], shade: p('onion', 0.45, 0.62, { pat: [F(72, 1.2)] }), gallery: 0.03 },
  'LX-37': { base: [p('cylinder', 0.05, 0.24), p([0.85, 0.95, 1, 0.98, 0.96, 0.93, 0.9], 0.55, 0.3, { pat: [F(30, 1.5)] })], shade: p('dome', 0.32, 0.9, { pat: [F(80, 1.2)] }), gallery: 0.05 },
  // 05 Stacks & accordions
  'LX-03': { base: [p('cylinder', 0.12, 0.25)], shade: p('cylinder', 0.8, 0.55, { pat: [pattern('stack', { rows: 4, depth: 12, count: 1 }), F(20, 1)] }), gallery: 0.02, legs: 3 },
  'LX-09': { base: [p([1, 0.86, 0.76, 0.68, 0.63, 0.6, 0.58], 0.35, 0.4, { pat: [F(48, 1)] })], shade: p('cylinder', 0.55, 0.65, { pat: [pattern('stack', { rows: 4, depth: 10, count: 1 })] }), gallery: 0.03 },
  'LX-52': { base: [p('cylinder', 0.45, 0.4, { sec: 'petal', sides: 10, sd: 0.3 })], shade: p('cylinder', 0.45, 0.72, { sec: 'petal', sides: 10, sd: 0.3 }), gallery: 0.1 },
  'LX-48': { base: [p(CONE, 0.4, 0.42)], shade: p('cylinder', 0.55, 0.75, { pat: [pattern('accordion', { rows: 3, depth: 18 }), PL(48, 2)] }), gallery: 0.03 },
  'LX-49': { base: [p('cylinder', 0.04, 0.7), p(CONE, 0.35, 0.45)], shade: p('cylinder', 0.5, 0.75, { pat: [pattern('accordion', { rows: 3, depth: 16 }), PL(48, 2)] }), gallery: 0.03 },
  'LX-05': { base: [p('cylinder', 0.3, 0.5, SQ)], shade: p('cylinder', 0.5, 0.55, { ...SQ, pat: [F(28, 1)] }), gallery: 0.04 },
  'LX-57': { base: [p('cylinder', 0.35, 0.5, SQ), p('cylinder', 0.1, 0.2)], shade: p('cylinder', 0.5, 0.65, { ...SQ, pat: [pattern('fins', { rows: 10, depth: 2, sharpness: 2 })] }), gallery: 0.04 },
  'LX-62': { base: [p([0.7, 0.8, 0.88, 0.95, 1, 1, 1], 0.3, 0.5), p('cylinder', 0.2, 0.2)], shade: p('empire', 0.35, 0.9, { pat: [pattern('bubbles', { count: 32, rows: 8, depth: 1.5 })] }), gallery: 0.15 },
  // 06 Lattice & pattern
  'LX-23': { base: [p('cylinder', 0.55, 0.4, { pat: [NZ()] })], shade: p('drum', 0.35, 0.82, { pat: [pattern('rhombo', { count: 12, rows: 4, depth: 2 })] }), gallery: 0.25 },
  'LX-56': { base: [p('cylinder', 0.35, 0.5, { pat: [NZ()] })], shade: p('capsule', 0.55, 0.5, { pat: [pattern('lattice', { count: 8, rows: 6, depth: 1.6 })] }), gallery: 0.03 },
  'LX-55': { base: [p('cylinder', 0.3, 0.32)], shade: p('capsule', 0.62, 0.55, { pat: [pattern('rhombo', { count: 8, rows: 5, depth: 2.4 })] }), gallery: 0.03 },
  'LX-68': { base: [p('cylinder', 0.05, 0.48), p('cylinder', 0.4, 0.45, { pat: [pattern('scales', { count: 18, rows: 9, depth: 1.5 })] })], shade: p('drum', 0.5, 0.5), gallery: 0.03 },
  'LX-70': { base: [p('cylinder', 0.35, 0.6, { pat: [pattern('basket', { count: 40, rows: 12, depth: 1 })] })], shade: p('capsule', 0.6, 0.75), gallery: 0.03 },
  // 07 Pendants (shade only; handles run rim → cord)
  'LX-31': { base: [], shade: p('cylinder', 0.9, 0.58, { pat: [FIN(30, 6, 2.5)] }), gallery: 1 },
  'LX-50': { base: [], shade: p([0.8, 1, 1, 1, 1, 0.9, 0.4], 0.85, 0.85, { pat: [pattern('accordion', { rows: 3, depth: 20 }), PL(72, 1.5)] }), gallery: 1 },
  'LX-60': { base: [], shade: p([1, 0.85, 0.7, 0.55, 0.4, 0.28, 0.22], 0.7, 1, { pat: [PL(32, 5)] }), gallery: 1 },
  'LX-36': { base: [], shade: p([1, 0.8, 0.6, 0.42, 0.3, 0.32, 0.32], 0.55, 1.2, { pat: [PL(48, 4)] }), gallery: 1 },
  'LX-33': { base: [], shade: p([1, 0.97, 0.88, 0.7, 0.48, 0.45, 0.45], 0.75, 1.05, { pat: [F(72, 1.2)] }), gallery: 1 },
  'LX-64': { base: [], shade: p([1, 0.97, 0.9, 0.78, 0.6, 0.4, 0.24], 0.75, 0.95, { pat: [F(60, 1.2)] }), gallery: 1 },
  'LX-71': { base: [], shade: p([1, 0.98, 0.9, 0.75, 0.55, 0.32, 0.2], 0.7, 1.2, { pat: [F(32, 3, 2)] }), gallery: 1 },
  'LX-10': { base: [], shade: p('cylinder', 0.9, 0.7, { pat: [pattern('cog', { count: 14, depth: 10, sharpness: 1.4 })] }), gallery: 1 },
  'LX-67': { base: [], shade: p([0.62, 0.9, 1, 0.8, 0.55, 0.35, 0.22], 0.8, 1.1, { sec: 'polygon', sides: 8, round: 0 }), gallery: 1 },
  'LX-13': { base: [], shade: p([0.62, 0.86, 0.98, 1, 0.94, 0.72, 0.3], 0.8, 0.9, { pat: [F(18, 5, 2)] }), gallery: 1 },
  'LX-45': { base: [], shade: p([0.62, 0.86, 0.98, 1, 0.94, 0.72, 0.3], 0.8, 0.85, { pat: [F(60, 1.6)] }), gallery: 1 },
  'LX-17': { base: [], shade: p([1, 0.95, 0.85, 0.7, 0.55, 0.4, 0.28], 0.7, 0.95, { pat: [PL(24, 8)] }), gallery: 1 },
  'LX-58': { base: [], shade: p('cylinder', 0.85, 0.7, { sec: 'polygon', sides: 4, round: 0, pat: [pattern('chevron', { count: 6, rows: 9, depth: 5 })] }), gallery: 1 },
  'LX-69': { base: [], shade: p('cylinder', 0.9, 0.55, { pat: [pattern('scales', { count: 14, rows: 12, depth: 2.4 })] }), gallery: 1 },
  'LX-72': { base: [], shade: p([1, 0.95, 0.75, 0.5, 0.36, 0.32, 0.28], 0.75, 1.05, { pat: [HX(60, 1.5, 0.25)] }), gallery: 1 },
};

/** Shape for a recipe part at lamp height H. */
function shapeOf(x: P, H: number, wall: number, solid: boolean): ShapeSpec {
  const handles = typeof x.s === 'string' ? sil(x.s) : x.s.slice();
  return defaultShape({
    silhouette: typeof x.s === 'string' ? x.s : 'custom', handles, height: Math.max(4, x.h * H), diameter: Math.max(10, x.d * H),
    section: x.sec ?? 'circle', sides: x.sides ?? 6, sectionDepth: x.sd ?? 0.2, rounding: x.round ?? 0.2, twist: x.twist ?? 0,
    patterns: (x.pat ?? []).map((q) => ({ ...q })), wall, innerFollows: !solid,
  });
}

export type Size = 'S' | 'M' | 'L' | 'XL';

export function catalogueDesign(e: Catalogue, size: Size = 'M'): LampDesign {
  const H = e.heights[['S', 'M', 'L', 'XL'].indexOf(size)];
  const r = RECIPES[e.code];
  const kind: LampKind = e.type === 'Pendant' ? 'pendant' : 'table';
  const d = defaultDesign(kind);
  d.name = `${e.name} (${size})`;
  d.code = e.code;
  const translucent = e.shade[0] === 'PETG Translucent';
  const shadeShape = shapeOf(r.shade, H, translucent ? 1.2 : 1.6, false);
  const shade = section({ role: 'shade', name: 'Shade', shape: shadeShape, material: e.shade[0], color: e.shade[1], gallery: r.gallery });
  if (kind === 'pendant' || !r.base.length) {
    d.sections = [shade];
    d.bulb = shadeShape.diameter > 150 ? 'g95' : 'g45';
    return d;
  }
  // multi-tier bases: every tier is its own part, stacked with a joint sized to the shorter tier
  const tiers = r.base.map((x, i) => {
    const sh = shapeOf(x, H, 2.4, true);
    if (i === 0) sh.floor = 3;
    const prev = i > 0 ? r.base[i - 1].h * H : sh.height;
    const len = Math.max(4, Math.min(12, Math.round(Math.min(sh.height, prev) * 0.45)));
    return section({
      role: r.base.length === 1 || i === 0 ? 'base' : 'stem', name: r.base.length === 1 ? 'Base' : i === 0 ? 'Foot' : i === r.base.length - 1 ? 'Body' : `Tier ${i + 1}`,
      shape: sh, material: e.base![0], color: e.base![1], joint: defaultJoint({ kind: 'thread', length: len, pitch: len < 7 ? 1.5 : 2.5 }),
    });
  });
  d.sections = [...tiers, shade];
  if (r.legs) { d.base.legs = r.legs; d.base.legSplay = 14; }
  d.base.feltRecess = 0.8;
  d.bulb = minBulb(shadeShape);
  return d;
}

const minBulb = (s: ShapeSpec) => (s.diameter < 120 ? 'g45' : s.diameter < 170 ? 'p45-e27' : 'a60');

// ---------------------------------------------------------------- studio & starters
export interface Preset { id: string; group: string; name: string; make: () => LampDesign }

const studio = (id: string, name: string, f: (d: LampDesign) => void, kind: LampKind = 'pendant'): Preset =>
  ({ id, group: 'Studio forms', name, make: () => { const d = defaultDesign(kind); d.name = name; f(d); return d; } });

const mini = (id: string, name: string, f: (d: LampDesign) => void): Preset =>
  ({ id, group: 'Mini lamps', name, make: () => { const d = defaultDesign('table'); d.name = name; d.fitting.holder = 'e14'; d.bulb = 'p45'; d.watts = 4; f(d); return d; } });

export const PRESETS: Preset[] = [
  ...(['table', 'wall', 'pendant', 'floor', 'ceiling', 'lantern', 'mount'] as LampKind[]).map((k) => ({ id: `start-${k}`, group: 'Starters', name: defaultDesign(k).name, make: () => defaultDesign(k) })),
  { id: 'start-tripod', group: 'Starters', name: 'Tripod table lamp', make: () => { const d = defaultDesign('table'); d.name = 'Tripod table lamp'; d.base.legs = 3; d.sections[0].shape = defaultShape({ height: 60, diameter: 60, wall: 3, innerFollows: false }); d.sections[1].shape = defaultShape({ silhouette: 'stack', handles: sil('cylinder'), height: 200, diameter: 180, patterns: [pattern('stack', { rows: 4, depth: 14 })] }); d.sections[1].material = 'PETG Translucent'; d.sections[1].color = 'Orange'; d.sections[1].gallery = 0.02; return d; } },
  { id: 'start-half-sconce', group: 'Starters', name: 'Half-round wall sconce', make: () => { const d = defaultDesign('wall'); d.name = 'Half-round wall sconce'; Object.assign(d.sections[0].shape, { section: 'half', sectionDepth: 0.55 }); d.wall.armLength = 40; return d; } },
  { id: 'start-bike', group: 'Starters', name: 'Bicycle light (31.8 bar)', make: () => { const d = defaultDesign('mount'); d.name = 'Bicycle light'; d.mount.pipe = 31.8; return d; } },
  { id: 'start-rack', group: 'Starters', name: 'Roof-rack camp light (42.4 strap)', make: () => { const d = defaultDesign('mount'); d.name = 'Roof-rack camp light'; d.mount.pipe = 42.4; d.mount.style = 'strap'; d.sections[0].shape.diameter = 70; d.bulb = 'puck60'; return d; } },
  { id: 'start-hex-lantern', group: 'Starters', name: 'Hexagonal lantern', make: () => { const d = defaultDesign('lantern'); d.name = 'Hexagonal lantern'; for (const s of d.sections) Object.assign(s.shape, { section: 'polygon', sides: 6, rounding: 0.1 }); return d; } },
  { id: 'start-totem-floor', group: 'Starters', name: 'Stacked totem floor lamp (5 tiers)', make: () => {
    const d = defaultDesign('floor'); d.name = 'Stacked totem floor lamp'; d.bulb = 'strip'; d.fitting.holder = 'strip';
    const tiers = ['orb', 'barrel', 'onion', 'lantern', 'capsule'];
    d.sections = [d.sections[0], ...tiers.map((t, i) => section({ role: 'body', name: `Tier ${i + 1}`, material: 'PETG Translucent', color: ['Orange', 'Yellow', 'Pink', 'Ice Blue', 'Arctic'][i], attach: 'stack', joint: defaultJoint({ kind: 'bayonet', length: 10 }), shape: defaultShape({ silhouette: t, handles: sil(t).map((v) => Math.max(0.55, v)), height: 220, diameter: 200, patterns: [pattern(['flutes', 'stack', 'helix', 'rhombo', 'fins'][i] as PatternLayer['type'], { count: 24, rows: 4, depth: 3 })] }) }))];
    return d;
  } },
  studio('mm-twist', 'Twisted vase pendant', (d) => { d.sections[0].shape = defaultShape({ silhouette: 'onion', handles: [0.5, 0.88, 1, 0.94, 0.7, 0.44, 0.22], height: 220, diameter: 230, section: 'polygon', sides: 9, rounding: 0.15, twist: 120, vase: true, wall: 0.8 }); d.sections[0].gallery = 1; }),
  studio('mm-fins', 'Fin stack pendant', (d) => { d.sections[0].shape = defaultShape({ silhouette: 'orb', handles: sil('orb'), height: 220, diameter: 240, patterns: [pattern('fins', { rows: 18, depth: 14, sharpness: 2 })], innerFollows: false }); }),
  studio('mm-wavefins', 'Wavy fin pendant', (d) => { d.sections[0].shape = defaultShape({ silhouette: 'drum', handles: sil('drum'), height: 180, diameter: 220, patterns: [pattern('wave-fins', { count: 16, rows: 14, depth: 10 })], innerFollows: false }); }),
  studio('mm-ribbon', 'Ribbon table lamp', (d) => { d.sections[1].shape = defaultShape({ silhouette: 'tulip', handles: sil('tulip'), height: 200, diameter: 190, patterns: [pattern('ribbon', { count: 8, rows: 1.5, depth: 7 })] }); d.sections[1].material = 'PETG Translucent'; d.sections[1].color = 'Ice Blue'; }, 'table'),
  studio('mm-voronoi', 'Voronoi globe pendant', (d) => { d.sections[0].shape = defaultShape({ silhouette: 'orb', handles: sil('orb'), height: 220, diameter: 230, patterns: [pattern('voronoi', { count: 12, rows: 7, depth: 3, seed: 7 })] }); }),
  studio('mm-facet', 'Low-poly faceted pendant', (d) => { d.sections[0].shape = defaultShape({ silhouette: 'onion', handles: sil('onion'), height: 200, diameter: 220, section: 'polygon', sides: 7, rounding: 0, twist: 51 }); }),
  studio('mm-honey', 'Honeycomb drum', (d) => { d.sections[1].shape = defaultShape({ silhouette: 'drum', handles: sil('drum'), height: 150, diameter: 210, patterns: [pattern('honeycomb', { count: 16, rows: 6, depth: 2.4 })] }); }, 'table'),
  mini('mini-mushroom', 'Mini mushroom', (d) => { d.sections[0].shape = defaultShape({ silhouette: 'flare', handles: sil('flare'), height: 70, diameter: 60, wall: 2.4, innerFollows: false, patterns: [pattern('flutes', { count: 24, depth: 1 })] }); d.sections[1].shape = defaultShape({ silhouette: 'dome', handles: sil('dome'), height: 55, diameter: 130, patterns: [pattern('flutes', { count: 48, depth: 1.4 })] }); d.sections[1].gallery = 0.08; }),
  mini('mini-stack', 'Mini bubble stack', (d) => { d.sections[0].shape = defaultShape({ height: 30, diameter: 70, wall: 3, innerFollows: false }); d.sections[1].shape = defaultShape({ height: 120, diameter: 90, patterns: [pattern('stack', { rows: 4, depth: 7 })] }); d.sections[1].material = 'PETG Translucent'; d.sections[1].color = 'Pink'; d.sections[1].gallery = 0.03; }),
  mini('mini-candle', 'Mini candle cone', (d) => { d.fitting.holder = 'e12'; d.bulb = 'c35-e12'; d.sections[0].shape = defaultShape({ silhouette: 'cone', handles: sil('cone'), height: 80, diameter: 70, wall: 2.4, innerFollows: false }); d.sections[1].shape = defaultShape({ silhouette: 'empire', handles: sil('empire'), height: 90, diameter: 130, patterns: [pattern('pleats', { count: 24, depth: 3 })] }); d.sections[1].gallery = 0.05; }),
  mini('mini-battery', 'Mini battery orb', (d) => { Object.assign(d, defaultDesign('lantern'), { name: 'Mini battery orb' }); d.sections[1].shape = defaultShape({ silhouette: 'orb', handles: sil('orb').map((v) => Math.max(0.7, v)), height: 90, diameter: 100, patterns: [pattern('ripple', { count: 8, rows: 6, depth: 1.6 })] }); d.sections.splice(2, 1); }),
  ...CATALOGUE.map((e) => ({ id: e.code, group: `Catalogue · ${e.family}`, name: `${e.code} ${e.name}`, make: () => catalogueDesign(e) })),
];
