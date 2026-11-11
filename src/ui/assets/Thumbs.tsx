// Illustrated thumbnails for the printer and build-plate cards (inline SVG, no image files).
import type { PlateType, PrinterProfile } from '../../profiles/printers';

type Look = 'enclosed' | 'bedslinger' | 'corexy' | 'cframe';

/** What the machine looks like, from its profile. */
export function printerLook(p: PrinterProfile): Look {
  if (/^bbl-a1/.test(p.id)) return 'cframe';
  if (/p1s|x1|h2d|voron|qidi|k1|k2|centauri|coreone|sv08|artillery/.test(p.id)) return 'enclosed';
  if (/ender|neptune|kobra|sv06|sv07|mk3|mini|mk4|cr10/.test(p.id)) return 'bedslinger';
  return 'corexy';
}

const BRAND: Record<string, string> = { 'Bambu Lab': '#00AE42', Creality: '#1E88E5', Elegoo: '#2D3A8C', Prusa: '#FA6831', Anycubic: '#1E5BD6', Voron: '#D93025', Qidi: '#2D7BE5', Sovol: '#E8453C', Artillery: '#222' };

export function PrinterThumb({ printer, size = 76 }: { printer: PrinterProfile; size?: number }) {
  const look = printerLook(printer);
  const accent = BRAND[printer.vendor] ?? '#6c8aa0';
  const body = '#2b3540', light = '#3d4b59', glass = 'rgba(160,200,230,0.28)';
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" role="img" aria-label={`${printer.vendor} ${printer.model}`}>
      <ellipse cx="40" cy="72" rx="28" ry="4" fill="rgba(0,0,0,0.18)" />
      {look === 'enclosed' && <>
        <rect x="12" y="10" width="56" height="58" rx="5" fill={body} />
        <rect x="16" y="14" width="48" height="44" rx="3" fill={glass} stroke={light} strokeWidth="1.5" />
        <rect x="12" y="60" width="56" height="8" rx="3" fill={light} />
        <rect x="34" y="62.5" width="12" height="3" rx="1.5" fill={accent} />
        <rect x="22" y="48" width="36" height="3" rx="1" fill="#8aa2b4" />
        <rect x="34" y="40" width="12" height="8" rx="1.5" fill={accent} opacity="0.9" />
        <rect x="19" y="23" width="42" height="2.5" rx="1" fill="#9db4c4" />
      </>}
      {look === 'cframe' && <>
        <rect x="14" y="60" width="52" height="9" rx="3" fill={body} />
        <rect x="20" y="56" width="40" height="4" rx="1.5" fill="#8aa2b4" />
        <rect x="55" y="12" width="9" height="50" rx="3" fill={body} />
        <rect x="16" y="14" width="46" height="7" rx="2.5" fill={light} />
        <rect x="30" y="21" width="12" height="9" rx="2" fill={accent} />
        <rect x="34" y="30" width="4" height="5" rx="1" fill="#cfd8de" />
        <rect x="48" y="62" width="10" height="3" rx="1.5" fill={accent} />
      </>}
      {look === 'bedslinger' && <>
        <rect x="12" y="58" width="56" height="10" rx="3" fill={body} />
        <rect x="16" y="52" width="40" height="5" rx="1.5" fill="#8aa2b4" />
        <rect x="14" y="12" width="6" height="46" rx="2" fill={light} />
        <rect x="52" y="12" width="6" height="46" rx="2" fill={light} />
        <rect x="14" y="10" width="44" height="6" rx="2" fill={body} />
        <rect x="30" y="16" width="12" height="9" rx="2" fill={accent} />
        <rect x="34" y="25" width="4" height="5" rx="1" fill="#cfd8de" />
      </>}
      {look === 'corexy' && <>
        <rect x="12" y="60" width="56" height="9" rx="3" fill={body} />
        <rect x="16" y="54" width="48" height="5" rx="1.5" fill="#8aa2b4" />
        <rect x="12" y="10" width="5" height="52" rx="2" fill={light} />
        <rect x="63" y="10" width="5" height="52" rx="2" fill={light} />
        <rect x="12" y="10" width="56" height="5" rx="2" fill={body} />
        <rect x="12" y="62" width="56" height="3" fill={accent} opacity="0.7" />
        <rect x="34" y="18" width="12" height="10" rx="2" fill={accent} />
        <rect x="38" y="28" width="4" height="6" rx="1" fill="#cfd8de" />
      </>}
    </svg>
  );
}

const PLATE_LOOK: Record<PlateType, { base: string; edge: string; texture: 'pei' | 'smooth' | 'cool' | 'eng' | 'high' }> = {
  textured_pei_plate: { base: '#c8a465', edge: '#a8843f', texture: 'pei' },
  high_temp_plate: { base: '#d9b873', edge: '#b8963f', texture: 'smooth' },
  cool_plate: { base: '#6d90b8', edge: '#4d709a', texture: 'cool' },
  engineering_plate: { base: '#8f8f93', edge: '#6c6c70', texture: 'eng' },
  supertack_plate: { base: '#4f6f8f', edge: '#3a5675', texture: 'cool' },
  textured_cool_plate: { base: '#7d9cc0', edge: '#5d7ca0', texture: 'pei' },
};

export function PlateThumb({ type, size = 76 }: { type: PlateType; size?: number }) {
  const l = PLATE_LOOK[type] ?? PLATE_LOOK.textured_pei_plate;
  const id = `pt-${type}`;
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" role="img" aria-label={type.replace(/_/g, ' ')}>
      <defs>
        <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse">
          {l.texture === 'pei' && <><circle cx="1" cy="1" r="0.7" fill="rgba(0,0,0,0.28)" /><circle cx="3" cy="3" r="0.7" fill="rgba(255,255,255,0.3)" /></>}
          {l.texture === 'smooth' && <rect width="4" height="4" fill="rgba(255,255,255,0.06)" />}
          {l.texture === 'cool' && <path d="M0 4 4 0" stroke="rgba(255,255,255,0.22)" strokeWidth="0.8" />}
          {l.texture === 'eng' && <><path d="M0 2h4" stroke="rgba(0,0,0,0.2)" strokeWidth="0.7" /><path d="M2 0v4" stroke="rgba(255,255,255,0.18)" strokeWidth="0.5" /></>}
        </pattern>
      </defs>
      <ellipse cx="40" cy="66" rx="30" ry="5" fill="rgba(0,0,0,0.18)" />
      <path d="M10 34 40 22l30 12v14L40 60 10 48z" fill={l.edge} />
      <path d="M10 34 40 22l30 12-30 12z" fill={l.base} />
      <path d="M10 34 40 22l30 12-30 12z" fill={`url(#${id})`} />
      {l.texture === 'smooth' && <path d="M22 33 40 26l8 3-20 9z" fill="rgba(255,255,255,0.28)" />}
      <rect x="60" y="40" width="8" height="2.5" rx="1" fill="rgba(0,0,0,0.35)" transform="rotate(22 64 41)" />
    </svg>
  );
}
