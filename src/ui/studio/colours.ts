// Colour library for the Studio filament picker: common filament colours by material and colour family.
// Plain data; picking one sets a slot's colour (and its material preset when one exists).
export interface LibraryColour { name: string; hex: string; material: string; family: string }

export const MATERIALS: { id: string; name: string; presetId: string }[] = [
  { id: 'pla', name: 'PLA', presetId: 'generic-pla' },
  { id: 'pla-matte', name: 'PLA Matte', presetId: 'generic-pla-matte' },
  { id: 'petg', name: 'PETG', presetId: 'generic-petg' },
];

const C = (material: string, family: string, list: [string, string][]): LibraryColour[] => list.map(([name, hex]) => ({ name, hex, material, family }));

export const LIBRARY_COLOURS: LibraryColour[] = [
  ...C('pla-matte', 'Whites & neutrals', [['Ivory White', '#EDE6D6'], ['Bone', '#E3DAC6'], ['Desert Tan', '#D9CBB0'], ['Latte Brown', '#C7A27E'], ['Ash Grey', '#9CA3AF'], ['Charcoal', '#2B2B2E']]),
  ...C('pla', 'Whites & neutrals', [['Pure White', '#F5F5F2'], ['Light Grey', '#C9CCD1'], ['Silver', '#A7AAB0'], ['Black', '#151517']]),
  ...C('pla-matte', 'Browns', [['Dark Brown', '#6B4A36'], ['Cocoa', '#5B3A29'], ['Caramel', '#A86B3C']]),
  ...C('pla-matte', 'Reds & pinks', [['Marsala Red', '#8E1B2C'], ['Scarlet', '#B91C1C'], ['Terracotta', '#C2410C'], ['Sakura Pink', '#F4A6C6'], ['Dusty Rose', '#C98B8B']]),
  ...C('pla', 'Reds & pinks', [['Red', '#D32F2F'], ['Magenta', '#C2185B'], ['Hot Pink', '#F06292']]),
  ...C('pla', 'Oranges & yellows', [['Orange', '#EF6C00'], ['Sunflower', '#F9A825'], ['Lemon', '#F2D64B']]),
  ...C('pla-matte', 'Oranges & yellows', [['Mandarin', '#E85D3F'], ['Mustard', '#C99A2E']]),
  ...C('pla-matte', 'Greens', [['Grass Green', '#65A30D'], ['Dark Green', '#2F5D3A'], ['Sage', '#A3B18A'], ['Olive', '#6B7038']]),
  ...C('pla', 'Greens', [['Green', '#2E9D57'], ['Mint', '#8FD9B6']]),
  ...C('pla-matte', 'Blues', [['Ice Blue', '#A9D6F2'], ['Ocean Teal', '#1F6F78'], ['Marine Blue', '#1E3A8A'], ['Navy', '#0F2547']]),
  ...C('pla', 'Blues', [['Cyan', '#2F87C9'], ['Blue', '#1E5BD8'], ['Turquoise', '#14B8A6']]),
  ...C('pla-matte', 'Purples', [['Lilac', '#B9A2E8'], ['Plum', '#6E2C5E']]),
  ...C('pla', 'Purples', [['Purple', '#6D28D9']]),
  ...C('petg', 'Whites & neutrals', [['PETG White', '#F2F2EE'], ['PETG Black', '#18181A'], ['Translucent', '#DDE5EA']]),
  ...C('petg', 'Blues', [['PETG Blue', '#2563EB']]),
  ...C('petg', 'Reds & pinks', [['PETG Red', '#C62828']]),
];
