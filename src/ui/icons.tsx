// Minimal stroke icon set (24px grid, currentColor).
import type { SVGProps } from 'react';

export const ICON_PATHS: Record<string, string> = {
  add: 'M12 5v14M5 12h14',
  edges: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  ears: 'M8 8h8v8H8zM8 8a3 3 0 1 0-3 3M16 8a3 3 0 1 1 3 3M8 16a3 3 0 1 1-3-3M16 16a3 3 0 1 0 3-3',
  file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5',
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  save: 'M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 3v6h9V3M7 21v-7h10v7',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'm15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
  orient: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  arrange: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  move: 'M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3',
  rotate: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  scale: 'M4 14v6h6M20 10V4h-6M4 20 20 4',
  face: 'M3 17l9 4 9-4M3 12l9 4 9-4M12 3 3 7l9 4 9-4z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  slice: 'M3 6h18M3 12h18M3 18h18',
  print: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M8 14h8v7H8z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.9 8.3 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 4.2-.9',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  reset: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  moon: 'M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z',
  home: 'M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  cube: 'M12 2 3 7v10l9 5 9-5V7zM3 7l9 5 9-5M12 12v10',
  layers: 'M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 18l10 5 10-5',
  device: 'M4 4h16v12H4zM8 20h8M12 16v4',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  gauge: 'M12 14l4-4M3.5 17a9 9 0 1 1 17 0',
  quality: 'M4 6h16M4 10h16M4 14h16M4 18h16',
  strength: 'M12 3 4 7.5v9L12 21l8-4.5v-9zM12 12 4 7.5M12 12l8-4.5M12 12v9',
  speed: 'M12 14l4-4M3.5 17a9 9 0 1 1 17 0',
  support: 'M4 4h16M6 4v16M12 4v16M18 4v16',
  others: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  overhang: 'M4 20h16M7 20V10l10-6v6',
  chevron: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  minus: 'M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  info: 'M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  warn: 'M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  calib: 'M4 20 20 4M7 20v-3M11 20v-5M15 20v-7M19 20v-9',
  wifi: 'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01',
  filament: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  printer: 'M5 3h14v4H5zM3 7h18v10H3zM7 17v4h10v-4M7 12h4',
  plate: 'M3 17l9 4 9-4-9-4zM12 13V3',
  view: 'M12 2 3 7v10l9 5 9-5V7z',
  brushSupport: 'M4 20h16M7 20v-6M12 20v-9M17 20v-6M4 9l8-6 8 6',
  brushSeam: 'M12 3v18M8 7l4-4 4 4M6 21h12',
  brushColor: 'M18 3a3 3 0 0 1 3 3c0 4-9 11-9 11l-3-3S14 3 18 3zM9 14l-3 3a3 3 0 0 0-3 4 3 3 0 0 0 4-3l3-3',
  vlh: 'M4 4h16M4 8h16M4 11h16M4 13h16M4 15h16M4 18h16M4 21h16',
  cut: 'M6 6a3 3 0 1 0 0 .01M6 18a3 3 0 1 0 0 .01M8.1 8.1 20 20M8.1 15.9 20 4M2 12h4M10 12h2',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  measure: 'M3 17 17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2',
  boolean: 'M9 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM15 8a6 6 0 1 1 0 12 6 6 0 0 1 0-12z',
  addPlate: 'M3 9h12M3 15h12M9 3v18M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6M3 5v14a2 2 0 0 0 2 2h7M18 15v6M15 18h6',
  split: 'M4 4h7v7H4zM13 13h7v7h-7zM15 4h5v5M9 15H4v5',
  unlock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 7.5-2',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  flush: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11zM9 15a3 3 0 0 0 3 3',
  atom: 'M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM12 3c4.4 0 8 4 8 9s-3.6 9-8 9-8-4-8-9 3.6-9 8-9zM4.2 7.5c2.2-3.8 7.8-3.5 12.4.7s6.5 9.6 4.2 13.3c-2.2 3.8-7.8 3.5-12.4-.7S1.9 11.3 4.2 7.5z',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6zM9 12l2 2 4-4',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  lamp: 'M8 3h8l3 8H5zM12 11v7M8 21h8M9 15l-3 3M15 15l3 3',
  wave: 'M2 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0M2 17c2-3 4-3 6 0s4 3 6 0 4-3 6 0M2 7c2-3 4-3 6 0s4 3 6 0 4-3 6 0',
  morph: 'M3 17h18M5 17c2-6 5-9 7-9s5 3 7 9M8 21l4-4 4 4',
  graph: 'M5 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM19 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5 6l7 12M19 6l-7 12M7 4h10',
  heat: 'M4 20V10M9 20V4M14 20v-8M19 20V7M3 20h18',
  brushAdv: 'M18 3l3 3-9 9-3-3zM9 12l-4 4a2.8 2.8 0 0 0 0 4 2.8 2.8 0 0 0 4 0l4-4M14 7l3 3',
  // ---- toolbar (Bambu-like, bolder)
  addCube: 'M13 21 4 16.5v-9L12 3l8 4.5V12M4 7.5l8 4.5 8-4.5M12 12v9M18 15v6M15 18h6',
  addPlateB: 'M3 7h11M3 13h11M8.5 3v13M3 4.5A1.5 1.5 0 0 1 4.5 3h8A1.5 1.5 0 0 1 14 4.5V16M3 4.5V19a2 2 0 0 0 2 2h6M18 14v7M14.5 17.5h7',
  autoOrient: 'M12 3l2 3h-4zM12 21l-2-3h4zM3 12l3-2v4zM21 12l-3-2v4zM8 8h8v8H8z',
  arrangeB: 'M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z',
  splitB: 'M3 3h8v8H3zM13 13h8v8h-8zM15 3h6v6M9 15H3v6',
  vlhB: 'M3 4h12M3 8h8M3 12h14M3 16h6M3 20h10M19 4v16M16.5 6.5 19 4l2.5 2.5M16.5 17.5 19 20l2.5-2.5',
  moveB: 'M12 2v20M2 12h20M12 2l-3.5 3.5M12 2l3.5 3.5M12 22l-3.5-3.5M12 22l3.5-3.5M2 12l3.5-3.5M2 12l3.5 3.5M22 12l-3.5-3.5M22 12l-3.5 3.5',
  rotateB: 'M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 3v5.5H15M12 9l3 1.7v3.6L12 16l-3-1.7v-3.6z',
  scaleB: 'M3 21V13M3 21h8M3 21 12 12M21 3v8M21 3h-8M21 3 12 12M7 7h4v4H7z',
  faceB: 'M12 3 3.5 7.5 12 12l8.5-4.5zM3.5 7.5v9L12 21v-9M20.5 7.5v9L12 21',
  cutB: 'M5.5 3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM5.5 16a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM7.5 7.8 21 17M7.5 16.2 21 7M2 12h3M9 12h3M16 12h6',
  booleanB: 'M9 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM15 7a6 6 0 1 1 0 12 6 6 0 0 1 0-12z',
  supportPaint: 'M3 21h18M6 21v-7M12 21v-10M18 21v-7M3 10 12 3l9 7M16 3l5 5-3 3-5-5z',
  seamPaint: 'M12 2v20M7 7l5-5 5 5M7 17l5 5 5-5M4 12h4M16 12h4',
  textB: 'M4 7V4h16v3M12 4v16M8.5 20h7',
  colorPaint: 'M19 3l2 2c1 1 1 2.5 0 3.5L12 17.5l-5.5-5.5L15.5 3C16.5 2 18 2 19 3zM6.5 12 5 13.5c-1.5 1.5-.5 3.5-2 5 2 1 4.5.5 5.5-1L10 16',
  measureB: 'M3 17 17 3l4 4L7 21zM7 13l2.5 2.5M10 10l2.5 2.5M13 7l2.5 2.5',
  earsB: 'M8 8h8v8H8zM8 8a3 3 0 1 0-3.5 3M16 8a3 3 0 1 1 3.5 3M8 16a3 3 0 1 1-3.5-3M16 16a3 3 0 1 0 3.5-3',
  edgesB: 'M12 2.5 20 7v10l-8 4.5L4 17V7zM4 7l8 4.5L20 7M12 11.5v10',
  overhangB: 'M3 21h18M7 21V9l11-6v8M11 14l3-1.5',
  sliceB: 'M4 6h16M4 12h16M4 18h16M8 3v18',
  // ---- context menu
  selectAll: 'M3 3h18v18H3zM8 12l3 3 5-6',
  deleteAll: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  autoRotate: 'M20 12a8 8 0 1 1-2.4-5.7M20 3v5h-5M12 8v4l3 2',
  expandAll: 'M8 9l4-4 4 4M8 15l4 4 4-4',
  collapseAll: 'M8 5l4 4 4-4M8 19l4-4 4 4',
  lockB: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4M12 15v2',
  unlockB: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 7.5-2M12 15v2',
  editName: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4M13 20h8',
  paste: 'M9 4h6v3H9zM8 5.5H5v15h14v-15h-3M9 12h6M9 16h4',
  clone: 'M8 8h12v12H8zM4 16V4h12M14 11v6M11 14h6',
  duplicate: 'M8 8h12v12H8zM4 16V4h12',
  fillBed: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  centre: 'M12 8v8M8 12h8M3 3h4M3 3v4M21 3h-4M21 3v4M3 21h4M3 21v-4M21 21h-4M21 21v-4',
  dropBed: 'M12 3v12M7 10l5 5 5-5M4 21h16',
  mirror: 'M12 3v18M8 7 3 17h5zM16 7l5 10h-5z',
  filamentB: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  printable: 'M6 9V3h12v6M6 18H4v-7h16v7h-2M8 14h8v7H8z',
  moveToPlate: 'M3 17l9 4 9-4-9-4zM12 13V3M8 7l4-4 4 4',
  partAdd: 'M12 3 4 7.5v9L12 21l8-4.5v-9zM12 8v8M8 12h8',
  partNeg: 'M12 3 4 7.5v9L12 21l8-4.5v-9zM8 12h8',
  partMod: 'M12 3 4 7.5v9L12 21l8-4.5v-9zM8 10h8M8 14h8',
  partEnf: 'M4 21h16M6 21l3-8h6l3 8M12 3v7M9 7l3 3 3-3',
  partBlk: 'M4 21h16M6 21l3-8h6l3 8M8 3l8 8M16 3l-8 8',
  heightRange: 'M4 5h16M4 19h16M12 5v14M9 8l3-3 3 3M9 16l3 3 3-3',
  artwork: 'M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2-1.5h3a3 3 0 0 0 3-3C21 7 17 3 12 3zM7.5 11h.01M10 7.5h.01M14.5 7.5h.01',
  motion: 'M3 12h6M3 7h10M3 17h10M17 8l5 4-5 4z',
  exportB: 'M12 3v12M7 8l5-5 5 5M4 15v6h16v-6',
  plus: 'M12 5v14M5 12h14',
  svgFile: 'M7 3h7l5 5v13H7zM14 3v5h5M10 14l1.5 3 1.5-5 1.5 3',
  primitives: 'M3 4h8v8H3zM15 8a4 4 0 1 0 0 .01M6 15l4 6H2z',
  deleteB: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  hexPrism: 'M12 3 4 7.5v9L12 21l8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  sphereI: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  torusI: 'M12 6c5 0 9 2.5 9 6s-4 6-9 6-9-2.5-9-6 4-6 9-6zM12 9.5c2.5 0 4 1 4 2.5s-1.5 2.5-4 2.5S8 13.5 8 12s1.5-2.5 4-2.5z',
  chevronRight: 'M9 6l6 6-6 6',
  palette: 'M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2-1.5h3a3 3 0 0 0 3-3C21 7 17 3 12 3z',
  nozzle: 'M7 3h10v5l-3 3v3l-2 5-2-5v-3L7 8zM9 6h6',
  slicePlay: 'M6 4l14 8-14 8z',
  cancel: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6',
};

