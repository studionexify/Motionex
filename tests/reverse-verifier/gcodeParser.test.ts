import { describe, expect, it } from 'vitest';
import { parseGcode } from './gcodeParser';
import type { GMove } from './mathAssertions';

// Hand-written fixture. Line numbers (1-based) are referenced by the assertions below.
const PROGRAM = [
  '; NexSpiro reverse-verifier fixture', // 1
  'M82', // 2 absolute E
  'G90', // 3
  'G92 X0 Y0 Z0 E0', // 4 reset position and E reference
  ';LAYER_CHANGE', // 5
  ';HEIGHT:0.2', // 6
  ';TYPE:Outer wall', // 7
  'G1 Z0.2 F1200', // 8 lift, no extrusion
  'G1 X10 Y0 E0.5 F1800 ; wall segment', // 9 F persists after this line
  'G1 X10 Y10 E1.0', // 10 modal F
  'G1 X0 Y10 E1.5', // 11
  'G92 E0', // 12 E reference reset, no move
  'G1 E-0.8 F2400 ; retract', // 13 pure-E negative
  'G0 X50 Y50 F9000', // 14 travel
  'G1 E0 F2400 ; de-retract', // 15 pure-E positive
  'G1 X60 Y50 E1.2', // 16 extrusion after de-retract
  ';LAYER_CHANGE', // 17
  ';LAYER_HEIGHT:0.3', // 18
  ';TYPE:Infill   ', // 19 trailing spaces must be trimmed
  'G1 Z0.5 F1200', // 20
  'G2 X70 Y50 I5 J0 E1.5 F600', // 21 clockwise semicircle, centre (65,50)
  'G3 X60 Y50 I-5 J0 E1.8', // 22 counter-clockwise back, centre (65,50)
  'M83', // 23 relative E
  'G1 X80 Y50 E0.4 F1200', // 24
  'G1 E-0.5 F2400', // 25 relative retract
  'G1 X90 Y50 E0.5', // 26
  'G91', // 27 relative XYZ
  'G1 X5 Y0 E0.2', // 28
  'G90', // 29
  '; trailing comment only', // 30
  'G1 X100 Y50 E0.4', // 31
].join('\n');

const at = (moves: GMove[], line: number): GMove => {
  const m = moves.find((mv) => mv.line === line);
  if (!m) throw new Error(`no move on line ${line}`);
  return m;
};

describe('parseGcode - fixture program', () => {
  const { moves, header } = parseGcode(PROGRAM);

  it('emits one move per G0-G3 line only', () => {
    expect(moves.map((m) => m.line)).toEqual([8, 9, 10, 11, 13, 14, 15, 16, 20, 21, 22, 24, 25, 26, 28, 31]);
  });

  it('reports header flags and line count', () => {
    expect(header.hasM82).toBe(true);
    expect(header.hasM83).toBe(true);
    expect(header.lines).toBe(31);
  });

  it('carries absolute position and normalises E to per-move deltas (M82 with G92)', () => {
    const wall = at(moves, 9);
    expect(wall.type).toBe('G1');
    expect(wall.x).toBeCloseTo(10);
    expect(wall.y).toBeCloseTo(0);
    expect(wall.z).toBeCloseTo(0.2);
    expect(wall.e).toBeCloseTo(0.5);
    expect(wall.isExtruding).toBe(true);
    expect(wall.feature).toBe('Outer wall');
    expect(wall.layerHeight).toBeCloseTo(0.2);
    expect(wall.layerIndex).toBe(0);

    expect(at(moves, 10).e).toBeCloseTo(0.5);
    expect(at(moves, 11).x).toBeCloseTo(0); // X0 explicit
    expect(at(moves, 11).y).toBeCloseTo(10); // Y carried forward
  });

  it('converts F from mm/min to mm/s and keeps it modal', () => {
    expect(at(moves, 8).f).toBeCloseTo(20); // 1200 / 60
    expect(at(moves, 9).f).toBeCloseTo(30); // 1800 / 60
    expect(at(moves, 10).f).toBeCloseTo(30); // persisted
    expect(at(moves, 14).f).toBeCloseTo(150); // 9000 / 60
    expect(at(moves, 15).f).toBeCloseTo(40); // 2400 / 60
  });

  it('treats G1 with no XYZ change and negative E as a retract, not an extrusion', () => {
    const retract = at(moves, 13);
    expect(retract.e).toBeCloseTo(-0.8);
    expect(retract.isExtruding).toBe(false);
    expect(retract.x).toBeCloseTo(0); // carried forward from line 11
    expect(retract.y).toBeCloseTo(10);
  });

  it('treats pure positive E (de-retract) as non-extruding and returns the E delta', () => {
    const prime = at(moves, 15);
    expect(prime.e).toBeCloseTo(0.8);
    expect(prime.isExtruding).toBe(false);
  });

  it('marks travel (G0) as non-extruding and uses the G0 type', () => {
    const travel = at(moves, 14);
    expect(travel.type).toBe('G0');
    expect(travel.x).toBeCloseTo(50);
    expect(travel.y).toBeCloseTo(50);
    expect(travel.e).toBeCloseTo(0);
    expect(travel.isExtruding).toBe(false);
  });

  it('extrudes correctly after de-retract', () => {
    const m = at(moves, 16);
    expect(m.e).toBeCloseTo(1.2);
    expect(m.isExtruding).toBe(true);
  });

  it('advances layerIndex at each LAYER_CHANGE and picks up HEIGHT / LAYER_HEIGHT / TYPE in force', () => {
    expect(at(moves, 8).layerIndex).toBe(0);
    expect(at(moves, 16).layerIndex).toBe(0);
    const infill = at(moves, 20);
    expect(infill.layerIndex).toBe(1);
    expect(infill.feature).toBe('Infill');
    expect(infill.layerHeight).toBeCloseTo(0.3);
  });

  it('parses G2/G3 arcs with I/J offsets and E deltas', () => {
    const cw = at(moves, 21);
    expect(cw.type).toBe('G2');
    expect(cw.x).toBeCloseTo(70);
    expect(cw.i).toBeCloseTo(5);
    expect(cw.j).toBeCloseTo(0);
    expect(cw.e).toBeCloseTo(0.3); // 1.5 - 1.2
    expect(cw.isExtruding).toBe(true);

    const ccw = at(moves, 22);
    expect(ccw.type).toBe('G3');
    expect(ccw.i).toBeCloseTo(-5);
    expect(ccw.e).toBeCloseTo(0.3); // 1.8 - 1.5
  });

  it('switches to relative E with M83 and uses raw E values as deltas', () => {
    expect(at(moves, 24).e).toBeCloseTo(0.4);
    expect(at(moves, 24).isExtruding).toBe(true);
    const relRetract = at(moves, 25);
    expect(relRetract.e).toBeCloseTo(-0.5);
    expect(relRetract.isExtruding).toBe(false);
    expect(at(moves, 26).e).toBeCloseTo(0.5);
  });

  it('applies G91 relative XYZ and returns to absolute with G90', () => {
    const rel = at(moves, 28);
    expect(rel.x).toBeCloseTo(95); // 90 + 5
    expect(rel.y).toBeCloseTo(50); // 50 + 0
    expect(rel.isExtruding).toBe(true);
    expect(at(moves, 31).x).toBeCloseTo(100);
  });
});

