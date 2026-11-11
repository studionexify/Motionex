// Tool changers (one nozzle per filament): head swaps instead of filament swaps, parked heads at standby
// and preheated before their pick-up, no purge. Checked with a two-colour weave, the hardest case (a
// change every layer).
import { describe, expect, it } from 'vitest';
import { slice, slotFromConfig } from '../src/engine/slicer';
import { weld } from '../src/engine/mesh';
import { resolveConfig } from '../src/profiles/resolve';
import { printerById, PRINTERS } from '../src/profiles/printers';
import { changerOf, toolheadCount, autoChanges } from '../src/profiles/changer';
import { cylinder } from './fixtures';
import { parseToolMap, remapTools, toolMapProblems } from '../src/engine/toolmap';
import { defaultToolhead } from '../src/plugins/motionex/core/toolhead';
import { DEFAULT_OPTIONS } from '../src/plugins/motionex/modifier';
import type { MotionexConfig, MotionexReport } from '../src/plugins/motionex/engine';
import { defaultWeave, type WeaveSettings } from '../src/plugins/motionex/weave/model';
import { motifImage } from '../src/plugins/motionex/weave/motifs';
import { weavePrintSettings } from '../src/plugins/motionex/weave/plan';

const cfg = (printerId: string, o: Record<string, unknown> = {}) => resolveConfig({ printerId, plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: o as never });
const weave = (w: Partial<WeaveSettings> = {}): WeaveSettings => ({ ...defaultWeave(), enabled: true, image: motifImage('checker', 32, 12, 2), z_start: 1.2, ...w });
const mx = (w: WeaveSettings, printerId: string): MotionexConfig => ({ applications: [], brushes: [], options: DEFAULT_OPTIONS, collisionMode: 'clamp', toolhead: defaultToolhead(printerId), printerId, weave: w });

function run(printerId: string, n = 2, w = weave(), o: Record<string, unknown> = {}) {
  const c = cfg(printerId, { ...weavePrintSettings(w), ...o });
  const a = slotFromConfig(c);
  const filaments = Array.from({ length: n }, (_, k) => ({ ...a, name: `PLA ${k + 1}`, color: ['#ffffff', '#cc2222', '#111111'][k], nozzleTemp: 215 + k * 5 }));
  const out = slice([{ id: 'v', name: 'v', ...weld(cylinder(128, 128, 18, 8, 96)) }], c, () => {}, { filaments, plugins: { motionex: mx(w, printerId) } });
  return { out, c, rep: (out.pluginReports!.motionex as MotionexReport).weave! };
}

