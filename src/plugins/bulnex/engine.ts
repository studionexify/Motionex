// Bulnex engine side: measures the parts in prepare(), reports the push plan, and turns the print body
// into one file with N cycles — print, cool the bed, sweep the row off the front edge, re-heat, repeat.
// Homing, levelling and the purge line run once (start G-code); nothing between cycles needs a person.
import type { EnginePlugin, PluginSession } from '../api';
import { areaTotal, bounds, pointIn, SCALE } from '../../engine/clipper';
import {
  A1_CURRENT, APPROACH_GAP, checkParts, cycleParts, planRow, PUSH_END_Y, pushZFor,
  type BulnexConfig, type BulnexReport, type PartGeometry, type PushRow,
} from './model';

interface BulnexSession extends PluginSession { parts: PartGeometry[]; row: PushRow | null }

const f1 = (v: number) => (Math.round(v * 100) / 100).toString();

/** Lines that eject the finished row (and, except after the last cycle, get ready for the next one). */
export function ejectBlock(cfg: BulnexConfig, row: PushRow, opts: { cycle: number; last: boolean; safeZ: number; bedTemp: number; nozzleTemp: number; retract: number }): string[] {
  const k = Math.max(0.2, Math.min(1, cfg.currentFraction));
  const out = [
    `; ===== BULNEX eject: cycle ${opts.cycle} of ${cfg.cycles} =====`,
    'M83 ; relative E (each cycle body sets its own mode again)',
    `G1 E-${f1(opts.retract)} F1800 ; retract`,
    'G91', 'G1 Z2 F900', 'G90',
    `G1 Z${f1(opts.safeZ)} F900 ; clear the parts`,
    `M140 S${Math.round(cfg.releaseBedTemp)} ; cool the bed to release the parts`,
    cfg.nozzleStandbyTemp > 0 ? `M104 S${Math.round(cfg.nozzleStandbyTemp)} ; nozzle standby` : 'M104 S0',
    cfg.fanDuringCool ? 'M106 S255 ; fan helps the bed cool' : 'M107',
    `G1 X${f1(row.x)} Y${f1(row.startY)} F12000 ; park behind the row`,
    'M400',
  ];
  // wait in 60 s steps so the printer keeps reporting progress
  let wait = Math.round(cfg.coolWaitMin * 60);
  while (wait > 0) { const s = Math.min(60, wait); out.push(`G4 S${s}`); wait -= s; }
  out.push('M107');
  out.push(`M17 X${f1(A1_CURRENT.x * k)} Y${f1(A1_CURRENT.y * k)} Z${f1(A1_CURRENT.z)} ; reduced current: a stuck part skips the motor instead of the plate`);
  const v = Math.round(Math.max(1, cfg.pushSpeed) * 60);
  for (let p = 1; p <= Math.max(1, cfg.passes); p++) {
    out.push(`; push ${p} of ${cfg.passes}`);
    out.push(`G1 Z${f1(opts.safeZ)} F900`, `G1 X${f1(row.x)} Y${f1(row.startY)} F12000`, `G1 Z${f1(row.z)} F600`, `G1 Y${f1(PUSH_END_Y)} F${v}`, 'M400');
  }
  out.push(`M17 X${A1_CURRENT.x} Y${A1_CURRENT.y} Z${A1_CURRENT.z} ; normal current`);
  out.push(`G1 Z${f1(opts.safeZ)} F900`);
  if (opts.last) { out.push('; ===== BULNEX: all cycles done ====='); return out; }
  // re-heat at the front edge: whatever oozes drops off the plate into the bin
  out.push(
    `M140 S${opts.bedTemp}`, `M104 S${opts.nozzleTemp}`,
    `G1 X${f1(row.x)} Y${f1(PUSH_END_Y)} F12000`, 'G1 Z1 F900',
    `M190 S${opts.bedTemp} ; re-heat the bed`, `M109 S${opts.nozzleTemp} ; re-heat the nozzle`,
    'G92 E0', `G1 E${f1(opts.retract + 1.5)} F300 ; prime over the edge`, `G1 E-${f1(opts.retract)} F1800`,
    `G1 Z${f1(opts.safeZ)} F900`, `G1 E${f1(opts.retract)} F1800`, 'G92 E0',
    `; ===== BULNEX cycle ${opts.cycle + 1} of ${cfg.cycles} =====`,
  );
  return out;
}

