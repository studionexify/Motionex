// Slicing + print physics off the main thread, so the page stays responsive on big pieces.
import { PRESETS } from '../plugins/motionex/presets';
import { slice, type MotionZone, type SliceSettings } from './generator';
import { compensate, simulate, type Physics } from './physics';
import type { Design } from './design';
import type { Rule } from './rules';

self.onmessage = (e: MessageEvent<{ design: Design; slice: SliceSettings; zones: MotionZone[]; rules: Rule[]; physics: Physics }>) => {
  const { design, slice: s, zones, rules, physics } = e.data;
  try {
    const result = slice(design, s, zones, (id) => PRESETS.find((b) => b.id === id), rules);
    const sim = s.evenFlow !== false || s.evenThin !== false ? compensate(result, s, physics) : simulate(result, s, physics);
    const bufs = [sim.vexit, sim.width, sim.height, sim.droop, sim.speed, sim.ratio, sim.defects].map((a) => a.buffer);
    (self as unknown as Worker).postMessage({ ok: true, result, sim }, bufs);
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: String((err as Error)?.message ?? err) });
  }
};
