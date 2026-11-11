// Renex filament materials: how each printed material scatters light. Values are physically based
// (index of refraction, roughness, transmission, subsurface-like attenuation, sheen / clearcoat) and
// measured or estimated from real filament samples; colour comes from the user's filament or a swatch.
import * as THREE from 'three';

export type FinishKind =
  | 'PLA' | 'PLA+' | 'PLA Matte' | 'PLA Silk' | 'PLA Silk Dual' | 'PLA Marble' | 'PLA Stone' | 'PLA Wood' | 'PLA Metal'
  | 'PLA Glow' | 'PLA Glitter' | 'PLA Galaxy' | 'PLA Carbon Fiber' | 'PLA Translucent' | 'PLA Rainbow'
  | 'PETG' | 'PETG Translucent' | 'PETG Carbon Fiber' | 'ABS' | 'ASA' | 'TPU' | 'TPU Translucent'
  | 'PC' | 'PA (Nylon)' | 'PA-CF' | 'PVA' | 'HIPS' | 'PP' | 'Resin-like PLA';

/** Physically based description of a filament's surface and body. */
export interface FinishSpec {
  /** Microfacet roughness of the printed (side-wall) surface, 0 mirror … 1 chalk. */
  roughness: number;
  metalness: number;
  ior: number;
  /** 0 opaque … 1 clear body. */
  transmission: number;
  /** Distance (mm) light travels in the body before it takes the filament colour (smaller = more saturated / opaque). */
  attenuationMm: number;
  clearcoat: number;
  clearcoatRoughness: number;
  sheen: number;
  /** Glossiness gain of the top skin compared with side walls (ironed / top surface). */
  topGloss: number;
  /** Speckle / fill particles: 'none' | stone grit | wood fibres | metal flakes | glitter | carbon. */
  fill: 'none' | 'grit' | 'wood' | 'metal' | 'glitter' | 'carbon' | 'marble';
  /** How strongly layer lines read (silk and translucents hide them less, matte shows them crisply). */
  layerContrast: number;
  /** Self-emission in the dark (glow-in-the-dark), cd/m² relative. */
  glow?: number;
  /** Two-tone (dual silk) second colour, mixed by viewing angle. */
  dual?: boolean;
}

const f = (s: Partial<FinishSpec>): FinishSpec => ({
  roughness: 0.5, metalness: 0, ior: 1.46, transmission: 0, attenuationMm: 0.6, clearcoat: 0, clearcoatRoughness: 0.2,
  sheen: 0, topGloss: 0.15, fill: 'none', layerContrast: 1, ...s,
});