describe('filament changers', () => {
  it('tells the kinds apart', () => {
    expect(changerOf(printerById('bbl-p1s').machine)).toBe('ams');
    expect(changerOf(printerById('creality-ender3v2').machine)).toBe('manual');
    expect(changerOf(printerById('snapmaker-u1').machine)).toBe('toolchanger');
    expect(toolheadCount(printerById('prusa-xl-5t').machine)).toBe(5);
    expect(toolheadCount(printerById('bbl-p1s').machine)).toBe(1);
    expect(autoChanges(printerById('generic-idex').machine)).toBe(true);
    // a printer setting overrides the profile: any printer can be set up as a tool changer
    expect(changerOf({ ...printerById('voron-24-350').machine, changer_type: 'toolchanger' })).toBe('toolchanger');
    // NexSpiro's macro picks up T[next_extruder]; a maker's own template (Snapmaker U1) builds the T command from next_extruder
    for (const p of PRINTERS.filter((q) => changerOf(q.machine) === 'toolchanger')) expect(String(p.machine.change_filament_gcode)).toMatch(p.machine.gcode_templates === 'vendor' ? /next_extruder/ : /T\[next_extruder\]/);
  });

  it('swaps heads every layer with no purge, parks at standby and preheats before the pick-up', () => {
    const { out, rep } = run('snapmaker-u1');
    expect(rep.changes).toBeGreaterThan(20);
    // the print body (the U1's own start G-code selects heads too)
    const g = out.gcode.split(';===== end of start G-code =====').pop()!;
    // one head swap per colour change (NexSpiro's macro comments its T line, Snapmaker's does not)
    const picks = [...g.matchAll(/^T([01])(?: ; park the head in use.*)?$/gm)];
    expect(picks.length).toBe(rep.wovenLayers - 1);
    expect(out.stats.toolChanges).toBe(picks.length);
    // the parked head waits 40 °C below its print temperature
    expect(g).toMatch(/^M104 T0 S65 ; park T0 at standby/m);
    expect(g).toMatch(/^M104 T1 S70 ; park T1 at standby/m);
    // and is heated back before it is needed: after its park, before its pick-up
    const lines = g.split('\n');
    let checked = 0;
    lines.forEach((l, k) => {
      const m = /^T(\d)(?: ; park.*)?$/.exec(l);
      if (!m || checked > 10) return;
      const t = m[1];
      const park = lines.slice(0, k).map((q, i) => (q.startsWith(`M104 T${t} S`) && q.includes('standby') ? i : -1)).filter((i) => i >= 0).pop();
      if (park === undefined) return;
      const pre = lines.slice(park, k).findIndex((q) => q.startsWith(`M104 T${t} S${t === '0' ? 215 : 220} ; preheat`));
      expect(pre, `pick-up at line ${k}`).toBeGreaterThan(0);
      checked++;
    });
    expect(checked).toBeGreaterThan(5);
    // a head swap takes seconds, not a minute: the whole print is far shorter than on an AMS printer
    const ams = run('bbl-p1s');
    expect(out.stats.timeSeconds).toBeLessThan(ams.out.stats.timeSeconds * 0.6);
    expect(g).not.toMatch(/NaN|Infinity|\[next_extruder\]|\[flush_length\]/);
  });

  it('warns when a colour needs a head the printer does not have', () => {
    const { out } = run('generic-idex', 3, weave({ slots: [0, 2] }));
    expect(out.warnings.some((w) => /need 3 heads, the tool changer has 2/.test(w))).toBe(true);
  });

  it('ooze prevention: Snapmaker Orca values on the U1, switchable, preheat delta', () => {
    const m = printerById('snapmaker-u1').machine;
    expect([m.ooze_prevention, m.standby_temperature_delta, m.tool_preheat_time, m.preheat_delta_temperature]).toEqual([true, -150, 30, 0]);
    const a0 = slotFromConfig(cfg('snapmaker-u1'));
    const fils = [0, 1].map((k) => ({ ...a0, nozzleTemp: 210 }));
    const acts = [{ z: 4, type: 'color' as const, filament: 1 }];
    const obj = { id: 't', name: 't', ...weld(cylinder(128, 128, 10, 12, 48)) };
    const off = slice([obj], cfg('snapmaker-u1', { }), () => {}, { filaments: fils, layerActions: acts }).gcode;
    expect(off).toMatch(/^M104 T1 S60 ; T1 waits at standby/m);
    const noOoze = slice([obj], { ...cfg('snapmaker-u1'), ooze_prevention: false }, () => {}, { filaments: fils, layerActions: acts }).gcode;
    expect(noOoze).not.toMatch(/at standby|preheat T/);
    expect(noOoze).toMatch(/^M104 S210 T1$/m); // Snapmaker's change G-code sets the print temperature, its T macro picks up the head
    // NexSpiro's own tool change macro waits for the print temperature (M109) at the pick-up
    const gen = slice([obj], { ...cfg('generic-toolchanger'), ooze_prevention: false }, () => {}, { filaments: fils, layerActions: acts }).gcode;
    expect(gen).toMatch(/^M109 T1 S210/m);
    const delta = slice([obj], { ...cfg('snapmaker-u1'), preheat_delta_temperature: -10 }, () => {}, { filaments: fils, layerActions: acts }).gcode;
    expect(delta).toMatch(/^M104 T1 S200 ; preheat T1/m);
    expect(delta).toMatch(/^M104 S210 T1$/m);
  });

  it('keeps later heads at standby from the start and switches every head off after its last use', () => {
    // three colours, each used once: T0 for the base, then T1, then T2 on top
    const c = cfg('snapmaker-u1');
    const a = slotFromConfig(c);
    const filaments = [0, 1, 2].map((k) => ({ ...a, name: `PLA ${k + 1}`, color: ['#ffffff', '#cc2222', '#2222cc'][k], nozzleTemp: 210 + k * 5 }));
    const tower = { id: 't', name: 't', ...weld(cylinder(128, 128, 10, 12, 48)) };
    const colourAt = (z1: number, z2: number) => [{ z: z1, type: 'color' as const, filament: 1 }, { z: z2, type: 'color' as const, filament: 2 }];
    const out = slice([tower], c, () => {}, { filaments, layerActions: colourAt(4, 8) });
    const L = out.gcode.split('\n');
    const first = (re: RegExp) => L.findIndex((l) => re.test(l));
    const startEnd = first(/^;===== end of start G-code =====/);
    const sel = (t: number) => L.findIndex((l, k) => k > startEnd && new RegExp(`^T${t}(?: ; park the head in use.*)?$`).test(l));
    // T1 and T2 wait at standby (150 °C below, as in Snapmaker Orca) before the first head prints, not cold
    expect(first(/^M104 T1 S65 ; T1 waits at standby/)).toBeGreaterThan(0);
    expect(first(/^M104 T2 S70 ; T2 waits at standby/)).toBeGreaterThan(0);
    // (before the first extrusion of the print; the maker's start G-code draws its own purge line earlier)
    expect(first(/^M104 T1 S65 ; T1 waits/)).toBeLessThan(L.findIndex((l, k) => k > startEnd && /^G1 .*E[0-9.]+/.test(l)));
    // each is preheated before its pick-up
    expect(first(/^M104 T1 S215 ; preheat T1/)).toBeLessThan(sel(1));
    expect(first(/^M104 T2 S220 ; preheat T2/)).toBeLessThan(sel(2));
    // T0 and T1 are not used again: switched off when parked; T2 prints to the end
    expect(first(/^M104 T0 S0 ; T0 is not used again/)).toBeGreaterThan(0);
    expect(first(/^M104 T1 S0 ; T1 is not used again/)).toBeGreaterThan(sel(1));
    expect(first(/^M104 T2 S0 ; T2 is not used again/)).toBe(-1);
    // off after the standby line, so it is what sticks
    expect(first(/^M104 T0 S0/)).toBeGreaterThan(first(/^M104 T0 S\d+ ; park T0 at standby/));
    // the setting turns it off
    const keep = slice([tower], resolveConfig({ printerId: 'snapmaker-u1', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: {}, machineOverrides: { tool_off_after_last_use: false } } as never), () => {}, { filaments, layerActions: colourAt(4, 8) });
    expect(keep.gcode).not.toMatch(/is not used again/);
  });

  it('maps filament slots to physical heads in the finished G-code', () => {
    const g = ['T0 ; park the head in use, pick up the next one', 'M104 T1 S175 ; park T1 at standby', 'M109 T0 S215', 'G1 X10 Y10 E0.5 ; T1 stays', 'T1', '  T2 ; indented'].join('\n');
    const out = remapTools(g, [2, 0, 1]).split('\n');
    expect(out).toEqual(['T2 ; park the head in use, pick up the next one', 'M104 T0 S175 ; park T1 at standby', 'M109 T2 S215', 'G1 X10 Y10 E0.5 ; T1 stays', 'T0', '  T1 ; indented']);
    expect(remapTools(g, [0, 1, 2])).toBe(g);
    expect(parseToolMap('2, 0,,x')).toEqual([2, 0, 2, 3]);
    expect(toolMapProblems([1, 1], [0, 1], 4)).toEqual(['Filaments 1 and 2 are both mapped to head T1.']);
    expect(toolMapProblems([5], [0], 4)[0]).toMatch(/head T5, the printer has 4 heads/);
    expect(toolMapProblems([3, 2], [0, 1], 4)).toEqual([]);
  });

  it('the Snapmaker U1 sends over LAN (Moonraker)', () => {
    expect(printerById('snapmaker-u1').connections).toContain('moonraker');
  });
});