export function Icon({ name, size = 18, ...rest }: { name: keyof typeof ICON_PATHS | string; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d={ICON_PATHS[name] ?? ICON_PATHS.info} />
    </svg>
  );
}

/** Small coloured primitive icons for the "Add primitive" menu (Bambu-style). */
const SHAPE_COLORS: Record<string, string> = {
  box: '#1FAA3C', cylinder: '#D93025', sphere: '#D93025', cone: '#A9672B', disc: '#E8453C', torus: '#E39B2D',
  tube: '#C0392B', hemisphere: '#D93025', pyramid: '#7C5CBF', prism: '#B03A5B', capsule: '#E67E22',
};
export function ShapeIcon({ kind, size = 18 }: { kind: string; size?: number }) {
  const c = SHAPE_COLORS[kind] ?? '#888';
  const dark = 'rgba(0,0,0,0.28)';
  const body = (() => {
    switch (kind) {
      case 'box': return <><path d="M12 3 20 7.5v9L12 21 4 16.5v-9z" fill={c} /><path d="M12 12v9L4 16.5v-9z" fill={dark} /><path d="M12 12 4 7.5 12 3l8 4.5z" fill="rgba(255,255,255,0.3)" /></>;
      case 'cylinder': return <><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6z" fill={c} /><path d="M12 9c3.9 0 7-1.3 7-3s-3.1-3-7-3-7 1.3-7 3 3.1 3 7 3z" fill="rgba(255,255,255,0.35)" /></>;
      case 'sphere': return <><circle cx="12" cy="12" r="9" fill={c} /><circle cx="9" cy="9" r="3" fill="rgba(255,255,255,0.35)" /></>;
      case 'cone': return <><path d="M12 3 20 18c0 1.7-3.6 3-8 3s-8-1.3-8-3z" fill={c} /><path d="M12 3 4 18c0 1.7 3.6 3 8 3z" fill={dark} /></>;
      case 'disc': return <><path d="M3 10v4c0 2.2 4 4 9 4s9-1.8 9-4v-4z" fill={c} /><ellipse cx="12" cy="10" rx="9" ry="4" fill="rgba(255,255,255,0.35)" /></>;
      case 'torus': return <><ellipse cx="12" cy="12" rx="9" ry="6" fill="none" stroke={c} strokeWidth="4.5" /></>;
      case 'tube': return <><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6z" fill={c} /><ellipse cx="12" cy="6" rx="7" ry="3" fill="rgba(255,255,255,0.35)" /><ellipse cx="12" cy="6" rx="3.5" ry="1.5" fill="rgba(0,0,0,0.45)" /></>;
      case 'hemisphere': return <><path d="M3 15a9 9 0 0 1 18 0c0 2-4 3.5-9 3.5S3 17 3 15z" fill={c} /><circle cx="9" cy="10" r="2.4" fill="rgba(255,255,255,0.35)" /></>;
      case 'pyramid': return <><path d="M12 3 21 18l-9 3-9-3z" fill={c} /><path d="M12 3 12 21l-9-3z" fill={dark} /></>;
      case 'prism': return <><path d="M4 8l8-4 8 4v10l-8 3-8-3z" fill={c} /><path d="M12 4v17l-8-3V8z" fill={dark} /></>;
      case 'capsule': return <><rect x="7" y="2.5" width="10" height="19" rx="5" fill={c} /><rect x="9" y="5" width="2.5" height="8" rx="1.2" fill="rgba(255,255,255,0.35)" /></>;
      case 'hexPrism': return <><path d="M12 3 20 7.5v9L12 21 4 16.5v-9z" fill="#B03A5B" /><path d="M12 12v9l-8-4.5v-9z" fill={dark} /></>;
      default: return <rect x="4" y="4" width="16" height="16" rx="3" fill={c} />;
    }
  })();
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">{body}</svg>;
}
