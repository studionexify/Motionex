// Filament units (one nozzle, a swap and a flush per colour change) on every kind of printer: Bambu AMS and
// the Creality CFS / Anycubic ACE Pro flush into a purge chute, the MMU3 and Klipper units (ERCF, BoxTurtle)
// have no chute and flush onto the prime tower. Checked with two boxes in two filaments: a change every layer.
import { describe, expect, it } from 'vitest';
import { slice, slotFromConfig } from '../src/engine/slicer';
import { weld } from '../src/engine/mesh';
import { resolveConfig } from '../src/profiles/resolve';
import { printerById, PRINTERS } from '../src/profiles/printers';
import { changerOf, flushesIntoTower, purgeTarget, slotCount } from '../src/profiles/changer';
import type { Config } from '../src/profiles/settings';
import type { MeshInput } from '../src/engine/types';
import { bambuFlushes, box, cylinder } from './fixtures';
import { defaultToolhead } from '../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../src/plugins/motionex/modifier';
import type { MotionexConfig } from '../src/plugins/motionex/engine';
import { defaultWeave, type WeaveSettings } from '../src/plugins/motionex/weave/model';
import { motifImage } from '../src/plugins/motionex/weave/motifs';
import { weavePrintSettings } from '../src/plugins/motionex/weave/plan';

const UNITS: { id: string; purge: 'chute' | 'tower'; slots: number }[] = [
  { id: 'prusa-mk4s-mmu3', purge: 'tower', slots: 5 },
  { id: 'prusa-coreone-mmu3', purge: 'tower', slots: 5 },
  { id: 'prusa-mk3s-mmu3', purge: 'tower', slots: 5 },
  { id: 'creality-k2plus-cfs', purge: 'chute', slots: 4 },
  { id: 'creality-k1c-cfs', purge: 'tower', slots: 4 },
  { id: 'creality-k1max-cfs', purge: 'tower', slots: 4 },
  { id: 'creality-hi-cfs', purge: 'chute', slots: 4 },
  { id: 'anycubic-kobra3-ace', purge: 'chute', slots: 4 },
  { id: 'anycubic-kobras1-ace', purge: 'chute', slots: 4 },
  { id: 'generic-klipper-mmu', purge: 'tower', slots: 8 },
];

/** The unit runs NexSpiro's own change G-code (the maker's profile has none); else the maker's (OrcaSlicer: Creality CFS,
 *  Anycubic Kobra S1 ACE), which leaves the purge to the tower or to the firmware's change command over its chute. */
const ownChange = (id: string) => /NexSpiro filament change/.test(String(printerById(id).machine.change_filament_gcode));

const cfg = (printerId: string, machine: Config = {}, o: Config = {}) =>
  resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: o as never, machineOverrides: machine });
const part = (x: number, f: number): MeshInput => ({ id: `b${f}`, name: `b${f}`, ...weld(box(x, 60, 0, 12, 12, 4)), filament: f });

/** Two (or more) 4 mm boxes side by side, one filament each: a filament change on every layer. */
function run(printerId: string, machine: Config = {}, n = 2) {
  const c = cfg(printerId, machine);
  const a = slotFromConfig(c);
  const filaments = Array.from({ length: n }, (_, k) => ({ ...a, name: `PLA ${k + 1}`, color: ['#ffffff', '#cc2222', '#111111', '#2244cc', '#22aa44', '#ffcc00'][k % 6] }));
  const meshes = Array.from({ length: n }, (_, k) => part(60 + k * 22, k));
  return slice(meshes, c, () => {}, { filaments });
}
const towerMm = (g: string) => {
  let on = false, e = 0;
  for (const l of g.split('\n')) {
    if (l.startsWith(';TYPE:')) on = l === ';TYPE:prime tower';
    const m = on && /^G1 .*E(-?[\d.]+)/.exec(l);
    if (m && Number(m[1]) > 0) e += Number(m[1]);
  }
  return e;
};
const flushes = (g: string) => [...g.matchAll(/^G1 E(-?[\d.]+) F(?:240|300) ; flush/gm)].map((m) => Number(m[1]));

