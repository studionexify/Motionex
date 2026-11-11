// Built-in sample designs (drawn here, no third-party artwork): small SVGs in a 100 × 100 box, plus the
// NexSpiro mark, built from its own stroke paths.
import { artFromSvg, tidy, type Art } from './art';
import { toPaths } from './geom';
import { pathSubpaths } from '../patternex/svg';
import { solidRings, strokeLines } from '../patternex/tools/shape';

export interface Sample { id: string; name: string; svg?: string; make?: () => Art }

const star5 = Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + (i / 10) * Math.PI * 2, r = i % 2 ? 19 : 46; return `${(50 + r * Math.cos(a)).toFixed(1)},${(52 + r * Math.sin(a)).toFixed(1)}`; }).join(' ');

const nexspiro = (): Art => {
  const paths = [
    'M690 1395 C620 1210 606 1050 608 930 C612 700 740 538 868 538 C930 538 990 562 1035 602',
    'M880 960 C845 1140 860 1370 1020 1370 C1180 1370 1182 1160 1182 1060 C1182 900 1155 760 1100 655',
    'M1325 537 C1090 580 905 760 880 960',
  ];
  const lines = paths.flatMap((d) => pathSubpaths(d, 2).map((s) => s.pts.map(([x, y]) => [x, -y] as [number, number])));
  return tidy([{ color: '#3e9a7a', paths: toPaths(solidRings(strokeLines(lines, 142))) }]);
};

export const SAMPLES: Sample[] = [
  { id: 'nexspiro', name: 'NexSpiro', make: nexspiro },
  { id: 'heart', name: 'Heart', svg: `<svg viewBox="0 0 100 100"><path d="M50 90 C8 60 4 30 24 19 C38 11 50 23 50 31 C50 23 62 11 76 19 C96 30 92 60 50 90Z" fill="#e85d4a"/><ellipse cx="28" cy="31" rx="7" ry="4" fill="#ffd0c8" transform="rotate(-38 28 31)"/></svg>` },
  { id: 'star', name: 'Star', svg: `<svg viewBox="0 0 100 100"><polygon points="${star5}" fill="#f2c14e"/></svg>` },
  { id: 'ghost', name: 'Ghost', svg: `<svg viewBox="0 0 100 100"><path d="M18 92 V46 A32 32 0 0 1 82 46 V92 L71 81 L60 92 L50 81 L40 92 L29 81 Z" fill="#cfd8e6"/><ellipse cx="38" cy="46" rx="5.5" ry="7.5" fill="#2f2f33"/><ellipse cx="62" cy="46" rx="5.5" ry="7.5" fill="#2f2f33"/><ellipse cx="50" cy="64" rx="6" ry="8" fill="#2f2f33"/></svg>` },
  { id: 'pumpkin', name: 'Pumpkin', svg: `<svg viewBox="0 0 100 100"><path d="M46 24 C46 14 52 10 58 8 L60 13 C56 15 54 19 54 24Z" fill="#5dbe7a"/><ellipse cx="50" cy="58" rx="42" ry="33" fill="#f28c28"/><polygon points="28,48 40,48 34,36" fill="#2f2f33"/><polygon points="60,48 72,48 66,36" fill="#2f2f33"/><polygon points="26,66 36,74 44,66 50,76 56,66 64,74 74,66 70,82 30,82" fill="#2f2f33"/></svg>` },
  { id: 'cat', name: 'Cat', svg: `<svg viewBox="0 0 100 100"><polygon points="14,12 42,28 18,52" fill="#f2c14e"/><polygon points="86,12 58,28 82,52" fill="#f2c14e"/><ellipse cx="50" cy="58" rx="38" ry="32" fill="#f2c14e"/><ellipse cx="36" cy="54" rx="5" ry="7" fill="#2f2f33"/><ellipse cx="64" cy="54" rx="5" ry="7" fill="#2f2f33"/><polygon points="44,66 56,66 50,73" fill="#ff5c8d"/></svg>` },
  { id: 'smile', name: 'Smiley', svg: `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="#f2c14e"/><circle cx="35" cy="40" r="6" fill="#2f2f33"/><circle cx="65" cy="40" r="6" fill="#2f2f33"/><path d="M26 58 Q50 86 74 58 Q50 70 26 58Z" fill="#2f2f33"/></svg>` },
  { id: 'skull', name: 'Skull', svg: `<svg viewBox="0 0 100 100"><path d="M50 8 C24 8 12 26 12 46 C12 60 20 66 28 70 V86 H72 V70 C80 66 88 60 88 46 C88 26 76 8 50 8Z" fill="#d9d4cc"/><ellipse cx="34" cy="50" rx="9" ry="10" fill="#2f2f33"/><ellipse cx="66" cy="50" rx="9" ry="10" fill="#2f2f33"/><polygon points="50,60 44,72 56,72" fill="#2f2f33"/><rect x="38" y="76" width="5" height="10" fill="#2f2f33"/><rect x="48" y="76" width="5" height="10" fill="#2f2f33"/><rect x="58" y="76" width="5" height="10" fill="#2f2f33"/></svg>` },
  { id: 'bolt', name: 'Bolt', svg: `<svg viewBox="0 0 100 100"><polygon points="58,4 18,56 44,56 36,96 82,40 54,40" fill="#f2c14e"/></svg>` },
  { id: 'mushroom', name: 'Mushroom', svg: `<svg viewBox="0 0 100 100"><path d="M38 90 C38 72 40 62 36 56 H64 C60 62 62 72 62 90Z" fill="#ece3d3"/><path d="M6 56 C6 28 26 10 50 10 C74 10 94 28 94 56Z" fill="#e85d4a"/><circle cx="32" cy="38" r="8" fill="#ffffff"/><circle cx="62" cy="30" r="6" fill="#ffffff"/><circle cx="72" cy="46" r="7" fill="#ffffff"/></svg>` },
  { id: 'paw', name: 'Paw', svg: `<svg viewBox="0 0 100 100"><ellipse cx="50" cy="66" rx="24" ry="20" fill="#7a4b2b"/><ellipse cx="22" cy="42" rx="9" ry="12" fill="#7a4b2b" transform="rotate(-20 22 42)"/><ellipse cx="40" cy="26" rx="9" ry="13" fill="#7a4b2b" transform="rotate(-6 40 26)"/><ellipse cx="60" cy="26" rx="9" ry="13" fill="#7a4b2b" transform="rotate(6 60 26)"/><ellipse cx="78" cy="42" rx="9" ry="12" fill="#7a4b2b" transform="rotate(20 78 42)"/></svg>` },
  { id: 'gamepad', name: 'Gamepad', svg: `<svg viewBox="0 0 100 100"><path d="M22 28 H78 C90 28 96 44 94 62 C92 76 82 78 76 70 L68 60 H32 L24 70 C18 78 8 76 6 62 C4 44 10 28 22 28Z" fill="#3d7ddb"/><rect x="22" y="39" width="16" height="5" fill="#ffffff"/><rect x="27.5" y="33.5" width="5" height="16" fill="#ffffff"/><circle cx="70" cy="46" r="4" fill="#f2c14e"/><circle cx="80" cy="40" r="4" fill="#e85d4a"/></svg>` },
];

export const sampleArt = (id: string): Art => {
  const s = SAMPLES.find((x) => x.id === id) ?? SAMPLES[0];
  return s.make ? s.make() : artFromSvg(s.svg!).art;
};
