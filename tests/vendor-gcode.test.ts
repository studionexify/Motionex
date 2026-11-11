// The printer makers' own G-code templates (Bambu Studio, Snapmaker Orca, OrcaSlicer's Elegoo profile), run
// unchanged by the placeholder engine.
import { describe, expect, it } from 'vitest';
import { fmtDouble, renderTemplate, unescapeCStyle } from '../src/engine/placeholder';
import { flushSplit } from '../src/engine/templateVars';
import { slice, slotFromConfig } from '../src/engine/slicer';
import { weld } from '../src/engine/mesh';
import { resolveConfig } from '../src/profiles/resolve';
import { machineConfig } from '../src/profiles/resolve';
import { printerById } from '../src/profiles/printers';
import { box } from './fixtures';
import a1 from '../src/profiles/vendor/bbl-a1.json';
import p1s from '../src/profiles/vendor/bbl-p1s.json';
import u1 from '../src/profiles/vendor/snapmaker-u1.json';
import n4 from '../src/profiles/vendor/elegoo-neptune4max.json';

const r = (tpl: string, vars: Record<string, any> = {}, ints: string[] = []) => renderTemplate(tpl, { vars, ints: new Set(ints) });

describe('placeholder engine (PrusaSlicer / Orca / Bambu Studio language)', () => {
  it('prints numbers like C++ std::ostream', () => {
    expect(fmtDouble(3)).toBe('3');
    expect(fmtDouble(1.5)).toBe('1.5');
    expect(fmtDouble(523.84256)).toBe('523.843');
    expect(fmtDouble(0.690105)).toBe('0.690105');
    expect(fmtDouble(2.6666666)).toBe('2.66667');
    expect(fmtDouble(1234567)).toBe('1.23457e+06');
    expect(fmtDouble(0.00001234)).toBe('1.234e-05');
  });
  it('keeps int arithmetic int, mixes to double', () => {
    expect(r('{24/20}')).toBe('1');
    expect(r('{24/20.0}')).toBe('1.2');
    expect(r('{layer_num+1}', { layer_num: 4 }, ['layer_num'])).toBe('5');
    expect(r('{max_layer_z + 3.0}', { max_layer_z: 0.8 })).toBe('3.8');
    expect(r('{v[1] - 90}', { v: [200, 220] }, ['v'])).toBe('130');
  });
  it('legacy [var], [var_n] and unknown brackets', () => {
    expect(r('T[next_extruder] S[t_1] [mm]', { next_extruder: 2, t: [200, 215] }, ['next_extruder', 't'])).toBe('T2 S215 [mm]');
  });
  it('text conditionals with elsif / else, nested', () => {
    const t = '{if a == 1}one{elsif a == 2}two{if b}B{endif}{else}other{endif}';
    expect(r(t, { a: 1, b: true }, ['a'])).toBe('one');
    expect(r(t, { a: 2, b: true }, ['a'])).toBe('twoB');
    expect(r(t, { a: 2, b: false }, ['a'])).toBe('two');
    expect(r(t, { a: 3, b: false }, ['a'])).toBe('other');
    expect(r('{if curr_bed_type=="Textured PEI Plate"}T{else}S{endif}', { curr_bed_type: 'Textured PEI Plate' })).toBe('T');
    expect(r('{if !spiral_mode && print_sequence != "by object"}x{endif}', { spiral_mode: false, print_sequence: 'by layer' })).toBe('x');
  });
  it('macro blocks: local, assignment, if/then/else, string output', () => {
    const t = '{\nlocal z = 1.5;\nif mode == "by object" then\n z = 5;\n"G90\\nG1 Z" + z + "\\n";\nelse\n"G91\\nG1 Z" + z + "\\n";\nendif\n}';
    expect(r(t, { mode: 'by layer' })).toBe('G91\nG1 Z1.5\n');
    expect(r(t, { mode: 'by object' })).toBe('G90\nG1 Z5\n');
    expect(r('{position[2] = position[2] + 2.0;}{position[2]}', { position: [1, 2, 3] })).toBe('5');
    expect(r('{min(3, 2.5)} {max(1, 2)} {int(2.7)}')).toBe('2.5 2 2');
  });
  it('a vector without index is the current extruder\'s value', () => {
    expect(r('{if nozzle_diameter != 0.2}ok{endif}', { nozzle_diameter: [0.4, 0.4], current_extruder: 1 }, ['current_extruder'])).toBe('ok');
  });
  it('refuses unknown variables instead of guessing', () => {
    expect(() => r('{nope + 1}')).toThrow(/unknown variable "nope"/);
  });
  it('unescapes like the slicers do when they load a profile', () => {
    expect(unescapeCStyle('a\\nb \\"c\\"')).toBe('a\nb "c"');
  });
  it('splits the purge into Bambu\'s 135 mm³ steps', () => {
    const area = Math.PI * 0.875 ** 2;
    const f = flushSplit(300, area);
    expect(f.flush_length).toBeCloseTo(300 / area, 6);
    expect([f.flush_length_1, f.flush_length_2, f.flush_length_3, f.flush_length_4].map((x) => +x.toFixed(4))).toEqual([+(300 / area / 2).toFixed(4), +(300 / area / 2).toFixed(4), 0, 0]);
    expect(flushSplit(20, area).flush_length_1).toBeCloseTo(20 / area, 6);
  });
});

