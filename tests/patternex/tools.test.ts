// Patternex tools: text, codes, Braille, trace, clean-up, tiling, gradients, brush, calibration.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { arcRings, batchValues, fieldsOf, fillFields, layoutText, parseCsv, registerFont, textPattern, defaultTextSpec } from '../../src/plugins/patternex/tools/text';
import { ADA, brailleCells, braillePattern, codePattern, defaultCodeSpec, minModuleMm } from '../../src/plugins/patternex/tools/codes';
import { traceImage, defaultTraceSpec, nearest } from '../../src/plugins/patternex/tools/trace';
import { cleanupPattern, deltaE, ringArea, simplifyRing, thinFeatures } from '../../src/plugins/patternex/tools/shape';
import { bayer, brushPattern, calibratedVolume, gradientPattern, defaultGradientSpec, seamlessCount, seamlessGap, tilePattern, defaultTileSpec } from '../../src/plugins/patternex/tools/layout';
import { parseSvg } from '../../src/plugins/patternex';
import { ditherPick, mergeBands, countChanges } from '../../src/plugins/patternex/effects';

const font = (id: string) => { const b = readFileSync(`src/plugins/patternex/tools/fonts/${id}.woff`); return registerFont(id, b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer); };
const area = (rings: [number, number][][]) => rings.reduce((a, r) => a + ringArea(r), 0);

describe('text', () => {
  const inter = font('inter');
  it('lays out at the requested size; tracking widens; alignment shifts lines', () => {
    const s = { ...defaultTextSpec(), text: 'HH', size_mm: 10 };
    const a = layoutText(inter, s), b = layoutText(inter, { ...s, tracking: 200 });
    expect(b.width - a.width).toBeCloseTo(0.2 * 10, 6); // one gap of 200/1000 em
    const ys = a.rings.flat().map((p) => p[1]);
    expect(Math.max(...ys)).toBeGreaterThan(6.5); expect(Math.max(...ys)).toBeLessThan(8); // Inter cap height ≈ 0.73 em
    const two = layoutText(inter, { ...s, text: 'HH\nH', align: 'right', line_height: 1.5 });
    expect(two.lines).toBe(2);
    const second = two.rings.flat().filter((p) => p[1] < -5).map((p) => p[0]);
    expect(Math.max(...second)).toBeCloseTo(Math.max(...a.rings.flat().map((p) => p[0])), 0);
  });
  it('arc keeps arc length along the baseline', () => {
    const R = 20, ring: [number, number][][] = [[[0, 0], [10, 0], [10, 1], [0, 1]]];
    const out = arcRings(ring, 10, R)[0];
    // baseline points sit on the circle of radius R centred at (0, -R)
    for (const [x, y] of [out[0], out[1]]) expect(Math.hypot(x, y + R)).toBeCloseTo(R, 6);
    const ang = Math.atan2(out[1][0], out[1][1] + R) - Math.atan2(out[0][0], out[0][1] + R);
    expect(ang * R).toBeCloseTo(10, 6);
  });
  it('fields fill from counters and CSV rows', () => {
    expect(fieldsOf('{name} #{serial:4}')).toEqual(['name', 'serial']);
    const rows = parseCsv('Name,Team\n"Ann, B",Red\nCy,"Bl""ue"\n');
    expect(rows).toEqual([{ name: 'Ann, B', team: 'Red' }, { name: 'Cy', team: 'Bl"ue' }]);
    const v = batchValues(2, { start: 7, step: 5, row: rows[0], date: new Date(2026, 0, 9) });
    expect(fillFields('{name} #{serial:4} {date} {unknown}', v)).toBe('Ann, B #0017 2026-01-09 {unknown}');
  });
  it('minimum stroke check flags hairline text and passes bold text', () => {
    const ok = textPattern(inter, { ...defaultTextSpec(), text: 'BOLD', size_mm: 12 }, 't1', 0.4);
    expect(ok.minStroke.ok).toBe(true);
    const thin = textPattern(inter, { ...defaultTextSpec(), text: 'tiny', size_mm: 2.5 }, 't2', 0.4);
    expect(thin.minStroke.ok).toBe(false);
    expect(ok.pattern.shapes[0].fill_rule).toBe('nonzero');
    expect(ok.pattern.meta?.kind).toBe('text');
  });
});

