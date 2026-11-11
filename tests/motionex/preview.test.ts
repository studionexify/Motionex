import { test } from "vitest";
import assert from "node:assert/strict";
import { weld } from "../../src/engine/mesh";
import { buildPreview } from "../../src/plugins/motionex/preview";
import { PRESETS } from "../../src/plugins/motionex/presets";
import { defaultApplication } from "../../src/plugins/motionex/index";
import { cylinder } from "../fixtures";
import { profiles } from "./helpers";

const sine = PRESETS.find((b) => b.id === "preset-sine")!;
const mesh = () => weld(cylinder(50, 50, 20, 60, 96));

test("motion preview draws the motion walls quickly, without slicing", () => {
  const app = { ...defaultApplication(sine.id), target: { type: "body" as const, walls: "outer" as const } };
  const t0 = performance.now();
  const out = buildPreview([{ id: "c", mesh: mesh() }], [{ app, brush: sine, surface: 1, color: [1, 0.5, 0.2] }], profiles());
  assert.ok(performance.now() - t0 < 3000);
  assert.ok(out.layers > 50 && out.layers <= 140, `layers ${out.layers}`);
  // the waves push the wall in and out of the 20 mm radius
  let rMax = 0, rMin = Infinity;
  for (let i = 0; i < out.positions.length; i += 3) { const r = Math.hypot(out.positions[i] - 50, out.positions[i + 1] - 50); rMax = Math.max(rMax, r); rMin = Math.min(rMin, r); }
  assert.ok(rMax > 20.4 && rMin < 19.6, `r ${rMin}..${rMax}`);
});

test("motion preview only covers the picked faces (plus a little plain wall around them)", () => {
  const m = mesh();
  const motion = new Uint8Array(m.indices.length / 3);
  // pick the side triangles facing +X
  for (let t = 0; t < motion.length; t++) {
    let cx = 0;
    for (let k = 0; k < 3; k++) cx += m.vertices[m.indices[t * 3 + k] * 3] / 3;
    if (cx > 65) motion[t] = 1;
  }
  const app = { ...defaultApplication(sine.id), target: { type: "faces" as const, walls: "outer" as const, faces: ["1"] } };
  const out = buildPreview([{ id: "c", mesh: m, motion }], [{ app, brush: sine, surface: 1, color: [1, 0.5, 0.2] }], profiles());
  assert.ok(out.positions.length > 0);
  for (let i = 0; i < out.positions.length; i += 3) assert.ok(out.positions[i] > 50, `x ${out.positions[i]}`);
});

test("every advanced setting shows in the preview: plastic, speed, height, limits and events", () => {
  const app = { ...defaultApplication(sine.id), target: { type: "body" as const, walls: "outer" as const } };
  const run = (b: typeof sine, view: "motion" | "height" | "plastic" | "speed") =>
    buildPreview([{ id: "c", mesh: mesh() }], [{ app, brush: b, surface: 1, color: [1, 0.5, 0.2] }], profiles(), 0.25, view);
  const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  const curve = (v0: number, v1: number) => ({ interpolation: "linear" as const, points: [{ t: 0, v: v0, in_handle: [0, 0] as [number, number], out_handle: [0, 0] as [number, number] }, { t: 0.5, v: v1, in_handle: [0, 0] as [number, number], out_handle: [0, 0] as [number, number] }, { t: 1, v: v0, in_handle: [0, 0] as [number, number], out_handle: [0, 0] as [number, number] }] });

  // plastic curve: the plastic view's colours change, and the range shows the multiplier
  const flowy = { ...structuredClone(sine), curves: { ...structuredClone(sine.curves), extrusion_mult: curve(0.8, 1.3) } };
  const p0 = run(sine, "plastic"), p1 = run(flowy, "plastic");
  assert.ok(!same(p0.colors, p1.colors), `plastic curve changes the plastic colours ${p0.range} ${p1.range} ${p0.colors.length} ${p1.colors.length}`);
  assert.ok(p1.range[0] < 0.85 && p1.range[1] > 1.25, `plastic range ${p1.range}`);
  // limits clamp what is shown
  const capped = run({ ...flowy, limits: { min_flow_mult: 0.9, max_flow_mult: 1.1 } }, "plastic");
  assert.ok(capped.range[0] >= 0.9 - 1e-9 && capped.range[1] <= 1.1 + 1e-9, `capped ${capped.range}`);

  // speed curve
  const fast = { ...structuredClone(sine), curves: { ...structuredClone(sine.curves), speed_mult: curve(1, 1.5) } };
  const s1 = run(fast, "speed");
  assert.ok(!same(run(sine, "speed").colors, s1.colors) && s1.range[1] > 1.4, `speed range ${s1.range}`);

  // up and down
  const lifted = { ...structuredClone(sine), z_amplitude: 0.3, curves: { ...structuredClone(sine.curves), z_offset: curve(0, 1) } };
  const h = run(lifted, "height");
  assert.ok(h.range[1] > 0.25, `height range ${h.range}`);

  // pauses and lift-offs get markers
  const ev = { ...structuredClone(sine), events: [{ at: { mode: "percent" as const, value: 50 }, type: "dwell" as const, params: { ms: 200, blob_mm3: 0 } }] };
  assert.equal(run(sine, "motion").events, 0);
  assert.ok(run(ev, "motion").events > 10);
});
