// The user-facing tools: every technology sits in exactly one tool (or is an always-on analysis pass),
// and a tool switch decides which of its technologies run, in the UI and in the slicing worker alike.
import { describe, expect, it } from 'vitest';
import { machineCaps } from '../../src/engine/advanced/machine';
import { resolveTechs } from '../../src/engine/advanced/techs';
import { ANALYSIS_TECHS, TOOLS, TOOL_OF_TECH } from '../../src/engine/advanced/tools';
import { TECHS } from '../../src/engine/advanced/techs';
import type { AdvancedConfig, IntentId } from '../../src/engine/advanced/types';
import { slice } from '../../src/engine/slicer';
import { md5 } from '../../src/io/md5';
import { cfgFor } from './helpers';
import { box, indexed } from './shapes';

const ctx = { caps: machineCaps('bbl-x1c', cfgFor('bbl-x1c')), filamentType: 'PLA', materials: 1, wallLoops: 2, hasCaustic: false };
const enabled = (intent: IntentId, extra: Partial<AdvancedConfig> = {}) =>
  new Set(resolveTechs({ intent, printerId: 'bbl-x1c', techs: {}, ...extra }, ctx).filter((r) => r.enabled).map((r) => r.def.id));

describe('tool registry', () => {
  it('puts every technology in exactly one tool, apart from the analysis passes', () => {
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(TOOLS.length);
    const inTools = TOOLS.flatMap((t) => t.techs);
    expect(new Set(inTools).size).toBe(inTools.length);
    expect([...inTools, ...ANALYSIS_TECHS].sort()).toEqual(TECHS.map((t) => t.id).sort());
    for (const t of TOOLS) {
      expect(t.techs.length).toBeGreaterThan(0);
      expect(t.does.length).toBeGreaterThan(20);
    }
  });
  it('gives every technology a plain name and keeps its technical one', () => {
    expect(new Set(TECHS.map((t) => t.name)).size).toBe(TECHS.length);
    for (const t of TECHS) expect(t.technique.length).toBeGreaterThan(5);
  });
});

describe('tool switches', () => {
  it('leaves the intent defaults alone when no tool is switched', () => {
    for (const intent of ['structural', 'aesthetic', 'optical', 'acoustic', 'morph4d'] as IntentId[]) {
      const on = enabled(intent);
      for (const t of TECHS) expect(on.has(t.id)).toBe(t.intents.includes(intent));
    }
  });
  it('switches every part of a tool off, over the technology switches', () => {
    const on = enabled('aesthetic', { tools: { seam_hiding: { enabled: false } }, techs: { scarf_splice: { enabled: true } } });
    expect(on.has('tangent_entry')).toBe(false);
    expect(on.has('scarf_splice')).toBe(false);
    expect(on.has('thick_vase')).toBe(true); // other tools keep their intent defaults
  });
  it('runs the ticked parts, else the intent defaults, else all', () => {
    const scarfOnly = enabled('aesthetic', { tools: { seam_hiding: { enabled: true, parts: ['scarf_splice'] } } });
    expect(scarfOnly.has('scarf_splice')).toBe(true);
    expect(scarfOnly.has('tangent_entry')).toBe(false);
    // optical turns on the dome layers only: switching the tool on keeps that choice
    const optical = enabled('optical', { tools: { curved_layers: { enabled: true } } });
    expect(optical.has('harmonic_dome')).toBe(true);
    expect(optical.has('sgd_slicing')).toBe(false);
    // structural turns on no seam technology: switching the tool on runs both
    const structural = enabled('structural', { tools: { seam_hiding: { enabled: true } } });
    expect(structural.has('tangent_entry') && structural.has('scarf_splice')).toBe(true);
  });
  it('runs one mode at a time in an exclusive tool', () => {
    const two = enabled('structural', { tools: { special_print: { enabled: true, parts: ['co_molding', 'spatial_lattice'] } } });
    expect(TOOL_OF_TECH.co_molding!.exclusive).toBe(true);
    expect(two.has('co_molding')).toBe(true);
    expect(two.has('spatial_lattice')).toBe(false);
    expect(enabled('optical').has('monge_ampere')).toBe(true);
    const first = enabled('structural', { tools: { special_print: { enabled: true } } });
    expect(['spatial_lattice', 'co_molding', 'metric_morph', 'monge_ampere'].filter((id) => first.has(id as never))).toEqual(['spatial_lattice']);
  });
  it('reaches the slicing worker: a tool switch slices like the same technology switches', () => {
    const m = indexed(box(90, 90, 0, 24, 24, 6), 'b');
    const run = (adv: Partial<AdvancedConfig>) => {
      const out = slice([m], cfgFor('bbl-x1c'), () => {}, { advanced: { intent: 'aesthetic', printerId: 'bbl-x1c', techs: {}, resolution: 'draft', ...adv } as AdvancedConfig });
      return { hash: md5(out.gcode), rep: new Map(out.advanced!.techs.map((t) => [t.id, t.status])) };
    };
    const byTool = run({ tools: { seam_hiding: { enabled: true, parts: ['scarf_splice'] } } });
    const byTech = run({ techs: { tangent_entry: { enabled: false } } });
    expect(byTool.rep.get('tangent_entry')).toBe('disabled');
    expect(byTool.rep.get('scarf_splice')).not.toBe('disabled');
    expect(byTool.hash).toBe(byTech.hash);
  });
});
