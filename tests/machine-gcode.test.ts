// Every printer with a maker's profile ships that profile's machine G-code verbatim (OrcaSlicer / Bambu Studio /
// Snapmaker Orca), and slicing on it leaves no template syntax behind.
import { describe, expect, it } from 'vitest';
import { slice, slotFromConfig } from '../src/engine/slicer';
import { weld } from '../src/engine/mesh';
import { machineConfig, resolveConfig } from '../src/profiles/resolve';
import { PRINTERS, printerById } from '../src/profiles/printers';
import { GENERATED_VENDOR } from '../src/profiles/vendor/index';
import { box } from './fixtures';

type Gen = { templates: Record<string, string>; bed: { x?: number; y?: number; z?: number }; flavor: string; machine: Record<string, unknown> };
const GEN = Object.entries(GENERATED_VENDOR as Record<string, Gen>);

function sliceOn(id: string, colours: number) {
  const p = printerById(id);
  const plate = p.plates[0].type;
  const c = resolveConfig({ printerId: id, plate, filamentId: 'generic-pla', presetId: '0.20', overrides: {} as never });
  const a = slotFromConfig(c);
  const filaments = Array.from({ length: colours }, (_, k) => ({ ...a, color: ['#ffffff', '#cc2222'][k] }));
  const cx = p.bed.x / 2, cy = p.bed.y / 2;
  const out = slice([{ id: 'b', name: 'b', ...weld(box(cx - 10, cy - 10, 0, 20, 20, 3)) } as any], c, () => {}, {
    filaments, layerActions: colours > 1 ? [{ z: 1.5, type: 'color', filament: 1 }] : [],
  });
  return out.gcode;
}
const body = (g: string) => { const i = g.indexOf('; CONFIG_BLOCK_START'); return i >= 0 ? g.slice(0, i) : g; };
const multi = (id: string) => {
  const m = machineConfig(id);
  return m.has_ams === true || m.changer_type === 'ams' || m.changer_type === 'toolchanger';
};

describe('machine G-code from the makers\' profiles', () => {
  it.each(GEN)('%s: templates and machine values are the profile\'s', (id, v) => {
    const p = printerById(id);
    expect(p.id).toBe(id);
    const m = machineConfig(id);
    expect(m.gcode_templates).toBe('vendor');
    expect(String(m.gcode_template_source)).toMatch(/@[0-9a-f]{10} /);
    expect(Object.keys(v.templates)).toContain('machine_start_gcode');
    for (const [k, t] of Object.entries(v.templates)) expect(m[k]).toBe(t);
    if (v.bed.x) expect(p.bed.x).toBe(v.bed.x);
    if (v.bed.y) expect(p.bed.y).toBe(v.bed.y);
    if (v.bed.z) expect(p.bed.z).toBe(v.bed.z);
    expect(p.flavor).toBe(v.flavor);
    for (const k of ['retraction_length', 'z_hop', 'max_acceleration', 'extruder_clearance_max_radius'] as const) if (v.machine[k] !== undefined) expect(m[k]).toBe(v.machine[k]);
  });
});

describe('every printer renders its start and end G-code', () => {
  it.each(PRINTERS.map((p) => p.id))('%s: no template syntax left, no NaN', (id) => {
    const g = body(sliceOn(id, multi(id) ? 2 : 1));
    expect(g).not.toMatch(/NaN|undefined|Infinity|\[object /);
    expect(g).not.toMatch(/\{(if|else|endif|elsif|local|global)\b/);
    // a {expression} or a [variable] the template engine did not evaluate
    const left = g.split('\n').filter((l) => !l.startsWith(';') && /\{[A-Za-z_][^}]*\}|\[[a-z_]+[a-z_0-9]*\]/.test(l.replace(/;.*$/, '')));
    expect(left).toEqual([]);
    const m = machineConfig(id);
    if (m.gcode_templates === 'vendor') {
      const start = String(m.machine_start_gcode);
      // the first G-code command of the maker's start template is in the output
      const firstCmd = start.split('\n').map((l) => l.replace(/;.*$/, '').trim()).find((l) => !/[{}\[\]]/.test(l) && /^(G|M|T)\d|^[A-Z_]{4,}$/.test(l));
      if (firstCmd) expect(g).toContain(firstCmd);
      const end = String(m.machine_end_gcode ?? '');
      const lastCmd = end.split('\n').map((l) => l.replace(/;.*$/, '').trim()).filter((l) => /^(G|M)\d+$|^[A-Z_]{4,}$/.test(l)).pop();
      if (lastCmd) expect(g).toContain(lastCmd);
    }
  });
});
