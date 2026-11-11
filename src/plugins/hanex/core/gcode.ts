// G-code for a Hanex plan (relative extrusion, M83 — the same mode Nexspiro's writer uses).
import type { HanexProfile } from './profile';
import type { HanexMove } from './plan';

const n = (x: number, d = 3) => {
  const s = x.toFixed(d);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

const TYPE: Record<HanexMove['kind'], string> = { wave: ';TYPE:Hanex wave', link: ';TYPE:Hanex wave', rim: ';TYPE:Hanex rim', travel: '' };

export interface EmitOptions {
  /** Layer top Z, mm. */
  z: number;
  /** Fan PWM to restore after the waves (omit to leave the Hanex fan on). */
  restoreFan?: number;
}

/**
 * Emit G1/G0 lines. The first move of a plan is a travel to the start of the first arc. Travels retract,
 * hop by zHop and unretract; extrusion never happens while hopped.
 */
export function emitMoves(moves: HanexMove[], p: HanexProfile, o: EmitOptions): string[] {
  const out: string[] = [`M106 P0 S${Math.round(p.fan)} ; Hanex cooling`];
  let type = '';
  let lastF = -1;
  const F = (v: number) => { const s = v !== lastF ? ` F${n(v * 60, 0)}` : ''; lastF = v; return s; };
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (m.kind === 'travel') {
      // merge consecutive travels into one retract/hop cycle
      while (i + 1 < moves.length && moves[i + 1].kind === 'travel') i++;
      const t = moves[i];
      if (p.retractLength > 0) out.push(`G1 E-${n(p.retractLength, 4)} F${n(p.retractSpeed * 60, 0)}`);
      if (p.zHop > 0) out.push(`G1 Z${n(o.z + p.zHop)} F${n(p.travelSpeed * 60, 0)}`);
      out.push(`G0 X${n(t.x)} Y${n(t.y)} F${n(p.travelSpeed * 60, 0)}`);
      if (p.zHop > 0) out.push(`G1 Z${n(o.z)}`);
      if (p.retractLength > 0) out.push(`G1 E${n(p.retractLength, 4)} F${n(p.retractSpeed * 60, 0)}`);
      lastF = -1;
      continue;
    }
    if (TYPE[m.kind] !== type) { type = TYPE[m.kind]; out.push(type); }
    out.push(`G1 X${n(m.x)} Y${n(m.y)} E${n(m.e, 5)}${F(m.f)}`);
  }
  if (o.restoreFan !== undefined) out.push(o.restoreFan > 0 ? `M106 P0 S${Math.round(o.restoreFan)}` : 'M107');
  return out;
}