describe('parseGcode - targeted behaviour', () => {
  it('reports M82 only when only M82 is present', () => {
    const { header } = parseGcode('M82\nG1 X1 E1 F600');
    expect(header.hasM82).toBe(true);
    expect(header.hasM83).toBe(false);
  });

  it('drops moves before the start-G-code marker but keeps axis state', () => {
    const text = [
      'M82',
      'G92 X0 Y0 Z0 E0',
      'G1 X5 Y0 E1 F600', // start G-code, dropped
      ';===== end of start G-code =====',
      'G1 X10 Y0 E2', // kept: e = 2 - 1 (E state tracked through dropped line)
    ].join('\n');
    const { moves, header } = parseGcode(text);
    expect(moves).toHaveLength(1);
    expect(moves[0].line).toBe(5);
    expect(moves[0].x).toBeCloseTo(10);
    expect(moves[0].e).toBeCloseTo(1);
    expect(moves[0].isExtruding).toBe(true); // started from x=5 in dropped state
    expect(header.lines).toBe(5);
  });

  it('does not skip anything when the marker is absent', () => {
    const { moves } = parseGcode('G1 X1 Y1 E0.1 F600\nG1 X2 Y1 E0.2');
    expect(moves).toHaveLength(2);
  });

  it('leaves unspecified axes NaN instead of inventing an origin', () => {
    const { moves } = parseGcode('G1 X5 E0.5 F600\nG1 Y5 Z1 E1');
    expect(moves[0].x).toBeCloseTo(5);
    expect(Number.isNaN(moves[0].y)).toBe(true);
    expect(Number.isNaN(moves[0].z)).toBe(true);
    expect(moves[0].isExtruding).toBe(false); // no prior position to move from
    expect(moves[1].x).toBeCloseTo(5); // carried forward
    expect(moves[1].y).toBeCloseTo(5);
    expect(moves[1].z).toBeCloseTo(1);
  });

  it('uses layerIndex 0 and undefined feature for moves before any LAYER_CHANGE', () => {
    const { moves } = parseGcode('G1 X1 Y1 E0.1 F600\n;LAYER_CHANGE\nG1 X2 Y1 E0.2');
    expect(moves[0].layerIndex).toBe(0);
    expect(moves[0].feature).toBeUndefined();
    expect(moves[0].layerHeight).toBeUndefined();
    expect(moves[1].layerIndex).toBe(0);
  });

  it('parses fractional and negative numbers, ignores P and inline comments', () => {
    const { moves } = parseGcode('G1 X-1.5 Y.25 Z0.2 E0.0125 P3 F600 ; note X99');
    expect(moves[0].x).toBeCloseTo(-1.5);
    expect(moves[0].y).toBeCloseTo(0.25);
    expect(moves[0].e).toBeCloseTo(0.0125);
    expect(moves[0].z).toBeCloseTo(0.2);
  });

  it('returns an empty result for empty input', () => {
    const { moves, header } = parseGcode('');
    expect(moves).toEqual([]);
    expect(header).toEqual({ hasM82: false, hasM83: false, lines: 0 });
  });
});
