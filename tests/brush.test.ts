import { describe, expect, it } from 'vitest';
import { weld } from '../src/engine/mesh';
import { fillTriangles, gapFill, heightRangeTriangles } from '../src/engine/brush';
import { box, cylinder } from './fixtures';

describe('paint brushes', () => {
  it('smart fill stops at sharp edges and crosses smooth ones', () => {
    const cube = weld(box(0, 0, 0, 10, 10, 10));
    expect(fillTriangles(cube, 0, 30)).toHaveLength(2); // one face
    expect(fillTriangles(cube, 0, 95)).toHaveLength(12); // the whole cube
    const cyl = weld(cylinder(0, 0, 5, 10, 48));
    // side wall triangles (index 2 of each 4) join smoothly: 7.5° per step
    expect(fillTriangles(cyl, 2, 10).length).toBe(96);
  });
  it('height range takes a horizontal band', () => {
    const cyl = weld(cylinder(0, 0, 5, 10, 16));
    const v = cyl.vertices;
    const band = heightRangeTriangles(cyl, (i) => v[i * 3 + 2], 4, 6);
    expect(band.length).toBe(32); // side walls only
  });
  it('gap fill closes small unpainted islands with the surrounding value', () => {
    const cube = weld(box(0, 0, 0, 10, 10, 10));
    const paint = new Uint8Array(12).fill(3);
    paint[0] = 0; paint[1] = 0; // one 100 mm² face unpainted
    expect(gapFill(cube, paint, 50)).toHaveLength(0);
    const g = gapFill(cube, paint, 150);
    expect(g).toHaveLength(1);
    expect(g[0].value).toBe(3);
    expect(g[0].tris.sort()).toEqual([0, 1]);
  });
});
