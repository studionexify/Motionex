import { test } from "vitest";
import assert from "node:assert/strict";
import { BrushLibrary, parseBrush, serializeBrush } from "../../src/plugins/motionex/library";
import { PRESETS } from "../../src/plugins/motionex/presets";

const memStore = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

test("every preset round-trips through JSON", () => {
  for (const b of PRESETS) assert.deepEqual(parseBrush(serializeBrush(b)), b);
});

test("invalid brushes are rejected with a reason", () => {
  assert.throws(() => parseBrush('{"id":"x","name":"x","amplitude":1,"period_mm":0,"repeat_mode":"tile"}'), /period_mm/);
  assert.throws(() => parseBrush('{"id":"x","name":"x","amplitude":1,"period_mm":2,"repeat_mode":"loop"}'), /repeat_mode/);
});

test("saving a preset stores a copy; saving again bumps version; persists", () => {
  const store = memStore();
  const lib = new BrushLibrary(store);
  const saved = lib.save(PRESETS[0]);
  assert.notEqual(saved.id, PRESETS[0].id);
  assert.equal(lib.save({ ...saved, amplitude: 2 }).version, 2);
  const again = new BrushLibrary(store);
  assert.equal(again.get(saved.id)!.amplitude, 2);
});

test("preset library: 150+ unique, valid motions that stay within their size", async () => {
  const { applyBrushToPath, DEFAULT_OPTIONS } = await import("../../src/plugins/motionex/modifier");
  const { profiles } = await import("./helpers");
  assert.ok(PRESETS.length >= 150, `only ${PRESETS.length} presets`);
  assert.equal(new Set(PRESETS.map((b) => b.id)).size, PRESETS.length);
  for (const b of PRESETS) {
    assert.ok(b.category && b.description, `${b.id} needs a group and description`);
    const out = applyBrushToPath({ feature: "outer_wall", closed: false, points: [
      { x: 0, y: 0, z: 1, f: 40, flow: 1, e: 0 }, { x: 30, y: 0, z: 1, f: 40, flow: 1, e: 0 }] }, b, profiles(), DEFAULT_OPTIONS, () => 1, () => {});
    for (const q of out.points) {
      assert.ok(Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.flow) && q.f > 0, `${b.id} produced a bad point`);
      assert.ok(Math.abs(q.y) <= b.amplitude * 2.05 + 1e-6, `${b.id} wandered ${q.y} for size ${b.amplitude}`);
    }
  }
});