export const FINISHES: Record<FinishKind, FinishSpec> = {
  'PLA': f({ roughness: 0.42, ior: 1.46, attenuationMm: 0.35, topGloss: 0.2 }),
  'PLA+': f({ roughness: 0.46, ior: 1.46, attenuationMm: 0.3, topGloss: 0.18 }),
  'PLA Matte': f({ roughness: 0.82, ior: 1.45, attenuationMm: 0.2, topGloss: 0.05, layerContrast: 1.15 }),
  'PLA Silk': f({ roughness: 0.2, metalness: 0.35, ior: 1.5, attenuationMm: 0.4, sheen: 0.25, clearcoat: 0.4, clearcoatRoughness: 0.12, topGloss: 0.25, layerContrast: 0.75 }),
  'PLA Silk Dual': f({ roughness: 0.2, metalness: 0.35, ior: 1.5, sheen: 0.3, clearcoat: 0.4, clearcoatRoughness: 0.12, layerContrast: 0.75, dual: true }),
  'PLA Marble': f({ roughness: 0.68, ior: 1.46, attenuationMm: 0.25, fill: 'marble', layerContrast: 0.95 }),
  'PLA Stone': f({ roughness: 0.88, ior: 1.46, attenuationMm: 0.15, fill: 'grit', topGloss: 0.03, layerContrast: 1.1 }),
  'PLA Wood': f({ roughness: 0.78, ior: 1.46, attenuationMm: 0.15, fill: 'wood', topGloss: 0.04, layerContrast: 1.1 }),
  'PLA Metal': f({ roughness: 0.48, metalness: 0.55, ior: 1.6, fill: 'metal', layerContrast: 0.9 }),
  'PLA Glow': f({ roughness: 0.5, ior: 1.46, attenuationMm: 0.8, glow: 0.6 }),
  'PLA Glitter': f({ roughness: 0.45, ior: 1.47, fill: 'glitter', clearcoat: 0.2 }),
  'PLA Galaxy': f({ roughness: 0.4, ior: 1.47, fill: 'glitter', clearcoat: 0.3 }),
  'PLA Carbon Fiber': f({ roughness: 0.74, ior: 1.46, attenuationMm: 0.1, fill: 'carbon', topGloss: 0.04, layerContrast: 1.05 }),
  'PLA Translucent': f({ roughness: 0.3, ior: 1.46, transmission: 0.82, attenuationMm: 6, topGloss: 0.2, layerContrast: 0.7 }),
  'PLA Rainbow': f({ roughness: 0.25, metalness: 0.3, ior: 1.5, sheen: 0.25, clearcoat: 0.35, layerContrast: 0.8 }),
  'PETG': f({ roughness: 0.18, ior: 1.57, attenuationMm: 0.9, clearcoat: 0.3, clearcoatRoughness: 0.08, topGloss: 0.3, layerContrast: 0.85 }),
  'PETG Translucent': f({ roughness: 0.16, ior: 1.57, transmission: 0.9, attenuationMm: 10, clearcoat: 0.3, clearcoatRoughness: 0.06, topGloss: 0.3, layerContrast: 0.65 }),
  'PETG Carbon Fiber': f({ roughness: 0.66, ior: 1.57, attenuationMm: 0.1, fill: 'carbon', layerContrast: 1.05 }),
  'ABS': f({ roughness: 0.55, ior: 1.53, attenuationMm: 0.3, topGloss: 0.12 }),
  'ASA': f({ roughness: 0.6, ior: 1.53, attenuationMm: 0.25, topGloss: 0.1, layerContrast: 1.05 }),
  'TPU': f({ roughness: 0.62, ior: 1.5, attenuationMm: 0.7, sheen: 0.35, topGloss: 0.1, layerContrast: 1.0 }),
  'TPU Translucent': f({ roughness: 0.45, ior: 1.5, transmission: 0.75, attenuationMm: 5, sheen: 0.3, layerContrast: 0.8 }),
  'PC': f({ roughness: 0.22, ior: 1.585, attenuationMm: 1.4, clearcoat: 0.3, topGloss: 0.25, layerContrast: 0.85 }),
  'PA (Nylon)': f({ roughness: 0.6, ior: 1.53, attenuationMm: 0.9, sheen: 0.2, layerContrast: 0.95 }),
  'PA-CF': f({ roughness: 0.78, ior: 1.53, attenuationMm: 0.08, fill: 'carbon', layerContrast: 1.05 }),
  'PVA': f({ roughness: 0.5, ior: 1.48, transmission: 0.4, attenuationMm: 3 }),
  'HIPS': f({ roughness: 0.58, ior: 1.55, attenuationMm: 0.3 }),
  'PP': f({ roughness: 0.4, ior: 1.49, transmission: 0.35, attenuationMm: 2.5, layerContrast: 0.85 }),
  'Resin-like PLA': f({ roughness: 0.32, ior: 1.47, attenuationMm: 0.6, clearcoat: 0.25, layerContrast: 0.6 }),
};

export const FINISH_KINDS = Object.keys(FINISHES) as FinishKind[];