/** Calibration: cool once, then push every block on its own (smallest first) and pause so the result can be noted. */
export function calibrationBlock(cfg: BulnexConfig, parts: PartGeometry[], opts: { safeZ: number; retract: number; pause: string }): string[] {
  const k = Math.max(0.2, Math.min(1, cfg.currentFraction));
  const v = Math.round(Math.max(1, cfg.pushSpeed) * 60);
  const out = [
    '; ===== BULNEX calibration: release ladder =====', 'M83',
    `G1 E-${f1(opts.retract)} F1800`, 'G91', 'G1 Z2 F900', 'G90', `G1 Z${f1(opts.safeZ)} F900`,
    `M140 S${Math.round(cfg.releaseBedTemp)} ; cool the bed to release the parts`, 'M104 S0',
    cfg.fanDuringCool ? 'M106 S255' : 'M107', 'M400',
  ];
  let wait = Math.round(cfg.coolWaitMin * 60);
  while (wait > 0) { const s = Math.min(60, wait); out.push(`G4 S${s}`); wait -= s; }
  out.push('M107');
  [...parts].sort((a, b) => a.contactArea - b.contactArea).forEach((p, i) => {
    const x = (p.minX + p.maxX) / 2, y0 = p.maxY + APPROACH_GAP, z = pushZFor(p.height, cfg.pushHeightPct);
    out.push(`; block ${i + 1}: ${p.name}, ${Math.round(p.contactArea)} mm²`);
    out.push(`M17 X${f1(A1_CURRENT.x * k)} Y${f1(A1_CURRENT.y * k)} Z${f1(A1_CURRENT.z)}`);
    for (let n = 0; n < Math.max(1, cfg.passes); n++) out.push(`G1 Z${f1(opts.safeZ)} F900`, `G1 X${f1(x)} Y${f1(y0)} F6000`, `G1 Z${f1(z)} F600`, `G1 Y${f1(PUSH_END_Y)} F${v}`, 'M400');
    out.push(`M17 X${A1_CURRENT.x} Y${A1_CURRENT.y} Z${A1_CURRENT.z}`, `G1 Z${f1(opts.safeZ)} F900`, 'G1 X128 Y200 F6000 ; out of the camera view');
    out.push(`; note whether ${p.name} released, then resume`, opts.pause);
  });
  out.push('; ===== BULNEX calibration done =====');
  return out;
}

export const bulnexEngine: EnginePlugin<BulnexConfig, BulnexReport> = {
  id: 'bulnex', name: 'Bulnex', version: '1.0.0',

  prepare(config, ctx) {
    const parts: PartGeometry[] = ctx.meshes.map((m, o) => {
      const v = m.vertices;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < v.length; i += 3) {
        if (v[i] < minX) minX = v[i]; if (v[i] > maxX) maxX = v[i];
        if (v[i + 1] < minY) minY = v[i + 1]; if (v[i + 1] > maxY) maxY = v[i + 1];
        if (v[i + 2] > maxZ) maxZ = v[i + 2];
      }
      return { name: m.name, minX, maxX, minY, maxY, height: maxZ, contactArea: areaTotal(ctx.sliceAt(o, 0)), hitAtPush: true, widthAtPush: maxX - minX };
    });
    const row = planRow(parts, config);
    if (row) {
      // the cross-section each part shows to the nozzle at the push height
      let li = 0;
      for (let i = 0; i < ctx.layerZ.length; i++) if (Math.abs(ctx.layerZ[i] - row.z) < Math.abs(ctx.layerZ[li] - row.z)) li = i;
      parts.forEach((p, o) => {
        const sl = ctx.sliceAt(o, li);
        if (!sl.length) { p.hitAtPush = false; p.widthAtPush = 0; return; }
        const b = bounds(sl);
        p.widthAtPush = (b.maxX - b.minX) / SCALE;
        let hit = false;
        for (let y = b.minY / SCALE; y <= b.maxY / SCALE && !hit; y += 0.2) hit = pointIn(row.x, y, sl);
        p.hitAtPush = hit;
      });
    }
    const s: BulnexSession = { parts, row };
    return s;
  },

  postToolpath(_layers, config, ctx) {
    const s = ctx.session as BulnexSession | undefined;
    const parts = s?.parts ?? [];
    const row = s?.row ?? null;
    const checks = checkParts(parts, config, String(ctx.cfg.filament_type ?? ''), Number(ctx.cfg.bed_y ?? 256));
    for (const c of checks) if (c.level === 'warn') ctx.warn(`Bulnex: ${c.text}`);
    const parts3 = cycleParts(config, row, Number(ctx.cfg.bed_temperature_initial_layer ?? 60));
    return { parts, row, checks, cycles: config.cycles, cycleOverheadS: parts3.coolS + parts3.pushS + parts3.reheatS, ...parts3, calibration: !!config.calibration };
  },

  programBody(body, config, ctx) {
    const s = ctx.session as BulnexSession | undefined;
    if (!s?.row || config.cycles < 1) return body;
    const cfg = ctx.cfg;
    const num = (k: string, d: number) => { const v = Number(cfg[k]); return isFinite(v) && v > 0 ? v : d; };
    const tallest = Math.max(...s.parts.map((p) => p.height));
    const safeZ = Math.min(num('bed_z', 256), tallest + 10);
    const base = { safeZ, bedTemp: num('bed_temperature_initial_layer', 60), nozzleTemp: num('nozzle_temperature_initial_layer', 220), retract: num('retraction_length', 0.8) };
    if (config.calibration) return body.concat(calibrationBlock(config, s.parts, { safeZ, retract: base.retract, pause: String(cfg.machine_pause_gcode || 'M400 U1') }));
    const out: string[] = [];
    for (let c = 1; c <= config.cycles; c++) {
      for (const l of body) out.push(l);
      out.push(...ejectBlock(config, s.row, { ...base, cycle: c, last: c === config.cycles }));
    }
    return out;
  },

  gcodeHeader(config) {
    return [`; bulnex_cycles = ${config.cycles}`, `; bulnex_release_bed_temp = ${config.releaseBedTemp}`, `; bulnex_push_passes = ${config.passes}`];
  },
};
