import { describe, expect, it } from 'vitest';
import { BulnexVision, FRAME_H, FRAME_W, toGray } from '../../src/plugins/bulnex/vision';
import { rowCapacity, rowPositions, shallowestRotation } from '../../src/plugins/bulnex/arrange';

// synthetic 320×180 camera frame: textured plate, optional bright block
function frame(seed: number, block?: [number, number, number, number]) {
  const w = 320, h = 180, px = new Uint8ClampedArray(w * h * 4);
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 90 + 20 * Math.sin(x / 7) * Math.sin(y / 9) + 8 * rnd();
    if (block && x >= block[0] && x < block[0] + block[2] && y >= block[1] && y < block[1] + block[3]) v = 230 - ((x + y) % 6) * 25;
    const i = (y * w + x) * 4; px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
  }
  return toGray(px, w, h);
}

describe('bulnex vision', () => {
  it('normalises frames to the model size', () => {
    const g = frame(1);
    expect(g.length).toBe(FRAME_W * FRAME_H);
  });
  it('learns an empty plate and flags a part left behind', () => {
    const v = new BulnexVision();
    for (let k = 0; k < 4; k++) v.learnEmpty(frame(k + 1));
    expect(v.checkEmpty(frame(9)).anomaly).toBe(false);
    const left = v.checkEmpty(frame(10, [140, 80, 50, 40]));
    expect(left.anomaly).toBe(true);
    expect(left.cluster.length).toBeGreaterThanOrEqual(3);
  });
  it('compares later cycles with the reference cycle and needs persistence', () => {
    const v = new BulnexVision();
    for (let k = 0; k < 4; k++) v.checkPrint(frame(k + 1, [150, 90, 20, 20]), 0.5, true);
    expect(v.checkPrint(frame(20, [150, 90, 20, 20]), 0.5, false).anomaly).toBe(false);
    const alerts = [0, 1, 2, 3].map((k) => v.checkPrint(frame(30 + k, [60, 30, 120, 90]), 0.5, false));
    expect(alerts.every((a) => a.anomaly)).toBe(true);
    expect(alerts.map((a) => a.alert)).toEqual([false, false, false, true]);
  });
});

describe('bulnex row layout', () => {
  it('turns a long part so it is shallow along Y', () => {
    // 60 × 10 rectangle lying along Y
    const pts: [number, number][] = [[-5, -30], [5, -30], [5, 30], [-5, 30]];
    const r = shallowestRotation(pts);
    expect(r.deg).toBe(90);
    expect(r.depth).toBeCloseTo(10, 3);
  });
  it('counts parts per row on the A1 plate', () => {
    expect(rowCapacity(20, 256, 3)).toBe(10);
    expect(rowPositions(3, 20, 3)).toEqual([3, 26, 49]);
  });
});