/** Best finish for a filament type / name from a profile or another plugin ("PETG", "PLA Silk", "PETG Translucent"…). */
export function finishFor(type: string, name = ''): FinishKind {
  const s = `${type} ${name}`.toLowerCase();
  const has = (...k: string[]) => k.some((x) => s.includes(x));
  if (has('petg') && has('cf', 'carbon')) return 'PETG Carbon Fiber';
  if (has('pa', 'nylon') && has('cf', 'carbon')) return 'PA-CF';
  if (has('petg') && has('transl', 'clear', 'transparent')) return 'PETG Translucent';
  if (has('tpu') && has('transl', 'clear')) return 'TPU Translucent';
  if (has('petg')) return 'PETG';
  if (has('asa')) return 'ASA';
  if (has('abs')) return 'ABS';
  if (has('tpu', 'tpe', 'flex')) return 'TPU';
  if (has('pc ', 'polycarbonate') || s.trim() === 'pc') return 'PC';
  if (has('nylon', 'pa6', 'pa12', 'pa ')) return 'PA (Nylon)';
  if (has('pva')) return 'PVA';
  if (has('hips')) return 'HIPS';
  if (has('pp ', 'polypropylene') || s.trim() === 'pp') return 'PP';
  if (has('dual', 'tri-colour', 'tri-color', 'bicolor')) return 'PLA Silk Dual';
  if (has('rainbow', 'gradient')) return 'PLA Rainbow';
  if (has('silk')) return 'PLA Silk';
  if (has('matte')) return 'PLA Matte';
  if (has('marble')) return 'PLA Marble';
  if (has('stone', 'granite', 'terracotta stone')) return 'PLA Stone';
  if (has('wood', 'bamboo', 'cork')) return 'PLA Wood';
  if (has('metal', 'bronze', 'copper fill', 'steel fill')) return 'PLA Metal';
  if (has('glow')) return 'PLA Glow';
  if (has('galaxy', 'sparkle')) return 'PLA Galaxy';
  if (has('glitter')) return 'PLA Glitter';
  if (has('cf', 'carbon')) return 'PLA Carbon Fiber';
  if (has('transl', 'clear', 'transparent')) return 'PLA Translucent';
  if (has('pla+', 'pla plus', 'pla pro')) return 'PLA+';
  return 'PLA';
}

export interface BrandSwatch { brand: string; line: string; name: string; hex: string; finish: FinishKind }

const line = (brand: string, lineName: string, finish: FinishKind, list: [string, string][]): BrandSwatch[] =>
  list.map(([name, hex]) => ({ brand, line: lineName, name, hex, finish }));

