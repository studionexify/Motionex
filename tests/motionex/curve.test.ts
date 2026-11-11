import { test } from "vitest";
import assert from "node:assert/strict";
import { evalCurve } from "../../src/plugins/motionex/curve";
import { pt } from "../../src/plugins/motionex/model";
import { PRESETS } from "../../src/plugins/motionex/presets";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("linear curve interpolates and holds ends", () => {
  const c = { interpolation: "linear" as const, points: [pt(0.2, 0), pt(0.6, 2)] };
  near(evalCurve(c, 0), 0); near(evalCurve(c, 0.4), 1); near(evalCurve(c, 1), 2);
});

test("step curve holds left value", () => {
  const c = { interpolation: "step" as const, points: [pt(0, 1), pt(0.5, -1), pt(1, -1)] };
  near(evalCurve(c, 0.49), 1); near(evalCurve(c, 0.5), -1); near(evalCurve(c, 0.9), -1);
});

test("bezier passes through its points and is symmetric", () => {
  const c = { interpolation: "bezier" as const, points: [pt(0, 0, [0, 0], [0.25, 1]), pt(1, 0, [-0.25, 1], [0, 0])] };
  near(evalCurve(c, 0), 0); near(evalCurve(c, 1), 0);
  near(evalCurve(c, 0.5), 0.75, 1e-4); // cubic bezier midpoint: (0 + 3·1 + 3·1 + 0)/8
  near(evalCurve(c, 0.3), evalCurve(c, 0.7), 1e-6);
});

test("sine preset tracks sin(2πt) within 1%", () => {
  const sine = PRESETS.find((b) => b.id === "preset-sine")!.curves.lateral_offset;
  for (let i = 0; i <= 100; i++) { const t = i / 100; near(evalCurve(sine, t), Math.sin(2 * Math.PI * t), 0.01); }
});
