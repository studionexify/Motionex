// Slicing + print physics off the main thread, so the page stays responsive on big pieces.
import { PRESETS } from '../plugins/motionex/presets';
import { packSegs, slice, type MotionZone, type SliceSettings } from './generator';
import { compensate, simulate, type Physics } from './physics';
import type { Design } from './design';
import type { Rule } from './rules';

self.onmessage = (e: MessageEvent<{ design: Design; slice: SliceSettings; zones: MotionZone[]; rules: Rule[]; physics: Physics }>) => {
  const { design, slice: s, zones, rules, physics } = e.data;
  try {
    const result = slice(design, s, zones, (id) => PRESETS.find((b) => b.id === id), rules);
    const sim = s.evenFlow !== false || s.evenThin !== false ? compensate(result, s, physics) : simulate(result, s, physics);
    // moves go back as flat arrays, the G-code as bytes: both are handed over, not copied
    const packed = packSegs(result.segs);
    const gcode = new TextEncoder().encode(result.gcode);
    const { segs: _s, gcode: _g, plan: _p, ...rest } = result;
    const bufs = [sim.vexit, sim.width, sim.height, sim.droop, sim.speed, sim.ratio, sim.defects].map((a) => a.buffer);
    (self as unknown as Worker).postMessage({ ok: true, result: rest, packed, gcode, plan: result.plan ? Float64Array.from(result.plan) : null, sim },
      [...bufs, packed.f.buffer, packed.i32.buffer, packed.u8.buffer, gcode.buffer] as Transferable[]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: String((err as Error)?.message ?? err) });
  }
};