describe('codes and braille', () => {
  it('QR modules are sized from the width and checked against 2 × nozzle', () => {
    const r = codePattern({ ...defaultCodeSpec(), text: 'hello', width_mm: 29 }, 'q', 0.4);
    expect(r.modules).toBe(21); // version 1
    expect(r.moduleMm).toBeCloseTo(1, 6); // 29 / (21 + 2·4)
    expect(r.ok).toBe(true);
    const small = codePattern({ ...defaultCodeSpec(), text: 'hello', width_mm: 15 }, 'q2', 0.4);
    expect(small.ok).toBe(false);
    expect(minModuleMm(0.4)).toBeCloseTo(0.8, 9);
    // finder patterns: a solid 7×7 frame → inked area is a large share
    const a = area(r.pattern.shapes[0].polygon_rings);
    expect(a).toBeGreaterThan(21 * 21 * 0.3); expect(a).toBeLessThan(21 * 21 * 0.7);
  });
  it('Data Matrix and Code 128 build', () => {
    expect(codePattern({ ...defaultCodeSpec(), kind: 'datamatrix', text: 'SN-0001', width_mm: 14 }, 'd').modules).toBeGreaterThan(9);
    const bar = codePattern({ ...defaultCodeSpec(), kind: 'code128', text: 'LOT42', width_mm: 50, height_mm: 12 }, 'b');
    const ys = bar.pattern.shapes[0].polygon_rings.flat().map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(12, 1);
  });
  it('Braille: grade 1 cells with number and capital signs, ADA spacing', () => {
    expect(brailleCells('Ab 12')).toEqual([[6], [1], [1, 2], [], [3, 4, 5, 6], [1], [1, 2]]);
    const p = braillePattern({ text: 'a', color: '#000000', scale: 1 }, 'br');
    expect(p.shapes[0].polygon_rings.length).toBe(1);
    const two = braillePattern({ text: 'b', color: '#000000', scale: 1 }, 'br2').shapes[0].polygon_rings;
    const cy = (r: [number, number][]) => r.reduce((a, p) => a + p[1], 0) / r.length;
    expect(Math.abs(cy(two[0]) - cy(two[1]))).toBeCloseTo(ADA.dot_spacing_mm, 6);
    expect(ADA.dot_mm).toBeGreaterThanOrEqual(1.5); expect(ADA.dot_mm).toBeLessThanOrEqual(1.6);
  });
});

describe('logos', () => {
  it('trace: two-colour image → one inked group, background dropped, sized to width', () => {
    const w = 40, h = 20, data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, ink = x >= 10 && x < 30 && y >= 5 && y < 15;
      data[i] = ink ? 200 : 250; data[i + 1] = ink ? 20 : 250; data[i + 2] = ink ? 20 : 250; data[i + 3] = 255;
    }
    const r = traceImage({ width: w, height: h, data }, { ...defaultTraceSpec(), colors: 1, width_mm: 40 }, 'tr');
    expect(r.pattern.shapes.length).toBe(1);
    expect(area(r.pattern.shapes[0].polygon_rings)).toBeCloseTo(20 * 10, 0);
    expect(deltaE(r.colors[0], '#c81414')).toBeLessThan(3);
    // palette snapping to loaded filaments
    expect(nearest('#c81414', ['#ffffff', '#ff0000', '#000000'])).toBe('#ff0000');
  });
  it('clean-up merges near colours, removes specks and simplifies', () => {
    const svg = '<svg viewBox="0 0 100 100" width="100mm" height="100mm"><rect width="50" height="50" fill="#ff0000"/><rect x="60" width="30" height="30" fill="#fe0101"/><rect x="95" y="95" width="0.5" height="0.5" fill="#00ff00"/><circle cx="50" cy="80" r="10" fill="#0000ff"/></svg>';
    const p = parseSvg(svg, { id: 's', tolerance_mm: 0.01 }).pattern;
    const { report } = cleanupPattern(p, { mergeDeltaE: 3, simplifyMm: 0.2, speckMm2: 1 });
    expect(report.colorsBefore).toBe(4);
    expect(report.colorsAfter).toBe(2);
    expect(report.specksRemoved).toBe(1);
    expect(report.pointsAfter).toBeLessThan(report.pointsBefore);
    const sq: [number, number][] = Array.from({ length: 40 }, (_, k) => [k / 4, (k % 2) * 0.01]);
    expect(simplifyRing([...sq, [10, 5], [0, 5]], 0.05).length).toBeLessThanOrEqual(5);
  });
  it('thin features: a 0.5 mm line fails a 0.8 mm minimum, a 2 mm one passes', () => {
    expect(thinFeatures([[[0, 0], [20, 0], [20, 0.5], [0, 0.5]]], 0.8).lostShare).toBeGreaterThan(0.9);
    expect(thinFeatures([[[0, 0], [20, 0], [20, 2], [0, 2]]], 0.8).lostShare).toBeLessThan(0.01);
  });
});

