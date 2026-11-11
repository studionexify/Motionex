// #11 Mid-air spatial lattice weaving (opt-in: replaces the solid part). Above a few solid base layers
// the part is printed as an octahedral wire truss: at every level the nozzle draws a vertical post up
// one cell (dwelling at the top so the strand freezes under full fan), drops diagonally to the next
// node, and so on along each row; then the horizontal struts of the new level are laid. The cell height
// is capped by the nozzle tip length, so the heater block never reaches a strut printed one level down.
import type { Op } from '../classic/gcode';
import { widthForArea, type Move } from '../runs';
import type { SessionCtx, TechModule } from '../session';

export const spatialLattice: TechModule = {
  id: 'spatial_lattice',
  post(s: SessionCtx, layers) {
    const r = s.report('spatial_lattice');
    if (layers.length < 6) { r.status = 'idle'; r.reason = 'Part too short for a truss.'; return; }
    const base = 3;
    const tip = s.caps.toolhead.nozzle.tip_len;
    const cell = Math.max(1, Math.min(s.pnum('spatial_lattice', 'cell'), tip - 0.4));
    // node pitch: the next node's post top (one cell above the nozzle) must lie outside the nozzle cone
    const nz = s.caps.toolhead.nozzle, wBead = s.num('line_width') || s.caps.nozzle * 1.05;
    const pitch = Math.max(cell, nz.tip_len, nz.tip_diameter / 2 + cell * Math.tan((nz.cone_angle_deg * Math.PI) / 180) + s.caps.toolhead.margin + wBead + 0.1);
    const flowK = s.pnum('spatial_lattice', 'flow'), v = s.pnum('spatial_lattice', 'speed'), dwell = s.pnum('spatial_lattice', 'dwell');
    const w = s.num('line_width') || s.caps.nozzle * 1.05;
    const fd = s.filaments[0]?.diameter ?? 1.75;
    const ePerMm = ((Math.PI * (w / 2) ** 2) / (Math.PI * (fd / 2) ** 2)) * flowK * (s.filaments[0]?.flowRatio || 1);
    const hRound = w * 0.9999; // round strand of diameter w: declared bead (w, hRound) has area pi w^2 / 4
    const wDecl = widthForArea(flowK * Math.PI * (w / 2) ** 2, hRound); // over-extrusion `flow` shows as a wider bead
    const z0 = layers[base - 1].z;
    const zTop = layers[layers.length - 1].z;
    const levels = Math.floor((zTop - z0) / cell);
    if (levels < 1) { r.status = 'idle'; r.reason = 'Part too short for a truss.'; return; }
    const tmpl: Move = { k: 'move', x: 0, y: 0, z: 0, e: 0, f: v, feature: 'inner_wall', w: wDecl, h: hRound, travel: false, noClear: true, noArc: true };
    let posts = 0, diagonals = 0, struts = 0;
    const inside = (x: number, y: number, z: number) => s.parts.some((a) => -a.sdf.sdf.sample(x, y, z) >= 0.5);
    const a0 = s.parts[0].sdf;
    const minX = Math.min(...s.parts.map((p) => p.sdf.min[0])), maxX = Math.max(...s.parts.map((p) => p.sdf.max[0]));
    const minY = Math.min(...s.parts.map((p) => p.sdf.min[1])), maxY = Math.max(...s.parts.map((p) => p.sdf.max[1]));
    void a0;
    const xs: number[] = [], ys: number[] = [];
    for (let x = minX + pitch / 2; x <= maxX; x += pitch) xs.push(+x.toFixed(3));
    for (let y = minY + pitch / 2; y <= maxY; y += pitch) ys.push(+y.toFixed(3));
    const travelF = s.num('travel_speed') || 200;
    const retract = s.num('retraction_length') || 0.8, rs = s.num('retraction_speed') || 30;
    // levels go into the layer nearest their top
    const levelOps: Op[][] = [];
    for (let k = 0; k < levels; k++) {
      const za = z0 + k * cell, zb = za + cell;
      const ops: Op[] = [{ k: 'raw', text: `; NexSpiro spatial lattice level ${k + 1}` }, { k: 'raw', text: 'M106 S255' }];
      const mv = (x: number, y: number, z: number, e: number, patch: Partial<Move> = {}): Move => ({ ...tmpl, x, y, z: +z.toFixed(4), e, ...patch });
      const travel = (x: number, y: number, z: number) => { ops.push({ k: 'retract', len: retract, speed: rs }, mv(x, y, zb + 1, 0, { travel: true, feature: 'travel', f: travelF, w: 0 }), mv(x, y, z, 0, { travel: true, feature: 'travel', f: travelF, w: 0 }), { k: 'retract', len: -retract, speed: rs }); };
      // rows: post up, dwell, diagonal down to the next node
      for (const y of ys) {
        let started = false;
        let lx = 0, ly = 0, lz = 0;
        for (let i = 0; i < xs.length; i++) {
          const x = xs[i];
          if (!inside(x, y, za) || !inside(x, y, zb)) { started = false; continue; }
          if (!started) { travel(x, y, za); lx = x; ly = y; lz = za; started = true; }
          else { const L = Math.hypot(x - lx, y - ly, za - lz); ops.push(mv(x, y, za, L * ePerMm)); diagonals++; }
          ops.push(mv(x, y, zb, cell * ePerMm, { f: v * 0.6 }), { k: 'raw', text: `G4 P${Math.round(dwell * 1000)} ; strand freezes`, time: dwell });
          posts++;
          lx = x; ly = y; lz = zb;
        }
      }
      // horizontal struts of the new level, both directions
      for (const dir of [0, 1]) for (const fixed of dir ? xs : ys) {
        const line = dir ? ys : xs;
        let open = false;
        for (const q of line) {
          const x = dir ? fixed : q, y = dir ? q : fixed;
          if (!inside(x, y, zb)) { open = false; continue; }
          if (!open) { travel(x, y, zb); open = true; continue; }
          ops.push(mv(x, y, zb, pitch * ePerMm)); struts++;
        }
      }
      levelOps.push(ops);
    }
    // replace everything above the base
    const fan = Math.round(255 * Math.min(1, (layers[base].fan || 100) / 100));
    for (let li = base; li < layers.length; li++) layers[li].ops = [];
    levelOps.forEach((ops, k) => {
      const zb = z0 + (k + 1) * cell;
      let best = base, bd = Infinity;
      for (let li = base; li < layers.length; li++) { const d = Math.abs(layers[li].z - zb); if (d < bd) { bd = d; best = li; } }
      layers[best].ops.push(...ops, { k: 'raw', text: `M106 S${fan}` });
    });
    s.nonPlanar = true;
    r.stats = { levels, cell_mm: +cell.toFixed(2), pitch_mm: +pitch.toFixed(2), posts, diagonals, struts };
  },
};