const VENDORS = [['bbl-a1', a1], ['bbl-p1s', p1s], ['snapmaker-u1', u1], ['elegoo-neptune4max', n4]] as const;

describe('the makers\' templates are used verbatim', () => {
  it.each(VENDORS)('%s: every template is the vendor file, byte for byte, with its source', (id, v: any) => {
    expect(v.repo).toMatch(/\//);
    expect(v.commit).toMatch(/^[0-9a-f]{40}$/);
    const m = machineConfig(id);
    expect(m.gcode_templates).toBe('vendor');
    expect(Object.keys(v.templates).length).toBeGreaterThanOrEqual(4);
    for (const [k, t] of Object.entries(v.templates)) expect(m[k]).toBe(t);
  });
});

function sliceOn(id: string, colours: number, plate = 'textured_pei_plate') {
  const c = resolveConfig({ printerId: id, plate: plate as never, filamentId: 'generic-pla', presetId: '0.20', overrides: {} as never });
  const a = slotFromConfig(c);
  const filaments = Array.from({ length: colours }, (_, k) => ({ ...a, color: ['#ffffff', '#cc2222'][k] }));
  const out = slice([{ id: 'b', name: 'b', ...weld(box(110, 110, 0, 20, 20, 3)) } as any], c, () => {}, { filaments, layerActions: colours > 1 ? [{ z: 1.5, type: 'color', filament: 1 }] : [] });
  return { c, out, g: out.gcode };
}
const body = (g: string) => g.slice(0, g.indexOf('; CONFIG_BLOCK_START') >= 0 ? g.indexOf('; CONFIG_BLOCK_START') : undefined);

describe('slicing with the makers\' templates', () => {
  it.each(VENDORS.map(([id]) => id))('%s: no placeholder left, no NaN', (id) => {
    const { g } = sliceOn(id, id === 'elegoo-neptune4max' ? 1 : 2);
    const b = body(g);
    expect(b).not.toMatch(/NaN|undefined|Infinity/);
    // every {…} was evaluated; [name] is left only when it is not a variable
    expect(b).not.toMatch(/\{(if|else|endif|elsif)\b|\{[a-z_]+(\[[a-z_0-9]+\])?\}/);
    expect(b.split('\n').filter((l) => /\[(layer_num|layer_z|next_extruder|previous_extruder|total_layer_count|max_layer_z|initial_extruder)\]/.test(l))).toEqual([]);
  });
  it('Bambu A1: the vendor start, AMS lite change with its purge steps, end', () => {
    const { g } = sliceOn('bbl-a1', 2);
    expect(g).toMatch(/M1002 gcode_claim_action/);
    expect(g).toMatch(/^M620 S1A$/m);
    expect(g).toMatch(/^T1$/m);
    expect(g).toMatch(/M621 S1A/);
    expect(g).toMatch(/;===== date: 2\d{7} =+/);
  });
  it('Bambu P1S: textured plate branch and the bed temperature from the filament', () => {
    const { g, c } = sliceOn('bbl-p1s', 2);
    expect(g).toMatch(new RegExp(`^M190 S${Math.round(Number(c.bed_temperature_initial_layer))}`, 'm'));
    expect(g).toMatch(/M620 S1A/);
  });
  it('Bambu P1S: the purge in Bambu\'s FLUSH blocks adds up to the planned flush', () => {
    const { g, c } = sliceOn('bbl-p1s', 2);
    const blocks = [...g.matchAll(/; FLUSH_START\n([\s\S]*?); FLUSH_END/g)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThan(0);
    const total = blocks.reduce((a, b) => a + [...b.matchAll(/^G1 E(-?[\d.]+)/gm)].reduce((x, m) => x + Number(m[1]), 0), 0);
    const area = Math.PI * 0.875 ** 2;
    const planned = Number(c.flush_volume ?? 0) / area;
    expect(planned).toBeGreaterThan(10);
    // plus Bambu's refill of the toolchange retraction ([new_retract_length_toolchange], 2 mm) inside the block
    expect(total).toBeCloseTo(planned + Number(c.retract_length_toolchange), 1);
  });
  it('absolute E stays safe: after the maker\'s change G-code (it ends in M83 / G92 E0) NexSpiro restores M82 and E0', () => {
    const c = resolveConfig({ printerId: 'bbl-a1', plate: 'textured_pei_plate', filamentId: 'generic-pla', presetId: '0.20', overrides: {} as never, machineOverrides: { use_relative_e_distances: false } } as never);
    const a = slotFromConfig(c);
    const g = slice([{ id: 'b', name: 'b', ...weld(box(110, 110, 0, 20, 20, 3)) } as any], c, () => {}, { filaments: [a, { ...a, color: '#cc2222' }], layerActions: [{ z: 1.5, type: 'color', filament: 1 }] }).gcode;
    const i = g.indexOf('M621 S1A');
    expect(i).toBeGreaterThan(0);
    const after = g.slice(i).split('\n');
    const k = after.findIndex((l) => l.startsWith('M82 ; absolute E'));
    expect(k).toBeGreaterThan(0);
    expect(after[k + 1]).toBe('G92 E0');
    // the next extrusion starts again from a small absolute E
    const firstE = after.slice(k + 2).find((l) => /^G1 .*[XY].* E[\d.]+/.test(l))!;
    expect(Number(/E([\d.]+)/.exec(firstE)![1])).toBeLessThan(5);
  });
  it('Snapmaker U1: PRINT_START, head pick-up macro, 10 mm park retraction, PRINT_END', () => {
    const { g } = sliceOn('snapmaker-u1', 2);
    expect(g).toMatch(/^PRINT_START$/m);
    expect(g).toMatch(/^SM_PRINT_PREEXTRUDE_FILAMENT INDEX=0$/m);
    expect(g).toMatch(/^SM_PRINT_PREEXTRUDE_FILAMENT INDEX=1$/m);
    expect(g).toMatch(/^T1$/m);
    expect(g).toMatch(/^PRINT_END$/m);
    // the head in use is parked retracted by retract_length_toolchange (10 mm, total)
    const i = g.indexOf('; Change Tool0 -> Tool1');
    // E moves since the last extrusion: the park retraction tops the normal one up to 10 mm
    const lines = g.slice(0, i).split('\n');
    let k = lines.length - 1;
    while (k > 0 && !/^G[123] .*[XY].*E\d/.test(lines[k])) k--;
    const pulled = lines.slice(k + 1).filter((l) => /^G1 E-?[\d.]+ F/.test(l)).reduce((a, l) => a - Number(/E(-?[\d.]+)/.exec(l)![1]), 0);
    expect(pulled).toBeCloseTo(10, 6);
  });
  it('Snapmaker U1: the first hop does not circle a guessed 0,0 (Y-0.8 → error 0003-0522 Y travel limit)', () => {
    const { g } = sliceOn('snapmaker-u1', 2);
    const moves = body(g).split('\n').filter((l) => /^G[0-3] /.test(l));
    for (const l of moves) {
      const m = /Y(-?[\d.]+)/.exec(l);
      if (m) expect(Number(m[1]), l).toBeGreaterThanOrEqual(0);
      const xm = /X(-?[\d.]+)/.exec(l);
      if (xm) expect(Number(xm[1]), l).toBeGreaterThanOrEqual(0);
    }
  });
  it('Elegoo Neptune 4 Max: purge line from the bed size, layer markers, end move', () => {
    const { g, c } = sliceOn('elegoo-neptune4max', 1);
    expect(printerById('elegoo-neptune4max').bed).toEqual({ x: 426, y: 426, z: 480 });
    expect(g).toMatch(/^G1 X163 Y0.5 F6000$/m); // {print_bed_max[0]*0.5-50} on a 426 mm bed
    expect(g).toMatch(/^G1 X263 E30 F400 ;Draw the first line$/m);
    expect(g).toMatch(/^;LAYER_COUNT:\d+$/m);
    expect(g).toMatch(/^;LAYER:1$/m);
    expect(g).toMatch(/^G1 X10 Y340.8 Z[\d.]+ E-5 F30000 ; Move print head up$/m); // Y{print_bed_max[1]*0.8}, F{travel_speed*60}
    expect([c.retraction_length, c.retraction_speed, c.deretraction_speed, c.z_hop, c.wipe_distance, c.outer_wall_speed]).toEqual([0.8, 60, 30, 0.4, 1.2, 160]);
  });
});
