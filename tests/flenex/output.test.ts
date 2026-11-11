import { beforeAll, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { box, cylinder, initKernel, loft, sphere, type V3 } from '../../src/plugins/flenex/csg';
import { buildFlexi, modelBvh, newCut } from '../../src/plugins/flenex/flexi';
import { fitFor } from '../../src/plugins/flenex/fit';
import { applyPaint, SCHEMES } from '../../src/plugins/flenex/paint';
import { build3mf, build3mfModel, paintCode } from '../../src/plugins/flenex/export3mf';
import { cutAt, fitToBed, localAxis, rotateQuarters } from '../../src/plugins/flenex/place';
import { machineFor } from '../../src/plugins/flenex/fit';
import { defaultJoint } from '../../src/plugins/flenex/joints';

beforeAll(initKernel);

const rod = () => buildFlexi(cylinder(10, 10, -60, 60, 40), [newCut('1', [0, 0, -20], [0, 0, 1]), newCut('2', [0, 0, 20], [0, 0, 1], defaultJoint('hinge'))], fitFor(0.4));

describe('paint', () => {
  it('colours whole pieces and replays on a rebuilt mesh', () => {
    const r = rod();
    expect(r.pieces.length).toBe(3);
    const p = applyPaint([{ kind: 'fill', slot: 1 }, { kind: 'alternate', slots: [1, 2] }], { mesh: r.mesh, triPiece: r.triPiece });
    const used = new Set(p);
    expect(used).toEqual(new Set([1, 2]));
    // a piece is one colour
    const byPiece = new Map<number, Set<number>>();
    p.forEach((s, t) => { const k = r.triPiece[t]; (byPiece.get(k) ?? byPiece.set(k, new Set()).get(k)!).add(s); });
    for (const s of byPiece.values()) expect(s.size).toBe(1);
  });
  it('a stroke paints only triangles near it; a piece op paints one piece', () => {
    // a finely meshed body (long flat triangles would be painted by their centre)
    const r = buildFlexi(sphere(30, 48), [newCut('1', [0, 0, 0], [0, 0, 1])], fitFor(0.4));
    const stroke = applyPaint([{ kind: 'stroke', pts: [[0, 30, 0]], r: 8, slot: 3 }], { mesh: r.mesh, triPiece: r.triPiece });
    const n = stroke.filter((s) => s === 3).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(stroke.length / 2);
    const piece = applyPaint([{ kind: 'piece', at: [0, 0, -29], slot: 2 }], { mesh: r.mesh, triPiece: r.triPiece });
    const painted = new Set<number>(); piece.forEach((s, t) => { if (s === 2) painted.add(r.triPiece[t]); });
    expect(painted.size).toBe(1);
  });
  it('every colour scheme yields a slot for each triangle', () => {
    const r = rod();
    for (const s of SCHEMES) { const p = applyPaint(s.ops(4), { mesh: r.mesh, triPiece: r.triPiece }); expect(p.length).toBe(r.mesh.indices.length / 3); expect(Math.min(...p)).toBeGreaterThan(0); }
  });
});

describe('3MF export', () => {
  it('encodes extruders like Bambu / Orca paint_color', () => {
    expect(paintCode(1)).toBe('4'); expect(paintCode(2)).toBe('8'); expect(paintCode(3)).toBe('0C'); expect(paintCode(4)).toBe('1C'); expect(paintCode(0)).toBe('');
  });
  it('writes a well-formed coloured model', async () => {
    const r = rod();
    const paint = applyPaint([{ kind: 'alternate', slots: [1, 2, 3] }], { mesh: r.mesh, triPiece: r.triPiece });
    const xml = build3mfModel({ name: 'Test <flexi>', mesh: r.mesh, paint, palette: ['#ff0000', '#00ff00', '#0000ff'], place: [128, 128] });
    expect(xml).toContain('Test &lt;flexi&gt;');
    expect(xml.match(/<base /g)!.length).toBe(3);
    expect(xml.match(/<triangle /g)!.length).toBe(r.mesh.indices.length / 3);
    expect(xml.match(/<vertex /g)!.length).toBe(r.mesh.vertices.length / 3);
    expect(xml).toContain('paint_color="8"');
    expect(xml.match(/<(\w+)[ >]/g)!.filter((t) => /model|resources|object|mesh|vertices|triangles|build|basematerials/.test(t)).length).toBeGreaterThanOrEqual(8);
    const zip = await JSZip.loadAsync(await build3mf({ name: 'x', mesh: r.mesh, paint, palette: ['#ff0000', '#00ff00', '#0000ff'] }));
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(['3D/3dmodel.model', 'Metadata/project_settings.config', '[Content_Types].xml']));
    const cfg = JSON.parse(await zip.file('Metadata/project_settings.config')!.async('text'));
    expect(cfg.filament_colour).toEqual(['#FF0000', '#00FF00', '#0000FF']);
  });
});

describe('placement', () => {
  it('finds the axis of a limb', () => {
    const rings: V3[][] = Array.from({ length: 30 }, (_, k) => Array.from({ length: 16 }, (__, j) => [5 * Math.cos((j / 16) * 6.2832), 5 * Math.sin((j / 16) * 6.2832), k * 3] as V3));
    const a = localAxis(loft(rings), [5, 0, 40], 12);
    expect(Math.abs(a[2])).toBeGreaterThan(0.95);
  });
  it('a click on the skin gives a cut that builds', () => {
    const m = cylinder(8, 8, -50, 50, 32);
    const c = cutAt(m, modelBvh(m), '1', [8, 0, 10], [1, 0, 0], 'centreline', 'ball');
    const r = buildFlexi(m, [c], fitFor(0.4));
    expect(r.reports[0].ok).toBe(true);
    expect(r.pieces.length).toBe(2);
  });
  it('turns the footprint to fit a bed and reports the scale when nothing fits', () => {
    const long = box(420, 20, 20);
    const a1 = machineFor('bbl-a1').bed, mini = machineFor('bbl-a1-mini').bed;
    expect(fitToBed(long, a1).fits).toBe(false);
    expect(fitToBed(box(300, 20, 20), a1).fits).toBe(true); // fits across the diagonal
    const f = fitToBed(long, mini);
    expect(f.scale).toBeLessThan(1);
    const rot = fitToBed(box(250, 20, 20), a1);
    expect(rot.fits).toBe(true);
    expect(rotateQuarters(long, [0, 0, 1]).vertices.length).toBe(long.vertices.length);
  });
  it('the machine sets the clearance and colour limits', () => {
    const a1 = machineFor('bbl-a1'), ender = machineFor('creality-ender3v3ke');
    expect(a1.multiColour).toBe('ams');
    expect(ender.multiColour).toBe('manual');
    expect(a1.fit.clearance).toBeCloseTo(0.3, 2);
  });
});
