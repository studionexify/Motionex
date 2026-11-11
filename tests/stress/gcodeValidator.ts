// Strict G-code validator for the stress suites. Checks the whole program text (not just the moves the reverse
// verifier reads): syntax of every body line, finite numbers, the bed and height envelope, extrusion per mm, the
// size of pure retractions / primes, feed rates, and that the start and end blocks are present.
import type { Config } from '../../src/profiles/settings';
import type { SliceOutput } from '../../src/engine/types';

export interface GcodeIssue { line: number; text: string; problem: string }

const START = ';===== end of start G-code =====';
const END = ';===== NexSpiro end G-code';
/** Firmware commands: G/M/T words (M622.1, G29.1 …) or a Klipper macro (EXCLUDE_OBJECT_START NAME=…). */
const COMMAND = /^(?:[GMT]\d+(?:\.\d+)?|[A-Z][A-Z0-9_]*)$/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;
/** Filament per mm of travel above this is not a printable bead (2 mm × 0.8 mm at 2× flow on 1.75 mm filament ≈ 1.33). */
const MAX_E_PER_MM = 1.5;
/** A retraction or prime longer than this is a runaway E value, not a retraction. */
const MAX_PURE_E = 30;

export interface ValidateOptions {
  /** Printable height (mm); extrusion above it plus a margin is an error. */
  maxZ?: number;
  /** Bed size (mm) for the XY envelope of extruding moves (a few mm of slack). */
  bed?: { x: number; y: number };
  /** Skip the per-mm extrusion ceiling (calibration lines, purge blobs written by plugins). */
  skipFlowCeiling?: boolean;
}

export function validateGcode(gcode: string, o: ValidateOptions = {}): GcodeIssue[] {
  const issues: GcodeIssue[] = [];
  const add = (line: number, text: string, problem: string) => { if (issues.length < 50) issues.push({ line, text, problem }); };
  const lines = gcode.split('\n');
  const s = lines.findIndex((l) => l.startsWith(START));
  const e = lines.findIndex((l) => l.startsWith(END));
  if (s < 0) add(0, '', 'start G-code block (end marker) missing');
  if (e < 0) add(0, '', 'end G-code block missing');
  if (s >= 0 && e >= 0 && e < s) add(e + 1, lines[e], 'end G-code block comes before the start block ends');
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].split(';')[0];
    if (/\b(?:NaN|Infinity|undefined|null)\b/.test(code)) add(i + 1, lines[i], 'non-numeric token');
    if (/\{[^}]*\}|\[[a-z_]+\]/.test(code)) add(i + 1, lines[i], 'unexpanded placeholder');
  }
  // body: strict syntax and the motion envelope
  let absE = false, absXYZ = true;
  let x = NaN, y = NaN, z = NaN, ePos = 0;
  const from = s < 0 ? 0 : s + 1, to = e < 0 ? lines.length : e;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = raw.split(';')[0].trim();
    if (!code) continue;
    const words = code.split(/\s+/);
    let cmd = words[0];
    if (/^N\d+$/.test(cmd)) { words.shift(); cmd = words[0] ?? ''; }
    if (cmd === 'M82') absE = true;
    if (cmd === 'M83') absE = false;
    if (cmd === 'G90') absXYZ = true;
    if (cmd === 'G91') absXYZ = false;
    const inBody = i >= from && i < to;
    if (inBody && !COMMAND.test(cmd)) { add(i + 1, raw, `unknown command "${cmd}"`); continue; }
    if (cmd === 'G92') { for (const w of words.slice(1)) if (w[0] === 'E') ePos = parseFloat(w.slice(1)); continue; }
    if (!/^G[0-3]$/.test(cmd)) continue;
    const args: Record<string, number> = {};
    for (const w of words.slice(1)) {
      const k = w[0], v = w.slice(1);
      if (inBody && (!/^[XYZEFIJRP]$/.test(k) || !NUMBER.test(v))) { add(i + 1, raw, `malformed word "${w}"`); continue; }
      args[k] = parseFloat(v);
    }
    const px = x, py = y;
    if (absXYZ) { if ('X' in args) x = args.X; if ('Y' in args) y = args.Y; if ('Z' in args) z = args.Z; }
    else { if ('X' in args) x += args.X; if ('Y' in args) y += args.Y; if ('Z' in args) z += args.Z; }
    let dE = 0;
    if ('E' in args) { dE = absE ? args.E - ePos : args.E; ePos = absE ? args.E : ePos + args.E; }
    if (!inBody) continue;
    if ('F' in args && !(args.F > 0)) add(i + 1, raw, 'feed rate must be > 0');
    if (Number.isFinite(z) && z < -1e-6) add(i + 1, raw, `Z below the bed (${z})`);
    const moved = Number.isFinite(px) && Number.isFinite(x) ? Math.hypot(x - px, y - py) : 0;
    if (dE > 0 && moved > 0) {
      if (o.maxZ !== undefined && z > o.maxZ + 2) add(i + 1, raw, `extrusion above the printable height (${z} > ${o.maxZ})`);
      if (o.bed && (x < -5 || y < -5 || x > o.bed.x + 5 || y > o.bed.y + 5)) add(i + 1, raw, `extrusion off the bed (${x}, ${y})`);
      if (!o.skipFlowCeiling && moved > 0.05 && cmd !== 'G2' && cmd !== 'G3' && dE / moved > MAX_E_PER_MM) add(i + 1, raw, `extrusion of ${(dE / moved).toFixed(3)} mm filament per mm`);
    }
    if (moved === 0 && Math.abs(dE) > MAX_PURE_E) add(i + 1, raw, `retraction / prime of ${dE.toFixed(2)} mm`);
  }
  return issues;
}

/** Validate a slice result with the envelope of its own config; layer heights must rise unless printing by object. */
export function validateSlice(out: SliceOutput, cfg: Config, o: Omit<ValidateOptions, 'maxZ' | 'bed'> & { allowZReset?: boolean } = {}): GcodeIssue[] {
  const issues = validateGcode(out.gcode, { ...o, maxZ: Number(cfg.printable_height ?? cfg.bed_z ?? 1e9), bed: { x: Number(cfg.bed_x ?? 1e9), y: Number(cfg.bed_y ?? 1e9) } });
  if (!o.allowZReset) for (let i = 1; i < out.layers.length; i++) {
    if (!(out.layers[i].z > out.layers[i - 1].z)) { issues.push({ line: 0, text: '', problem: `layer ${i} at Z ${out.layers[i].z} is not above layer ${i - 1} (${out.layers[i - 1].z})` }); break; }
  }
  for (const L of out.layers) if (!Number.isFinite(L.z) || L.z <= 0) { issues.push({ line: 0, text: '', problem: `layer with invalid Z ${L.z}` }); break; }
  return issues;
}

export const describeIssues = (issues: GcodeIssue[]) => issues.slice(0, 5).map((i) => `L${i.line}: ${i.problem}${i.text ? ` — ${i.text}` : ''}`).join('\n');