/** Real filament colours (published or measured hex values, close to the spool in daylight). */
export const BRAND_SWATCHES: BrandSwatch[] = [
  ...line('Bambu Lab', 'PLA Basic', 'PLA', [['Jade White', '#FFFFFF'], ['Black', '#000000'], ['Red', '#C12E1F'], ['Orange', '#FF6A13'], ['Yellow', '#F4EE2A'], ['Bambu Green', '#00AE42'], ['Cyan', '#0086D6'], ['Blue', '#0A2989'], ['Purple', '#5E43B7'], ['Magenta', '#EC008C'], ['Pink', '#F55A74'], ['Gray', '#8E9089'], ['Silver', '#A6A9AA'], ['Gold', '#E4BD68'], ['Beige', '#F7E6DE'], ['Brown', '#9D432C'], ['Cocoa Brown', '#6F5034'], ['Bronze', '#847D48'], ['Mistletoe Green', '#3F8E43'], ['Turquoise', '#00B1B7'], ['Hot Pink', '#F5547C'], ['Indigo Purple', '#482960'], ['Maroon Red', '#9D2235'], ['Cobalt Blue', '#0055B8']]),
  ...line('Bambu Lab', 'PLA Matte', 'PLA Matte', [['Ivory White', '#FFFFFF'], ['Charcoal', '#000000'], ['Ash Gray', '#9B9EA0'], ['Nardo Gray', '#757575'], ['Bone White', '#CBC6B8'], ['Desert Tan', '#E8DBB7'], ['Latte Brown', '#D3B7A7'], ['Caramel', '#AE835B'], ['Terracotta', '#B15533'], ['Dark Brown', '#7D6556'], ['Dark Chocolate', '#4D3324'], ['Scarlet Red', '#DE4343'], ['Dark Red', '#BB3D43'], ['Mandarin Orange', '#F99963'], ['Lemon Yellow', '#F7D959'], ['Grass Green', '#61C680'], ['Apple Green', '#C2E189'], ['Dark Green', '#68724D'], ['Ice Blue', '#A3D8E1'], ['Sky Blue', '#56B7E6'], ['Marine Blue', '#0078BF'], ['Dark Blue', '#042F56'], ['Lilac Purple', '#AE96D4'], ['Sakura Pink', '#E8AFCF'], ['Plum', '#950051']]),
  ...line('Bambu Lab', 'PLA Silk+', 'PLA Silk', [['Gold', '#F4A925'], ['Silver', '#C8C8C8'], ['Titan Gray', '#5F6367'], ['Blue', '#008BDA'], ['Purple', '#8671CB'], ['Candy Red', '#D02727'], ['Candy Green', '#018814'], ['Rose Gold', '#BA9594'], ['Baby Blue', '#A8C6EE'], ['Pink', '#F7ADA6'], ['Mint', '#96DCB9'], ['Champagne', '#F3CFB2'], ['White', '#FFFFFF']]),
  ...line('Bambu Lab', 'PLA Marble', 'PLA Marble', [['White Marble', '#F7F3F0'], ['Red Granite', '#AD4E38']]),
  ...line('Bambu Lab', 'PLA Wood', 'PLA Wood', [['Black Walnut', '#4F3F24'], ['Rosewood', '#4C241C'], ['Clay Brown', '#995F11'], ['Classic Birch', '#918669'], ['White Oak', '#D6CCA3'], ['Ochre Yellow', '#C98935']]),
  ...line('Bambu Lab', 'PETG HF', 'PETG', [['White', '#FFFFFF'], ['Black', '#000000'], ['Gray', '#ADB1B2'], ['Dark Gray', '#515151'], ['Red', '#EB3A3A'], ['Orange', '#F75403'], ['Yellow', '#FFD00B'], ['Green', '#00AE42'], ['Lime Green', '#6EE53C'], ['Forest Green', '#39541A'], ['Blue', '#002E96'], ['Lake Blue', '#1F79E5'], ['Peanut Brown', '#875718'], ['Cream', '#F9DFB9']]),
  ...line('Bambu Lab', 'PETG Translucent', 'PETG Translucent', [['Clear', '#F0F4F5'], ['Translucent Gray', '#8E8E8E'], ['Translucent Light Blue', '#61B0FF'], ['Translucent Olive', '#748C45'], ['Translucent Brown', '#C9A381'], ['Translucent Teal', '#77EDD7'], ['Translucent Orange', '#FF911A'], ['Translucent Purple', '#D6ABFF'], ['Translucent Pink', '#F9C1BD']]),
  ...line('Prusament', 'PLA', 'PLA', [['Galaxy Black', '#29292B'], ['Galaxy Silver', '#8A8C8E'], ['Galaxy Purple', '#4F3E6D'], ['Jet Black', '#1B1B1B'], ['Signal White', '#F2F2F0'], ['Prusa Orange', '#FA6831'], ['Lipstick Red', '#B5191F'], ['Azure Blue', '#2C83C9'], ['Pistachio Green', '#9CC260'], ['Mystic Green', '#486D53'], ['Gentleman\'s Grey', '#3C4047'], ['Vanilla White', '#EFE7D6'], ['Pineapple Yellow', '#F4D20B'], ['Royal Blue', '#203D8E'], ['Lime Green', '#97D700'], ['Opal Green', '#2C9C82'], ['Ms. Pink', '#E86BA9'], ['Terracotta Light', '#C66B52'], ['Chalky Blue', '#87A6C8']]),
  ...line('Prusament', 'PLA Blend', 'PLA Marble', [['Pearl Mouse', '#8B8B86'], ['Jungle Green Glitter', '#2E5A41']]),
  ...line('Prusament', 'PETG', 'PETG', [['Jet Black', '#181818'], ['Signal White', '#F7F6F2'], ['Prusa Orange', '#FA6831'], ['Carmine Red', '#9F1D27'], ['Ultramarine Blue', '#253F8F'], ['Yellow Gold', '#F0B323'], ['Urban Grey', '#5D6066'], ['Titan Grey', '#6E7072'], ['Ocean Blue', '#1E5BA8'], ['Anthracite Grey', '#38393B'], ['Chalky Blue', '#87A6C8'], ['Clear', '#E9EEEE']]),
  ...line('Prusament', 'PETG Transparent', 'PETG Translucent', [['Clear', '#ECF1F1'], ['Transparent Green', '#2F9E59'], ['Transparent Blue', '#3D7ACC'], ['Transparent Red', '#C8323A'], ['Transparent Orange', '#F58A33']]),
  ...line('Prusament', 'ASA', 'ASA', [['Jet Black', '#191919'], ['Signal White', '#F2F2EE'], ['Prusa Orange', '#FA6831'], ['Lipstick Red', '#B5191F'], ['Sapphire Blue', '#244C9A'], ['Prusa Pro Green', '#319D59']]),
  ...line('Polymaker', 'PolyTerra PLA', 'PLA Matte', [['Charcoal Black', '#2B2B2B'], ['Cotton White', '#F2F0EB'], ['Fossil Grey', '#8E8D8A'], ['Army Brown', '#6C5A43'], ['Wood Brown', '#8B6141'], ['Sakura Pink', '#F0B4C5'], ['Lavender Purple', '#A592C6'], ['Forest Green', '#2E5E43'], ['Army Light Green', '#8E9D6C'], ['Muted White', '#E8E2D4'], ['Peach', '#F6BD9C'], ['Arctic Teal', '#6FB7B4'], ['Savannah Yellow', '#E1B85A'], ['Lava Red', '#C0392B'], ['Electric Indigo', '#4B4ACF']]),
  ...line('Polymaker', 'PolyLite PLA', 'PLA', [['Black', '#1A1A1A'], ['White', '#F5F5F5'], ['Grey', '#8C8C8C'], ['Red', '#D62E2E'], ['Blue', '#1F5CC4'], ['Teal', '#2BA6A6'], ['Orange', '#F27A1A'], ['Yellow', '#F7D21E'], ['Green', '#3AA655']]),
  ...line('Polymaker', 'PolyLite Silk PLA', 'PLA Silk', [['Gold', '#D4A83B'], ['Silver', '#C3C4C6'], ['Bronze', '#A1693C'], ['Copper', '#B5643B'], ['Blue', '#2F6FC7'], ['Purple', '#8253B6']]),
  ...line('Polymaker', 'PolyLite PETG', 'PETG', [['Black', '#1C1C1C'], ['White', '#F4F4F4'], ['Grey', '#8D8F91'], ['Red', '#C82C2C'], ['Blue', '#1C56B8'], ['Translucent', '#E8EEEE']]),
  ...line('eSun', 'PLA+', 'PLA+', [['Black', '#1C1C1C'], ['White', '#F8F8F6'], ['Grey', '#7F8082'], ['Fire Engine Red', '#C1121C'], ['Orange', '#F37021'], ['Yellow', '#FFD200'], ['Green', '#2BAA4A'], ['Blue', '#1D4BA0'], ['Light Blue', '#62A8E5'], ['Purple', '#6B3FA0'], ['Pink', '#F48FB1'], ['Brown', '#6D4C41'], ['Cold White', '#F4F7FA'], ['Skin', '#E8C3A6'], ['Olive Green', '#6B7A2F'], ['Peak Green', '#00785A']]),
  ...line('eSun', 'ePLA-Matte', 'PLA Matte', [['Deep Black', '#262626'], ['Milky White', '#ECE9E2'], ['Almond Yellow', '#E3CD9A'], ['Morandi Green', '#8DA38F'], ['Mint Blue', '#9CC9C9']]),
  ...line('eSun', 'eSilk-PLA', 'PLA Silk', [['Gold', '#E1B64A'], ['Silver', '#C7C8C9'], ['Copper', '#B86F45'], ['Violet', '#7F4FB3'], ['Jacinth', '#E46B2D']]),
  ...line('Elegoo', 'PLA', 'PLA', [['Black', '#1A1A1A'], ['White', '#F6F6F4'], ['Space Grey', '#6B6E72'], ['Red', '#D3262E'], ['Blue', '#2050B6'], ['Orange', '#F47A20'], ['Yellow', '#F9D71C'], ['Green', '#38A84B'], ['Beige', '#E8D9BE'], ['Sky Blue', '#69B3E7']]),
  ...line('Elegoo', 'PLA Matte', 'PLA Matte', [['Matte Black', '#2A2A2A'], ['Matte White', '#EFEDE7'], ['Matte Sakura Pink', '#EDB1C2'], ['Matte Ruby Red', '#B83A44'], ['Matte Moss Green', '#6C7E4E']]),
  ...line('Sunlu', 'PLA', 'PLA', [['Black', '#1B1B1B'], ['White', '#F5F5F3'], ['Grey', '#828487'], ['Red', '#D3232C'], ['Blue', '#2156B9'], ['Green', '#2FA352'], ['Yellow', '#FAD81F'], ['Orange', '#F47B22'], ['Purple', '#7A4BAE'], ['Pink', '#F28DB2']]),
  ...line('Sunlu', 'Silk PLA+', 'PLA Silk', [['Gold', '#DDB050'], ['Silver', '#C3C3C5'], ['Rainbow', '#C77AD1'], ['Copper', '#BD6F44']]),
  ...line('Sunlu', 'Marble PLA', 'PLA Marble', [['Marble', '#D8D4CC']]),
  ...line('Sunlu', 'Wood PLA', 'PLA Wood', [['Wood', '#A07848']]),
  ...line('Overture', 'PLA', 'PLA', [['Black', '#191919'], ['White', '#F4F4F2'], ['Space Grey', '#6C6F73'], ['Rock White', '#E5E0D6'], ['Digital Blue', '#1F5CB7'], ['Red', '#C9242C'], ['Orange', '#F27420'], ['Yellow', '#F7D21D'], ['Green', '#36A148']]),
  ...line('Overture', 'TPU', 'TPU', [['Black', '#1E1E1E'], ['White', '#F2F2F0'], ['Red', '#C42A2F'], ['Blue', '#2453AE'], ['Clear', '#E9EEEE']]),
  ...line('Hatchbox', 'PLA', 'PLA', [['Black', '#1A1A1A'], ['True White', '#F6F6F5'], ['Grey', '#8A8C8E'], ['True Red', '#C8102E'], ['Blue', '#1E4FA8'], ['Gold', '#C9A33D'], ['Wood', '#9A7448'], ['Glow Green', '#C9F2B1']]),
  ...line('Fiberlogy', 'Easy PETG', 'PETG', [['Black', '#1C1C1C'], ['White', '#F3F3F1'], ['Graphite', '#4A4B4E'], ['Navy Blue', '#1F2A5B'], ['Pure Transparent', '#EEF2F2'], ['Orange Transparent', '#F28A2F']]),
  ...line('Extrudr', 'PLA NX2', 'PLA Matte', [['Matt Black', '#262626'], ['Matt White', '#EFEDE8'], ['Signal Red', '#B3242A'], ['Sky Blue', '#69A9DB'], ['Olive', '#6D7746']]),
  ...line('ColorFabb', 'PLA/PHA', 'PLA', [['Standard Black', '#1A1A1A'], ['Standard White', '#F4F4F2'], ['Dutch Orange', '#F37321'], ['Traffic Red', '#C1121F']]),
  ...line('ColorFabb', 'WoodFill', 'PLA Wood', [['WoodFill', '#B08758'], ['BambooFill', '#CDAE7A'], ['CorkFill', '#7A5B3B']]),
  ...line('ColorFabb', 'Metal Fill', 'PLA Metal', [['CopperFill', '#B6683E'], ['BronzeFill', '#A07745'], ['BrassFill', '#C2A14B'], ['SteelFill', '#8E9196']]),
];

