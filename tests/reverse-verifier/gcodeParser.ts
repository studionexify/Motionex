/**
 * Streaming G-code line parser for the reverse-verifier.
 *
 * Emits one `GMove` (see mathAssertions.ts, locked) per G0/G1/G2/G3 line. Positions are absolute after the move,
 * E is normalised to a per-move filament delta, F is converted to mm/s. Axis state is tracked across skipped
 * lines (start G-code) so that the first emitted move still starts from the correct position.
 */
import type { GMove } from './mathAssertions';

export interface GcodeHeader {
  hasM82: boolean;
  hasM83: boolean;
  /** Number of source lines. */
  lines: number;
}

export interface ParsedGcode {
  moves: GMove[];
  header: GcodeHeader;
}

const START_END_MARKER_BODY = '===== end of start G-code =====';
const MOTION_TYPES = ['G0', 'G1', 'G2', 'G3'] as const;

export function parseGcode(text: string): ParsedGcode {
  const moves: GMove[] = [];
  let hasM82 = false;
  let hasM83 = false;

  // Axis state. Unspecified axes stay NaN until set (no invented origin).
  let x = NaN;
  let y = NaN;
  let z = NaN;
  let absXYZ = true; // G90 (default) / G91
  let absE = true; // M82 (default) / M83
  let ePos = 0; // E reading in the currently active E coordinate system
  let feedMmMin = 0; // modal F, G-code units (mm/min); 0 until the program sets one

  // Comment-driven state.
  let layer = -1;
  let feature: string | undefined;
  let layerHeight: number | undefined;
  // a filament swap (T<n>) loads fresh filament: the next move carries toolReset so retraction debt does not cross it
  let toolReset = false;

  // Start-G-code skipping: only when the marker is present in the text.
  let emitting = !text.includes(START_END_MARKER_BODY);

  const len = text.length;
  let pos = 0;
  let lineNo = 0;

  while (pos < len) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = len;
    const raw = text.slice(pos, nl);
    pos = nl + 1;
    lineNo++;

    if (/^\s*T\d+\b/.test(raw)) toolReset = true;
    // Split off the comment. Comment directives apply to this line's move too.
    let code = raw;
    const semi = raw.indexOf(';');
    if (semi !== -1) {
      code = raw.slice(0, semi);
      const comment = raw.slice(semi + 1).trim();
      if (comment === START_END_MARKER_BODY) {
        emitting = true;
      } else if (comment.startsWith('LAYER_CHANGE')) {
        layer++;
      } else if (comment.startsWith('TYPE:')) {
        feature = comment.slice('TYPE:'.length).trim();
      } else if (comment.startsWith('HEIGHT:')) {
        const h = Number(comment.slice('HEIGHT:'.length).trim());
        if (Number.isFinite(h)) layerHeight = h;
      } else if (comment.startsWith('LAYER_HEIGHT:')) {
        const h = Number(comment.slice('LAYER_HEIGHT:'.length).trim());
        if (Number.isFinite(h)) layerHeight = h;
      }
    }

    const star = code.indexOf('*'); // checksum suffix
    if (star !== -1) code = code.slice(0, star);
    if (code.trim() === '') continue;

    let motion = -1;
    let hasG92 = false;
    let px: number | undefined;
    let py: number | undefined;
    let pz: number | undefined;
    let pe: number | undefined;
    let pf: number | undefined;
    let pi: number | undefined;
    let pj: number | undefined;

    for (const tok of code.split(/\s+/)) {
      if (tok.length < 2) continue;
      const v = Number(tok.slice(1));
      if (Number.isNaN(v)) continue;
      switch (tok[0].toUpperCase()) {
        case 'G':
          if (v === 0 || v === 1 || v === 2 || v === 3) motion = v;
          else if (v === 90) absXYZ = true;
          else if (v === 91) absXYZ = false;
          else if (v === 92) hasG92 = true;
          break;
        case 'M':
          if (v === 82) { hasM82 = true; absE = true; }
          else if (v === 83) { hasM83 = true; absE = false; }
          break;
        case 'X': px = v; break;
        case 'Y': py = v; break;
        case 'Z': pz = v; break;
        case 'E': pe = v; break;
        case 'F': pf = v; break;
        case 'I': pi = v; break;
        case 'J': pj = v; break;
        default: break; // P and anything else: ignored
      }
    }

    if (pf !== undefined) feedMmMin = pf;

    if (hasG92) {
      if (pe !== undefined) ePos = pe;
      if (px !== undefined) x = px;
      if (py !== undefined) y = py;
      if (pz !== undefined) z = pz;
    }

    if (motion < 0) continue;

    const nx = px === undefined ? x : absXYZ ? px : x + px;
    const ny = py === undefined ? y : absXYZ ? py : y + py;
    const nz = pz === undefined ? z : absXYZ ? pz : z + pz;

    let de = 0;
    if (pe !== undefined) {
      if (absE) {
        de = pe - ePos;
        ePos = pe;
      } else {
        de = pe;
        ePos += pe;
      }
    }

    // "Position changed" only counts axes that already had a known value.
    const moved =
      (Number.isFinite(x) && nx !== x) ||
      (Number.isFinite(y) && ny !== y) ||
      (Number.isFinite(z) && nz !== z);

    x = nx;
    y = ny;
    z = nz;

    if (!emitting) continue;

    const move: GMove = {
      type: MOTION_TYPES[motion],
      x: nx,
      y: ny,
      z: nz,
      e: de,
      f: feedMmMin / 60,
      isExtruding: de > 0 && moved,
      layerIndex: layer < 0 ? 0 : layer,
      line: lineNo,
    };
    if (motion === 2 || motion === 3) {
      if (pi !== undefined) move.i = pi;
      if (pj !== undefined) move.j = pj;
    }
    if (feature !== undefined) move.feature = feature;
    if (layerHeight !== undefined) move.layerHeight = layerHeight;
    if (toolReset) { move.toolReset = true; toolReset = false; }
    moves.push(move);
  }

  return { moves, header: { hasM82, hasM83, lines: lineNo } };
}