describe('layout', () => {
  const sq = parseSvg('<svg viewBox="0 0 10 10" width="10mm" height="10mm"><rect width="10" height="10" fill="#000"/></svg>', { id: 'sq' }).pattern;
  it('tiling repeats with gaps; seamless wrap closes the circumference exactly', () => {
    const t = tilePattern(sq, { ...defaultTileSpec(), nx: 3, ny: 2, gap_x: 2, gap_y: 1 }, 't');
    expect(t.shapes[0].polygon_rings.length).toBe(6);
    expect(t.bounds[2] - t.bounds[0]).toBeCloseTo(3 * 10 + 2 * 2, 6);
    const C = 2 * Math.PI * 15;
    const n = seamlessCount(10, C, 2);
    const w = tilePattern(sq, { ...defaultTileSpec(), nx: n, ny: 1, wrap_mm: C }, 'w');
    // period × count = circumference
    expect((10 + seamlessGap(n, 10, C)) * n).toBeCloseTo(C, 9);
    expect(w.bounds[2] - w.bounds[0] + seamlessGap(n, 10, C)).toBeCloseTo(C, 6);
    // jitter is seeded: same seed, same result
    const j = { ...defaultTileSpec(), jitter_mm: 1, jitter_deg: 10, seed: 3 };
    expect(tilePattern(sq, j, 'a').shapes).toEqual(tilePattern(sq, j, 'b').shapes);
  });
  it('dithered gradient: B share follows the ramp; Bayer thresholds are a permutation', () => {
    const vals = new Set<number>(); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) vals.add(bayer(x, y));
    expect(vals.size).toBe(64);
    const g = gradientPattern({ ...defaultGradientSpec(), width_mm: 64, height_mm: 16, cell_mm: 1 }, 'g');
    const [A, B] = g.shapes.map((s) => area(s.polygon_rings));
    expect(A + B).toBeCloseTo(64 * 16, 3);
    expect(B / (A + B)).toBeCloseTo(0.5, 1);
  });
  it('brush keeps its origin fixed as strokes are added', () => {
    const p = brushPattern('b', [{ pts: [[0, 0], [10, 0]], width: 2, color: '#000000' }]);
    expect(p.origin).toEqual([0, 0]);
    expect(area(p.shapes[0].polygon_rings)).toBeCloseTo(10 * 2 + Math.PI, 0);
  });
  it('calibration: bleed length × line section', () => {
    expect(calibratedVolume(120, 0.42, 0.2)).toBeCloseTo(10.08, 9);
  });
});

describe('dither and band merging', () => {
  it('ditherPick spreads exactly round(n·ratio) over any window start', () => {
    for (const r of [0.25, 0.5, 0.3]) {
      const n = 40; let c = 0; for (let k = 0; k < n; k++) if (ditherPick(k, r)) c++;
      expect(c).toBe(Math.floor(n * r + 1e-9));
    }
  });
  it('mergeBands fills short base gaps between the same ink only', () => {
    const seq = [-1, 1, 1, -1, -1, 1, 1, -1, -1, -1, -1, -1, 2, 2, -1, 1];
    const m = mergeBands(seq, 3);
    expect(m.seq).toEqual([-1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, 2, 2, -1, 1]);
    expect(m.swapsBefore).toBe(countChanges(seq));
    expect(m.swapsBefore - m.swapsAfter).toBe(2);
  });
});

describe('fonts in projects', () => {
  it('user fonts used by text artwork travel with the object and are restored on load', async () => {
    const { splitByObject, collectPlacements } = await import('../../src/plugins/patternex/ui/state');
    const { userFontData, fontById } = await import('../../src/plugins/patternex/tools/text');
    const b = readFileSync('src/plugins/patternex/tools/fonts/oswald.woff');
    registerFont('user:My.woff', b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer);
    const pat = textPattern(fontById('user:My.woff')!, { ...defaultTextSpec(), font: 'user:My.woff', text: 'Hi', size_mm: 10 }, 'tx').pattern;
    const pl: any = { id: 'p1', pattern_id: 'tx', object_id: 'o1' };
    const pe = splitByObject([pl], [], [pat]).get('o1')!;
    expect(pe.fonts?.['user:My.woff']).toBe(userFontData('user:My.woff'));
    // a bundled font is not embedded
    const bundled = { ...pat, id: 'tb', meta: { kind: 'text' as const, spec: { ...defaultTextSpec() } } };
    expect(splitByObject([{ ...pl, pattern_id: 'tb' }], [], [bundled]).get('o1')!.fonts).toBeUndefined();
    // round trip through JSON (project file) and back
    const json = JSON.parse(JSON.stringify(pe));
    json.fonts = { 'user:Other.woff': json.fonts['user:My.woff'] };
    collectPlacements([{ id: 'o1', patternex: json }]);
    expect(fontById('user:Other.woff')?.names.fontFamily.en).toMatch(/^Oswald/);
  });
});
