// Draws a plugin's thick-thread preview as vector lines: each move is a flat ribbon at the real line width
// (world units), so it stays light to build and draw. Drips are hot vertical lines. See src/plugins/threads.ts.
import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { ThreadData } from '../plugins/threads';

export class ThreadMesh {
  readonly group = new THREE.Group();
  private lines: LineSegments2[] = [];
  private mats: LineMaterial[] = [];
  private res = new THREE.Vector2(1, 1);

  dispose() {
    for (const l of this.lines) { this.group.remove(l); l.geometry.dispose(); }
    for (const m of this.mats) m.dispose();
    this.lines = []; this.mats = [];
  }

  setResolution(w: number, h: number) { this.res.set(w, h); for (const m of this.mats) m.resolution.set(w, h); }

  private add(pos: number[], col: number[], width: number, order: number) {
    if (!pos.length) return;
    const g = new LineSegmentsGeometry();
    g.setPositions(pos); g.setColors(col);
    const m = new LineMaterial({ linewidth: width, worldUnits: true, vertexColors: true });
    m.resolution.copy(this.res);
    const l = new LineSegments2(g, m);
    l.frustumCulled = false; l.renderOrder = order;
    this.group.add(l); this.lines.push(l); this.mats.push(m);
  }

  set(t: ThreadData | null) {
    this.dispose();
    if (!t || !t.wh.length) return;
    const n = t.wh.length / 2;
    let wMax = 0;
    for (let i = 0; i < n; i++) wMax = Math.max(wMax, t.wh[i * 2]);
    // normal threads share one width; thin strings get their own thinner line
    const thick: number[] = [], thickC: number[] = [], thin: number[] = [], thinC: number[] = [];
    for (let i = 0; i < n; i++) {
      const strand = t.wh[i * 2] < wMax * 0.5, P = strand ? thin : thick, C = strand ? thinC : thickC, h2 = t.wh[i * 2 + 1] / 2;
      P.push(t.start[i * 3], t.start[i * 3 + 1], t.start[i * 3 + 2] - h2, t.end[i * 3], t.end[i * 3 + 1], t.end[i * 3 + 2] - h2);
      C.push(t.color[i * 3], t.color[i * 3 + 1], t.color[i * 3 + 2], t.color[i * 3], t.color[i * 3 + 1], t.color[i * 3 + 2]);
    }
    this.add(thick, thickC, wMax, 4);
    this.add(thin, thinC, wMax * 0.35, 4);
    const m = t.drips.length / 5, dp: number[] = [], dc: number[] = [];
    let r = 0;
    for (let k = 0; k < m; k++) {
      const x = t.drips[k * 5], y = t.drips[k * 5 + 1], z = t.drips[k * 5 + 2], len = t.drips[k * 5 + 3];
      r += t.drips[k * 5 + 4];
      dp.push(x, y, z, x, y, z - len);
      dc.push(t.dripColor[k * 3], t.dripColor[k * 3 + 1], t.dripColor[k * 3 + 2], 1, 0.42, 0.12);
    }
    if (m) this.add(dp, dc, (r / m) * 1.5, 5);
  }
}
