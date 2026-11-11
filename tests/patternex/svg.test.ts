import { test } from "vitest";
import assert from "node:assert/strict";
import { colorGroups, parseSvg, parseTransform, selfIntersects, builtinPattern, BUILTIN_KINDS, placementDepth, newPlacement } from "../../src/plugins/patternex";

const svg = (body: string, attrs = 'viewBox="0 0 100 100" width="100mm" height="100mm"') => `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const area = (r: [number, number][]) => r.reduce((s, [x, y], i) => { const [u, v] = r[(i + 1) % r.length]; return s + x * v - u * y; }, 0) / 2;
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("rect in mm with Y flipped", () => {
  const { pattern, warnings } = parseSvg(svg('<rect x="10" y="20" width="30" height="40" fill="red"/>'));
  assert.deepEqual(warnings, []);
  assert.equal(pattern.shapes.length, 1);
  assert.equal(pattern.shapes[0].fill_color, "#ff0000");
  near(Math.abs(area(pattern.shapes[0].polygon_rings[0])), 1200);
  assert.deepEqual(pattern.bounds, [10, -60, 40, -20]);
});

test("px units without size: 96 dpi", () => {
  const { pattern } = parseSvg(svg('<rect width="96" height="96"/>', ''));
  near(pattern.bounds[2] - pattern.bounds[0], 25.4);
});

test("nested group transforms compose", () => {
  const { pattern } = parseSvg(svg('<g transform="translate(50,0)"><g transform="scale(2)"><rect x="0" y="0" width="5" height="5"/></g></g>'));
  assert.deepEqual(pattern.bounds, [50, -10, 60, 0]);
  const r = parseTransform("rotate(90 10 10)");
  near(r[0] * 20 + r[2] * 10 + r[4], 10); near(r[1] * 20 + r[3] * 10 + r[5], 20);
});

test("fill inherits through groups and style beats attribute", () => {
  const { pattern } = parseSvg(svg('<g fill="#00f"><rect width="1" height="1"/><rect width="1" height="1" fill="red" style="fill:#0f0"/></g>'));
  assert.deepEqual(pattern.shapes.map((s) => s.fill_color), ["#0000ff", "#00ff00"]);
});

test("even-odd fill rule is carried; holes kept as rings", () => {
  const { pattern } = parseSvg(svg('<path fill-rule="evenodd" d="M0 0H10V10H0Z M2 2H8V8H2Z"/>'));
  assert.equal(pattern.shapes[0].fill_rule, "evenodd");
  assert.equal(pattern.shapes[0].polygon_rings.length, 2);
  const g = parseSvg(svg('<g style="fill-rule:evenodd"><path d="M0 0H1V1Z"/></g>')).pattern;
  assert.equal(g.shapes[0].fill_rule, "evenodd");
});

test("open paths: skipped with a warning, or auto-closed", () => {
  const src = svg('<path d="M0 0 L10 0 L10 10"/><polyline points="0,0 5,0 5,5 0,0"/>');
  const a = parseSvg(src);
  assert.equal(a.pattern.shapes.length, 1); // the polyline returns to its start
  assert.match(a.warnings[0], /1 open path\(s\) were skipped/);
  const b = parseSvg(src, { autoClose: true });
  assert.equal(b.pattern.shapes.length, 2);
  assert.match(b.warnings[0], /closed automatically/);
});

test("self-intersections are detected and warned", () => {
  assert.equal(selfIntersects([[0, 0], [10, 10], [10, 0], [0, 10]]), true);
  assert.equal(selfIntersects([[0, 0], [10, 0], [10, 10], [0, 10]]), false);
  const { warnings } = parseSvg(svg('<polygon points="0,0 10,10 10,0 0,10"/>'));
  assert.ok(warnings.some((w) => /cross themselves/.test(w)));
});

test("circles and arcs polylined within tolerance", () => {
  for (const tol of [0.1, 0.01]) {
    const { pattern } = parseSvg(svg('<circle cx="50" cy="50" r="20"/>'), { tolerance_mm: tol });
    const ring = pattern.shapes[0].polygon_rings[0];
    for (const [x, y] of ring) near(Math.hypot(x - 50, y + 50), 20, 1e-6);
    near(Math.abs(area(ring)), Math.PI * 400, Math.PI * 400 * tol); // chord error shrinks with tolerance
  }
  const coarse = parseSvg(svg('<circle r="20"/>'), { tolerance_mm: 0.1 }).pattern.shapes[0].polygon_rings[0].length;
  const fine = parseSvg(svg('<circle r="20"/>'), { tolerance_mm: 0.01 }).pattern.shapes[0].polygon_rings[0].length;
  assert.ok(fine > coarse);
});

test("relative commands, H/V, smooth curves and packed arc flags", () => {
  const { pattern } = parseSvg(svg('<path d="m10 10h10v10h-10z"/><path d="M0 0c0 5 5 5 5 0s5-5 5 0Z"/><path d="M0 0a5 5 0 105 5z"/>'));
  assert.equal(pattern.shapes.length, 3);
  assert.deepEqual(pattern.shapes[0].polygon_rings[0].map(([x, y]) => [x, -y]), [[10, 10], [20, 10], [20, 20], [10, 20]]);
});

test("defs, hidden and fill:none elements are ignored; unsupported counted", () => {
  const { pattern, warnings } = parseSvg(svg('<defs><rect width="5" height="5"/></defs><rect width="1" height="1" fill="none"/><rect width="1" height="1" display="none"/><text>hi</text><rect width="2" height="2"/>'));
  assert.equal(pattern.shapes.length, 1);
  assert.ok(warnings.some((w) => /not supported/.test(w)));
});

test("fill colours become region groups", () => {
  const { pattern } = parseSvg(svg('<rect width="1" height="1" fill="#fff"/><rect x="2" width="1" height="1" fill="black"/><rect x="4" width="1" height="1" fill="white"/>'));
  assert.deepEqual([...colorGroups(pattern)], [["#ffffff", [0, 2]], ["#000000", [1]]]);
});

test("parsing is deterministic", () => {
  const src = svg('<circle cx="5" cy="5" r="3" fill="red"/>');
  assert.deepEqual(parseSvg(src), parseSvg(src));
});

test("2000 shapes parse quickly", () => {
  const body = Array.from({ length: 2000 }, (_, i) => `<circle cx="${i % 50}" cy="${Math.floor(i / 50)}" r="0.4" fill="${i % 2 ? "red" : "blue"}"/>`).join("");
  const t0 = performance.now();
  const { pattern } = parseSvg(svg(body));
  assert.equal(pattern.shapes.length, 2000);
  assert.ok(performance.now() - t0 < 2000);
});

test("built-in patterns: every kind has shapes inside its bounds", () => {
  for (const k of BUILTIN_KINDS) {
    const p = builtinPattern(k, { width: 30, height: 20, cell: 5 });
    assert.ok(p.shapes.length >= 1, k);
    const [x0, y0, x1, y1] = p.bounds;
    assert.ok(x0 >= -1e-9 && y0 >= -1e-9 && x1 <= 30 + 1e-9 && y1 <= 20 + 1e-9, `${k} ${p.bounds}`);
  }
  assert.equal(builtinPattern("checker", { width: 10, height: 10, cell: 5 }).shapes.map((s) => s.polygon_rings.length).join(), "2,2");
});

test("placement depth: outer wall, paint depth or fixed", () => {
  const p = newPlacement("p1", builtinPattern("dots"), "obj:0", [0, 0, 0], [0, 0, 1]);
  assert.equal(placementDepth(p, { outer_wall_line_width: 0.42 }), 0.42);
  assert.equal(placementDepth({ ...p, depth_mode: "paint_depth" }, { mmu_paint_depth: 2 }), 2);
  assert.equal(placementDepth({ ...p, depth_mode: "fixed", depth_mm: 3 }, {}), 3);
});