/** NexSpiro's own colour library: a curated set for product photography (tested to read well under studio light). */
export const NEXSPIRO_SWATCHES: BrandSwatch[] = [
  ...line('NexSpiro', 'Studio', 'PLA Matte', [['Studio White', '#F1EEE8'], ['Warm Sand', '#D9C3A0'], ['Clay', '#B9785A'], ['Terracotta', '#C0603F'], ['Sage', '#9CAF88'], ['Olive Grove', '#6F7A4A'], ['Eucalyptus', '#6E8F87'], ['Mist Blue', '#9DB4C8'], ['Ink', '#1F2430'], ['Charcoal', '#2E2E30'], ['Blush', '#E6B7B0'], ['Ochre', '#C89B3C'], ['Moss', '#55663A'], ['Slate', '#5A6470'], ['Bone', '#E4DCCB']]),
  ...line('NexSpiro', 'Glow', 'PETG Translucent', [['Amber Glow', '#F3A040'], ['Honey', '#E8B35A'], ['Frost', '#E9EEF0'], ['Rose Quartz', '#F2C2C0'], ['Sea Glass', '#9ED4C6'], ['Smoke', '#7D7F82']]),
  ...line('NexSpiro', 'Lustre', 'PLA Silk', [['Champagne', '#E9CFA7'], ['Rose Gold', '#C99A8A'], ['Pewter', '#8F9295'], ['Bronze', '#9C6B3D'], ['Pearl', '#EFEAE2']]),
];