describe('filament units', () => {
  it('profiles: a filament unit, a purge target, slots, a change macro', () => {
    for (const u of UNITS) {
      const p = printerById(u.id);
      expect(p.id, u.id).toBe(u.id);
      expect(changerOf(p.machine)).toBe('ams');
      expect(purgeTarget(p.machine)).toBe(u.purge);
      expect(slotCount(p.machine)).toBe(u.slots);
      expect(Number(p.machine.filament_change_time)).toBeGreaterThan(20);
      if (ownChange(u.id)) expect(String(p.machine.change_filament_gcode)).toMatch(/T\[next_extruder\]/);
      else expect(p.machine.gcode_templates).toBe('vendor');
      expect(p.note).toBeTruthy();
    }
    // Bambu: chute, from the printer (no purge_target in the profile)
    for (const id of ['bbl-a1', 'bbl-p1s', 'bbl-x1c', 'bbl-h2d']) {
      expect(printerById(id).machine.purge_target, id).toBeUndefined();
      expect(purgeTarget(printerById(id).machine)).toBe('chute');
      expect(flushesIntoTower(cfg(id))).toBe(false);
    }
    // a unit set up by hand on a non-Bambu printer flushes onto the tower unless told it has a chute
    expect(purgeTarget({ ...cfg('voron-24-350'), changer_type: 'ams' })).toBe('tower');
    expect(flushesIntoTower({ ...cfg('voron-24-350'), changer_type: 'ams', purge_target: 'chute' })).toBe(false);
    expect(flushesIntoTower(cfg('snapmaker-u1'))).toBe(false);
    // single-colour ids stay, and point at the combo profile
    expect(changerOf(printerById('creality-k2plus').machine)).toBe('manual');
    expect(printerById('creality-k2plus').note).toMatch(/K2 Plus Combo \(CFS\)/);
    expect(printerById('anycubic-kobra3').note).toMatch(/Kobra 3 Combo \(ACE Pro\)/);
    expect(new Set(PRINTERS.map((p) => p.id)).size).toBe(PRINTERS.length);
  });

  for (const u of UNITS) it(`${u.id}: two colours, every layer`, () => {
    const out = run(u.id);
    const g = out.gcode;
    expect(g).not.toMatch(/NaN|Infinity|\[next_extruder\]|\[previous_extruder\]|\[flush_length\]|\[wipe_tower_[xy]\]|\[new_filament_temp\]/);
    expect(out.stats.toolChanges).toBeGreaterThan(10);
    expect(g).toMatch(/^T1\b/m);
    expect(out.warnings.some((w) => /slots/.test(w))).toBe(false);
    if (!ownChange(u.id)) {
      // the maker's change G-code: OrcaSlicer writes the T command after it; the tower or the firmware takes the flush
      const other = run(u.id, { purge_target: u.purge === 'tower' ? 'chute' : 'tower' });
      if (u.purge === 'tower') expect(towerMm(g)).toBeGreaterThan(towerMm(other.gcode) * 2.5);
      else expect(towerMm(other.gcode)).toBeGreaterThan(towerMm(g) * 2.5);
      return;
    }
    const fl = flushes(g);
    expect(fl.length).toBeGreaterThan(10);
    if (u.purge === 'tower') {
      // the tower takes the flush: the change G-code purges nothing, the tower holds prime + flush per change
      expect(fl.every((e) => e === 0)).toBe(true);
      expect(g).toMatch(/^G1 X[\d.]+ Y[\d.]+ F9000 ; over the prime tower/m);
      const chute = run(u.id, { purge_target: 'chute' });
      expect(flushes(chute.gcode).every((e) => e > 5)).toBe(true);
      expect(towerMm(g)).toBeGreaterThan(towerMm(chute.gcode) * 2.5);
    } else {
      expect(fl.every((e) => e > 5)).toBe(true);
      expect(towerMm(g)).toBeGreaterThan(0);
      const tower = run(u.id, { purge_target: 'tower' });
      expect(flushes(tower.gcode).every((e) => e === 0)).toBe(true);
      expect(towerMm(tower.gcode)).toBeGreaterThan(towerMm(g) * 2.5);
    }
    // the time estimate counts every change
    const quick = run(u.id, { filament_change_time: 0 });
    const dt = out.stats.timeSeconds - quick.stats.timeSeconds;
    expect(dt).toBeGreaterThan(out.stats.toolChanges * Number(printerById(u.id).machine.filament_change_time) * 0.9);
  });

  it('the tower is printed for a unit without a chute even with the prime tower off', () => {
    const out = run('prusa-mk4s-mmu3', {}, 2);
    const off = (() => {
      const c = cfg('prusa-mk4s-mmu3', {}, { enable_prime_tower: false });
      const a = slotFromConfig(c);
      return slice([part(60, 0), part(82, 1)], c, () => {}, { filaments: [a, { ...a, color: '#cc2222' }] });
    })();
    expect(towerMm(off.gcode)).toBeCloseTo(towerMm(out.gcode), 0);
    expect(off.warnings.some((w) => /no purge chute/.test(w))).toBe(true);
  });

  it('warns when a print uses more filaments than the unit has slots', () => {
    const out = run('anycubic-kobra3-ace', {}, 5);
    expect(out.warnings.some((w) => /filament slot 5 but the filament unit has 4 slots/.test(w))).toBe(true);
    expect(run('prusa-mk4s-mmu3', {}, 5).warnings.some((w) => /slots/.test(w))).toBe(false);
    expect(run('prusa-mk4s-mmu3', {}, 6).warnings.some((w) => /filament slot 6 but the filament unit has 5 slots/.test(w))).toBe(true);
    // not set: no limit
    expect(run('bbl-p1s', {}, 5).warnings.some((w) => /slots/.test(w))).toBe(false);
  });

  it('Bambu: the chute flush and the tower are as before', () => {
    // Bambu Studio's X1 Carbon change G-code: the purge is in its FLUSH blocks
    const out = run('bbl-x1c');
    const g = out.gcode;
    const fl = bambuFlushes(g);
    expect(fl.length).toBe(out.stats.toolChanges + 1); // the first load goes through the AMS too
    expect(fl[0]).toBe(0); // the first load: nothing to flush yet
    expect(fl.slice(1).every((e) => e > 50)).toBe(true); // 280 mm³ of 1.75 mm filament
    expect(g).toMatch(/^M620 S1A/m);
    // stating the chute changes nothing but the config line
    const chute = run('bbl-x1c', { purge_target: 'chute' }).gcode;
    const strip = (s: string) => s.split('\n').filter((l) => !l.startsWith('; purge_target')).join('\n');
    expect(strip(chute)).toBe(strip(g));
    // the band holds the prime volume only (45 mm³ on a 35 mm tower at 0.2 mm: 6.4 mm deep)
    expect(towerMm(g)).toBeGreaterThan(0);
    const tower = run('bbl-x1c', { purge_target: 'tower' });
    expect(towerMm(tower.gcode)).toBeGreaterThan(towerMm(g) * 2.5);
    // no purge left in the change G-code: only the refill of the 2 mm toolchange retraction
    expect(bambuFlushes(tower.gcode).every((e) => e <= Number(cfg('bbl-x1c').retract_length_toolchange) + 1e-6)).toBe(true);
  });

  it('a weave bleed change still skips the tower on a tower-flushing unit', () => {
    const w: WeaveSettings = { ...defaultWeave(), enabled: true, image: motifImage('checker', 32, 12, 2), z_start: 1.2, change: { mode: 'bleed', volume_mm3: 0 } };
    const run2 = (mode: WeaveSettings['change']['mode']) => {
      const ww = { ...w, change: { mode, volume_mm3: 0 } };
      const c = cfg('prusa-mk4s-mmu3', {}, weavePrintSettings(ww));
      const a = slotFromConfig(c);
      const mx: MotionexConfig = { applications: [], brushes: [], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead('prusa-mk4s-mmu3'), printerId: 'prusa-mk4s-mmu3', weave: ww };
      return slice([{ id: 'v', name: 'v', ...weld(cylinder(128, 105, 18, 8, 96)) }], c, () => {}, { filaments: [a, { ...a, color: '#cc2222' }], plugins: { motionex: mx } });
    };
    const bleed = run2('bleed'), purge = run2('purge');
    expect(bleed.stats.toolChanges).toBeGreaterThan(10);
    expect(bleed.gcode).toMatch(/mode=none/);
    expect(bleed.gcode).not.toMatch(/NaN|\[flush_length\]/);
    expect(towerMm(bleed.gcode)).toBeLessThan(towerMm(purge.gcode) * 0.6);
  });
});
