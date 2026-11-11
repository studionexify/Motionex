import { describe, expect, it } from 'vitest';
import { openEdgeCount } from '../../src/engine/mesh';
import { buildLamp } from '../../src/plugins/lumonex/build';
import { defaultDesign, LAMP_KINDS } from '../../src/plugins/lumonex/model';
import { JOINTS, defaultJoint, jointGeometry, minFit } from '../../src/plugins/lumonex/joinery';
import { PATTERNS, SECTIONS, SILHOUETTES, defaultShape, pattern, resolutionFor, shapeShell } from '../../src/plugins/lumonex/shape';
import { soupVolume, toMesh } from '../../src/plugins/lumonex/geom';

const A1 = { x: 256, y: 256, z: 256 };
const MINI = { x: 180, y: 180, z: 180 };

describe('Lumonex lamp types', () => {
  for (const k of LAMP_KINDS) {
    it(`${k.name} builds closed, outward parts`, () => {
      const d = defaultDesign(k.id);
      d.quality = 'draft';
      const { parts, report } = buildLamp(d, A1);
      const printed = parts.filter((p) => !p.ghost);
      expect(printed.length).toBeGreaterThan(0);
      for (const p of printed) {
        expect(p.soup.length % 9).toBe(0);
        expect(soupVolume(p.soup)).toBeGreaterThan(0);
        expect(openEdgeCount(toMesh(p.soup)), p.name).toBe(0);
      }
      expect(report.parts.length).toBe(printed.length);
    });
  }

  it('splits a tall floor-lamp pole to fit the printer height', () => {
    const d = defaultDesign('floor');
    d.quality = 'draft';
    const r = buildLamp(d, MINI).report;
    const poles = r.parts.filter((p) => p.name.startsWith('Pole'));
    expect(poles.length).toBeGreaterThanOrEqual(Math.ceil(1300 / 180));
    for (const p of poles) expect(p.size[2]).toBeLessThanOrEqual(180);
  });

  it('flags a shade wider than the bed', () => {
    const d = defaultDesign('pendant');
    d.quality = 'draft';
    d.sections[0].shape.diameter = 400;
    expect(buildLamp(d, MINI).report.warnings.some((w) => w.includes('wider than the printer bed'))).toBe(true);
  });

  it('warns when the bulb is too close to a PLA wall', () => {
    const d = defaultDesign('table');
    d.quality = 'draft';
    d.sections[1].shape.diameter = 80;
    expect(buildLamp(d, A1).report.warnings.some((w) => w.includes('from the'))).toBe(true);
  });
});

describe('Lumonex joinery', () => {
  it('offers at least 15 joint types', () => expect(JOINTS.length).toBeGreaterThanOrEqual(15));
  for (const j of JOINTS) {
    if (j.id === 'press' || j.id === 'crush-ribs' || j.id === 'collet') continue; // interference by design
    it(`${j.name}: socket clears the spigot`, () => {
      const g = jointGeometry(defaultJoint({ kind: j.id }), 12, 4, 17);
      expect(minFit(g)).toBeGreaterThan(0);
    });
  }
  for (const j of JOINTS) {
    it(`${j.name}: stacked pole pieces stay closed`, () => {
      const d = defaultDesign('floor');
      d.quality = 'draft';
      d.sections[1].joint = defaultJoint({ kind: j.id });
      d.sections[1].shape.height = 400;
      const { parts } = buildLamp(d, MINI);
      for (const p of parts.filter((x) => x.name.startsWith('Pole'))) expect(openEdgeCount(toMesh(p.soup)), p.name).toBe(0);
    });
  }
});

describe('Lumonex shapes', () => {
  it('every silhouette × section × pattern closes', () => {
    for (const sil of SILHOUETTES) for (const [sec] of SECTIONS) {
      const s = defaultShape({ handles: sil.handles, section: sec, height: 60, diameter: 80 });
      const m = toMesh(shapeShell(s, { around: 48, rows: 12 }));
      expect(openEdgeCount(m), `${sil.id}/${sec}`).toBe(0);
    }
    for (const [p] of PATTERNS) {
      const s = defaultShape({ height: 60, diameter: 80, patterns: [pattern(p, { count: 12, rows: 4 })] });
      expect(openEdgeCount(toMesh(shapeShell(s, resolutionFor(s, 'draft')))), p).toBe(0);
    }
  });
});

describe('Lumonex presets', () => {
  it('every preset builds closed parts', async () => {
    const { PRESETS } = await import('../../src/plugins/lumonex/presets');
    expect(PRESETS.filter((p) => p.group.startsWith('Catalogue')).length).toBe(72);
    for (const p of PRESETS) {
      const d = p.make();
      d.quality = 'draft';
      const { parts } = buildLamp(d, A1);
      for (const x of parts.filter((q) => !q.ghost)) expect(openEdgeCount(toMesh(x.soup)), `${p.name}: ${x.name}`).toBe(0);
    }
  }, 300000);
});

describe('Lumonex mechanics', () => {
  it('ballast chamber adds a fill plug and felt recess cuts the floor', () => {
    const d = defaultDesign('floor');
    d.quality = 'draft';
    d.base.ballast = true; d.base.feltRecess = 1;
    const { parts, report } = buildLamp(d, A1);
    expect(parts.some((p) => p.name.startsWith('Ballast fill plug'))).toBe(true);
    expect(report.notes.some((n) => n.includes('ballast chamber'))).toBe(true);
    expect(report.notes.some((n) => n.includes('felt disc'))).toBe(true);
    for (const p of parts.filter((x) => !x.ghost)) expect(openEdgeCount(toMesh(p.soup)), p.name).toBe(0);
  });
  for (const style of ['two-bolt', 'hinge', 'strap', 'gopro'] as const) {
    it(`${style} clamp with tilt builds closed parts`, () => {
      const d = defaultDesign('mount');
      d.quality = 'draft';
      d.mount.style = style; d.mount.tilt = 30;
      const { parts } = buildLamp(d, A1);
      const head = parts.find((p) => p.name === 'Lamp head')!;
      expect(head.assemblyRot[1]).toBe(30);
      expect(head.pivot).toBeDefined();
      for (const p of parts.filter((x) => !x.ghost)) expect(openEdgeCount(toMesh(p.soup)), p.name).toBe(0);
      if (style === 'hinge') expect(parts.find((p) => p.key === 'clamp-top')!.name).toContain('hinge');
    });
  }
  it('groups print pieces by filament for plates', async () => {
    const { groupByFilament } = await import('../../src/plugins/lumonex/ui/state');
    const d = defaultDesign('lantern');
    d.quality = 'draft';
    const groups = groupByFilament(buildLamp(d, A1).parts);
    // black base + cap + handle share a group; the translucent body has its own
    expect(groups.map((g) => g.key)).toEqual(expect.arrayContaining(['PLA Matte · Black', 'PETG Translucent · Orange']));
    expect(groups.length).toBe(2);
  });
});