export const ALL_SWATCHES = [...NEXSPIRO_SWATCHES, ...BRAND_SWATCHES];
export const SWATCH_BRANDS = [...new Set(ALL_SWATCHES.map((s) => s.brand))];

/** Linear absorption colour for a given body colour: what the light becomes after `attenuationMm` of filament. */
function attenuationColour(base: THREE.Color): THREE.Color {
  // keep hue, push saturation: thin filament looks lighter than its spool colour
  const c = base.clone();
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return c.setHSL(hsl.h, Math.min(1, hsl.s * 1.1), Math.max(0.05, Math.min(0.97, hsl.l)));
}

export interface SurfaceMaps { wall?: THREE.Texture; wallRough?: THREE.Texture; top?: THREE.Texture; topRough?: THREE.Texture; bottom?: THREE.Texture; fill?: THREE.Texture }

/** Three materials for one printed part: side walls (layer lines), top skin (infill lines), bed side (plate texture). */
export function printedMaterials(hex: string, finish: FinishKind, maps: SurfaceMaps, opts: { lineStrength?: number; secondHex?: string } = {}): THREE.MeshPhysicalMaterial[] {
  const spec = FINISHES[finish];
  const base = new THREE.Color(hex);
  const strength = (opts.lineStrength ?? 1) * spec.layerContrast;
  const mk = (rough: number, normal?: THREE.Texture, roughMap?: THREE.Texture) => {
    const m = new THREE.MeshPhysicalMaterial({
      color: base, roughness: rough, metalness: spec.metalness, ior: spec.ior,
      transmission: spec.transmission, thickness: spec.transmission ? 2 : 0,
      attenuationColor: attenuationColour(base), attenuationDistance: spec.attenuationMm,
      clearcoat: spec.clearcoat, clearcoatRoughness: spec.clearcoatRoughness,
      sheen: spec.sheen, sheenColor: base.clone().lerp(new THREE.Color('#ffffff'), 0.5), sheenRoughness: 0.4,
      side: THREE.FrontSide,
    });
    if (normal) { m.normalMap = normal; m.normalScale = new THREE.Vector2(strength, strength); }
    if (roughMap) m.roughnessMap = roughMap;
    // fill texture stores 1.0 as 200/255: compensate so the average colour still matches the spool
    if (spec.fill !== 'none' && maps.fill) { m.map = maps.fill; m.color.multiplyScalar(255 / 200); }
    if (spec.glow) { m.emissive = base.clone().lerp(new THREE.Color('#b8ffb0'), 0.6); m.emissiveIntensity = 0; }
    if (spec.dual && opts.secondHex) { m.iridescence = 0.6; m.iridescenceIOR = 1.6; m.sheenColor = new THREE.Color(opts.secondHex); m.sheen = 0.8; }
    if (spec.transmission > 0) m.side = THREE.DoubleSide;
    return m;
  };
  return [
    mk(spec.roughness, maps.wall, maps.wallRough),
    mk(Math.max(0.05, spec.roughness * (1 - spec.topGloss * 2)), maps.top, maps.topRough),
    // bed side: smooth PEI copies its finish (glossy on smooth sheets)
    mk(Math.max(0.06, spec.roughness * 0.55), maps.bottom),
  ];
}
