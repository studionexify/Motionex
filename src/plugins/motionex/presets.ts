// Built-in motion library. Every motion is a shape function over one repeat (u = 0..1),
// turned into editable curves, then offered in several sizes.
import { flatCurve, pt, type Curve, type CurveKey, type LayerEffect, type LayerMode, type MotionBrush, type MotionEvent, type NoiseSettings } from "./model";

type Fn = (u: number) => number;
const TAU = 2 * Math.PI;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6 || 0; // no -0, so JSON round-trips exactly
const frac = (u: number) => ((u % 1) + 1) % 1;

/** Smooth curve: cubic Hermite through n samples, handles from a numeric slope (wraps for repeating shapes). */
function smooth(f: Fn, n = 16): Curve {
  const dt = 1 / n, h = dt / 3, e = 1e-4;
  const slope = (u: number) => (f(frac(u + e)) - f(frac(u - e))) / (2 * e);
  return {
    interpolation: "bezier",
    points: Array.from({ length: n + 1 }, (_, i) => {
      // Cap handle height so near-vertical shapes (slope → ∞) cannot overshoot their own range.
      const u = i * dt, d = Math.max(-0.5, Math.min(0.5, slope(u === 1 ? 0 : u) * h));
      return pt(u, r6(f(u === 1 ? 0 : u)), i === 0 ? [0, 0] : [-h, r6(-d)], i === n ? [0, 0] : [h, r6(d)]);
    }),
  };
}

/** Sharp-cornered curve: straight lines through n samples (n is a multiple of 8 so corners at ⅛ steps land exactly). */
function sharp(f: Fn, n = 48): Curve {
  return { interpolation: "linear", points: Array.from({ length: n + 1 }, (_, i) => pt(r6(i / n), r6(f(i === n ? 1 : i / n)))) };
}

function jumps(steps: [number, number][]): Curve {
  return { interpolation: "step", points: [...steps.map(([u, v]) => pt(u, v)), pt(1, steps[steps.length - 1][1])] };
}

// ───────── shape functions (−1..1 unless noted) ─────────
const sine: Fn = (u) => Math.sin(TAU * u);
const cosine: Fn = (u) => Math.cos(TAU * u);
const tri: Fn = (u) => (u < 0.25 ? 4 * u : u < 0.75 ? 2 - 4 * u : 4 * u - 4);
const saw: Fn = (u) => 2 * u - 1;
const bump: Fn = (u) => 2 * Math.abs(Math.sin(Math.PI * u)) - 1;
const scallop: Fn = (u) => 2 * Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2)) - 1;
const gauss = (w: number): Fn => (u) => 2 * Math.exp(-(((u - 0.5) / w) ** 2)) - 1;
const softSquare = (k: number): Fn => (u) => Math.tanh(k * Math.sin(TAU * u)) / Math.tanh(k);
const trapezoid: Fn = (u) => Math.max(-1, Math.min(1, 3 * tri(u)));
const spikes: Fn = (u) => { const d = Math.abs(u - 0.5); return d < 0.12 ? 1 - (2 * d) / 0.12 : -1; };
const stairs = (n: number): Fn => (u) => { const s = Math.floor(tri(u) * n + n) / n - 1; return Math.max(-1, Math.min(1, s * (n / (n - 0.5)))); };
const heartbeat: Fn = (u) => (u < 0.35 ? 0 : u < 0.4 ? -0.4 * ((u - 0.35) / 0.05) : u < 0.45 ? -0.4 + 1.4 * ((u - 0.4) / 0.05) : u < 0.5 ? 1 - 2 * ((u - 0.45) / 0.05) : u < 0.55 ? -1 + ((u - 0.5) / 0.05) : 0);
const sharkFin: Fn = (u) => 2 * (1 - Math.exp(-4 * u)) / (1 - Math.exp(-4)) - 1;
const norm = (f: Fn): Fn => { let m = 0; for (let i = 0; i <= 400; i++) m = Math.max(m, Math.abs(f(i / 400))); return (u) => f(u) / (m || 1); };
const sum = (...fs: [number, Fn][]): Fn => norm((u) => fs.reduce((a, [k, f]) => a + k * f(u), 0));
const harm = (k: number, ph = 0): Fn => (u) => Math.sin(TAU * k * u + ph);

interface Shape {
  key: string; name: string; desc: string; cat: string;
  lat?: Curve; along?: Curve; flow?: Curve; speed?: Curve;
  amp?: number; period?: number; noise?: Partial<NoiseSettings>;
  limits?: [number, number];
  layers?: LayerEffect;
  /** Up-and-down curve and its height in mm. */
  zc?: Curve; zamp?: number;
  events?: MotionEvent[];
  /** Fit a whole number of repeats around each wall so vertical motions line up. */
  fit?: boolean;
}

/** Layer effect shorthand: shift (°), mode, layers per step, optional on/off bands. */
const lay = (shift_deg: number, mode: LayerMode, every = 1, band_on = 0, band_off = 0): LayerEffect => ({ shift_deg, mode, every, band_on, band_off });
/** Crossed: the same motion slanting both ways, for diamond and lattice grids. */
const cross = (shift_deg: number, every = 1): LayerEffect => ({ ...lay(shift_deg, "steady", every), cross: true });

const W = "Waves", T = "Teeth & steps", B = "Bumps & dents", P = "Pulses & beats", L = "Loops & coils", K = "Knits, braids & ropes", F = "Plastic flow motions", R = "Rough & natural", M = "Mixed";
const G = "Grids & tiles", V = "Ribs, twists & stripes", N = "Nature & animals", D = "Decor & ornament", S = "Surfaces & finishes";

const SHAPES: Shape[] = [
  // Waves
  { key: "sine", name: "Wave", desc: "Smooth, even wave in and out of the wall", cat: W, lat: smooth(sine) },
  { key: "double-wave", name: "Double wave", desc: "A big wave with a smaller ripple riding on it", cat: W, lat: smooth(sum([1, sine], [0.5, harm(2)])) },
  { key: "triple-ripple", name: "Triple ripple", desc: "Three ripples stacked on one wave", cat: W, lat: smooth(sum([1, sine], [0.35, harm(3)])) },
  { key: "wobble", name: "Wobble", desc: "Wave with a fast shiver on top", cat: W, lat: smooth(sum([1, sine], [0.25, harm(5)]), 32) },
  { key: "ocean", name: "Ocean wave", desc: "Sharp crests, wide rounded troughs", cat: W, lat: smooth(norm((u) => 1 - 2 * Math.abs(Math.cos(Math.PI * u)) ** 0.6), 24) },
  { key: "swell", name: "Swell", desc: "Wave that grows and shrinks", cat: W, lat: smooth(norm((u) => Math.sin(TAU * 3 * u) * Math.sin(Math.PI * u)), 32) },
  { key: "pinch", name: "Pinched wave", desc: "Wave squeezed thin near the wall", cat: W, lat: smooth((u) => Math.sin(TAU * u) ** 3) },
  { key: "plump", name: "Plump wave", desc: "Wave with fat, rounded peaks", cat: W, lat: smooth(norm((u) => Math.sign(Math.sin(TAU * u)) * Math.abs(Math.sin(TAU * u)) ** 0.4), 24) },
  { key: "speedup", name: "Quickening wave", desc: "Waves that get closer together", cat: W, lat: smooth((u) => Math.sin(TAU * (u + 1.5 * u * u)), 48) },
  { key: "echo", name: "Echo", desc: "A strong wave fading into smaller ones", cat: W, lat: smooth(norm((u) => Math.exp(-4 * u) * Math.sin(TAU * 4 * u)), 48) },
  { key: "lean-wave", name: "Leaning wave", desc: "Wave that rises slowly and drops fast", cat: W, lat: smooth(sum([1, sine], [-0.4, harm(2, Math.PI / 2)]), 24) },
  { key: "soft-square", name: "Soft square", desc: "Square-ish wave with rounded corners", cat: W, lat: smooth(softSquare(3), 32) },
  { key: "flat-top", name: "Flat-top wave", desc: "Wave that holds at the top and bottom", cat: W, lat: smooth(softSquare(1.6), 24) },
  // Teeth & steps
  { key: "zigzag", name: "Zigzag", desc: "Straight lines that switch direction", cat: T, lat: sharp(tri) },
  { key: "square", name: "Square teeth", desc: "Blocky in-and-out steps", cat: T, lat: jumps([[0, 1], [0.5, -1]]), amp: 0.4, period: 6 },
  { key: "castle", name: "Castle wall", desc: "Square teeth with sloped sides", cat: T, lat: sharp(trapezoid) },
  { key: "sawtooth", name: "Saw teeth", desc: "Slow ramp out, sudden drop back", cat: T, lat: sharp(saw) },
  { key: "reverse-saw", name: "Reverse saw", desc: "Sudden jump out, slow ramp back", cat: T, lat: sharp((u) => 1 - 2 * u) },
  { key: "shark-fin", name: "Shark fins", desc: "Curved fins that drop off sharply", cat: T, lat: sharp(sharkFin) },
  { key: "stairs", name: "Staircase", desc: "Steps up, steps down", cat: T, lat: sharp(stairs(3)) },
  { key: "small-stairs", name: "Small steps", desc: "Many little steps up and down", cat: T, lat: sharp(stairs(5), 96) },
  { key: "spikes", name: "Spikes", desc: "Thin points sticking out", cat: T, lat: sharp(spikes) },
  { key: "cog", name: "Gear teeth", desc: "Like the edge of a gear", cat: T, lat: sharp(norm((u) => Math.max(-0.7, Math.min(0.7, 2 * tri(u)))), 48) },
  { key: "narrow-pulse", name: "Thin ridges", desc: "Narrow ridges with long flat gaps", cat: T, lat: jumps([[0, -1], [0.75, 1]]), amp: 0.4, period: 6 },
  { key: "wide-pulse", name: "Wide ridges", desc: "Wide ridges with narrow grooves", cat: T, lat: jumps([[0, 1], [0.75, -1]]), amp: 0.4, period: 6 },
  { key: "double-step", name: "Double step", desc: "Two heights of blocks taking turns", cat: T, lat: jumps([[0, 1], [0.25, 0], [0.5, -1], [0.75, 0]]), amp: 0.5, period: 6 },
  { key: "arrow", name: "Arrowheads", desc: "Pointy zigzag with uneven sides", cat: T, lat: sharp((u) => (u < 0.7 ? -1 + (2 * u) / 0.7 : 1 - (2 * (u - 0.7)) / 0.3)) },
  // Bumps & dents
  { key: "bumps", name: "Bumps", desc: "Rounded bumps pushing out", cat: B, lat: smooth(bump, 24) },
  { key: "dents", name: "Dents", desc: "Rounded dents pressing in", cat: B, lat: smooth((u) => -bump(u), 24) },
  { key: "scallops", name: "Scallops", desc: "Half circles side by side", cat: B, lat: sharp(scallop, 64) },
  { key: "fish-scales", name: "Fish scales", desc: "Half circles facing in", cat: B, lat: sharp((u) => -scallop(u), 64) },
  { key: "hills", name: "Rolling hills", desc: "Soft hills with flat valleys", cat: B, lat: smooth((u) => 2 * Math.max(0, Math.sin(TAU * u)) ** 2 - 1, 32) },
  { key: "single-bump", name: "Round beads", desc: "One round bead per repeat", cat: B, lat: smooth(gauss(0.15), 24) },
  { key: "tiny-beads", name: "Tiny beads", desc: "Small, sharp beads with gaps", cat: B, lat: smooth(gauss(0.07), 32) },
  { key: "twin-bumps", name: "Twin bumps", desc: "Two bumps, then a gap", cat: B, lat: smooth(norm((u) => Math.exp(-(((u - 0.35) / 0.08) ** 2)) + Math.exp(-(((u - 0.65) / 0.08) ** 2)) - 0.5), 32) },
  { key: "bump-dent", name: "Bump and dent", desc: "A bump out followed by a dent in", cat: B, lat: smooth(norm((u) => Math.exp(-(((u - 0.3) / 0.1) ** 2)) - Math.exp(-(((u - 0.7) / 0.1) ** 2))), 32) },
  { key: "blisters", name: "Blisters", desc: "Flat wall with sudden round blisters", cat: B, lat: sharp((u) => (Math.abs(u - 0.5) < 0.2 ? 2 * Math.sqrt(1 - ((u - 0.5) / 0.2) ** 2) - 1 : -1), 80) },
  { key: "dimples", name: "Dimples", desc: "Flat wall with small round dips", cat: B, lat: sharp((u) => (Math.abs(u - 0.5) < 0.2 ? 1 - 2 * Math.sqrt(1 - ((u - 0.5) / 0.2) ** 2) : 1), 80) },
  // Pulses & beats
  { key: "heartbeat", name: "Heartbeat", desc: "Flat line with a heartbeat blip", cat: P, lat: sharp(heartbeat, 80), period: 8 },
  { key: "double-beat", name: "Double heartbeat", desc: "Two quick blips, then quiet", cat: P, lat: sharp((u) => heartbeat(frac(u * 2)), 160), period: 10 },
  { key: "ping", name: "Ping", desc: "A single sharp spike, then calm", cat: P, lat: sharp((u) => (Math.abs(u - 0.5) < 0.05 ? 1 - Math.abs(u - 0.5) / 0.05 : 0), 80), period: 8 },
  { key: "ring", name: "Ringing", desc: "A kick that fades out like a bell", cat: P, lat: smooth(norm((u) => Math.exp(-6 * u) * Math.sin(TAU * 6 * u)), 64), period: 8 },
  { key: "morse", name: "Morse code", desc: "Short and long ridges", cat: P, lat: jumps([[0, 1], [0.1, -1], [0.2, 1], [0.5, -1], [0.6, 1], [0.7, -1]]), amp: 0.4, period: 10 },
  { key: "barcode", name: "Barcode", desc: "Ridges of different widths", cat: P, lat: jumps([[0, 1], [0.05, -1], [0.15, 1], [0.3, -1], [0.35, 1], [0.4, -1], [0.55, 1], [0.6, -1], [0.75, 1], [0.85, -1]]), amp: 0.35, period: 12 },
  // Loops & coils (side-to-side + forward-and-back)
  { key: "coil", name: "Coil", desc: "Tight spring-like curls", cat: L, lat: smooth(sine), along: smooth(cosine), amp: 0.5, period: 3.5 },
  { key: "loop", name: "Loops", desc: "Nozzle draws little loops as it goes", cat: L, lat: smooth(sine), along: smooth(cosine), amp: 1.2, period: 4, speed: flatCurve(0.7), limits: [0.5, 1.4] },
  { key: "big-loops", name: "Big loops", desc: "Large overlapping loops", cat: L, lat: smooth(sine), along: smooth(cosine), amp: 1.8, period: 4, speed: flatCurve(0.6), limits: [0.5, 1.4] },
  { key: "flat-loops", name: "Flat loops", desc: "Loops squashed against the wall", cat: L, lat: smooth((u) => 0.5 * sine(u)), along: smooth(cosine), amp: 1.4, period: 4, speed: flatCurve(0.7) },
  { key: "tall-loops", name: "Tall loops", desc: "Loops stretched out from the wall", cat: L, lat: smooth(sine), along: smooth((u) => 0.6 * cosine(u)), amp: 1.6, period: 4, speed: flatCurve(0.7) },
  { key: "teardrops", name: "Teardrops", desc: "Loops with a pointed tail", cat: L, lat: smooth(bump, 24), along: smooth(cosine), amp: 1.2, period: 4, speed: flatCurve(0.7) },
  { key: "figure-eight", name: "Figure eights", desc: "Eights drawn along the wall", cat: L, lat: smooth(harm(2), 24), along: smooth(sine), amp: 1.2, period: 5, speed: flatCurve(0.6) },
  { key: "curl-back", name: "Back curls", desc: "Loops that curl the other way", cat: L, lat: smooth((u) => -sine(u)), along: smooth(cosine), amp: 1.2, period: 4, speed: flatCurve(0.7) },
  { key: "spring", name: "Stretched spring", desc: "Coil pulled long", cat: L, lat: smooth(sine), along: smooth((u) => 0.5 * cosine(u)), amp: 0.8, period: 6 },
  { key: "petals", name: "Petals", desc: "Flower-petal loops", cat: L, lat: smooth(norm((u) => Math.abs(Math.sin(TAU * u)) * 1.0), 24), along: smooth(harm(1, Math.PI / 2)), amp: 1.4, period: 5, speed: flatCurve(0.6) },
  { key: "clover", name: "Clover", desc: "Three small loops per repeat", cat: L, lat: smooth(harm(3), 48), along: smooth((u) => Math.cos(TAU * 3 * u)), amp: 0.7, period: 7, speed: flatCurve(0.6) },
  // Knits, braids & ropes
  { key: "knit", name: "Knit stitch", desc: "Looks like knitted wool", cat: K, lat: smooth(bump, 24), along: smooth((u) => 0.35 * Math.sin(TAU * 2 * u)), amp: 0.8, period: 3 },
  { key: "braid", name: "Braid", desc: "Over-and-under plait look", cat: K, lat: smooth(sine), along: smooth(harm(2), 24), amp: 0.9, period: 5 },
  { key: "rope", name: "Rope", desc: "Twisted rope strands", cat: K, lat: smooth(sum([1, sine], [0.3, harm(2)])), along: smooth((u) => 0.6 * cosine(u)), amp: 0.8, period: 3 },
  { key: "chain", name: "Chain links", desc: "Linked oval loops", cat: K, lat: smooth(sine), along: smooth((u) => 1.0 * cosine(u)), amp: 1.0, period: 5, speed: flatCurve(0.6) },
  { key: "weave", name: "Basket weave", desc: "Blocks that look woven", cat: K, lat: smooth(softSquare(4), 32), along: smooth((u) => 0.3 * Math.sin(TAU * 2 * u)), amp: 0.5, period: 6 },
  { key: "cable", name: "Cable knit", desc: "Chunky twisted cable", cat: K, lat: smooth(norm((u) => Math.sin(TAU * u) + 0.6 * Math.sin(TAU * 2 * u + 1)), 24), along: smooth((u) => 0.5 * Math.cos(TAU * u)), amp: 1.1, period: 5 },
  { key: "stitch", name: "Running stitch", desc: "Dashed stitch line", cat: K, lat: smooth(gauss(0.2), 24), flow: jumps([[0, 1.3], [0.6, 0.7]]), amp: 0.4, period: 4 },
  // Plastic flow motions
  { key: "beads", name: "Pearl beads", desc: "Thicker blobs along a straight wall", cat: F, flow: smooth((u) => 1 + 0.45 * Math.cos(TAU * u)), period: 3 },
  { key: "dashes", name: "Dashes", desc: "Alternating thick and thin sections", cat: F, flow: jumps([[0, 1.4], [0.5, 0.6]]), period: 4 },
  { key: "thick-thin", name: "Thick and thin", desc: "Line slowly swells and slims", cat: F, flow: smooth((u) => 1 + 0.35 * Math.sin(TAU * u)), period: 10 },
  { key: "swelling-wave", name: "Swelling wave", desc: "Wave that gets thicker at the peaks", cat: F, lat: smooth(sine), flow: smooth((u) => 1 + 0.3 * Math.abs(Math.sin(TAU * u)) * 2 - 0.3), period: 4 },
  { key: "pearl-string", name: "Pearl string", desc: "Round bumps that are also thicker", cat: F, lat: smooth(bump, 24), flow: smooth((u) => 1 + 0.4 * Math.sin(Math.PI * u) ** 2 - 0.1), period: 3 },
  { key: "speed-ripple", name: "Speed ripple", desc: "Slows and speeds up for a shimmer", cat: F, speed: smooth((u) => 1 + 0.4 * Math.sin(TAU * u)), period: 6 },
  { key: "dotted", name: "Dotted line", desc: "Almost-dots with thin links", cat: F, flow: smooth((u) => 0.75 + 0.6 * Math.exp(-(((u - 0.5) / 0.15) ** 2))), period: 2.5, limits: [0.5, 1.4] },
  // Rough & natural (seeded randomness)
  { key: "noise", name: "Fuzzy skin", desc: "Random rough texture", cat: R, amp: 0.35, period: 1.5, noise: { seed: 1337, scale: 1, octaves: 3, persistence: 0.5 } },
  { key: "sand", name: "Sand", desc: "Very fine grainy texture", cat: R, amp: 0.2, period: 0.6, noise: { seed: 7, scale: 1, octaves: 2, persistence: 0.5 } },
  { key: "bark", name: "Tree bark", desc: "Coarse, uneven ridges", cat: R, amp: 0.6, period: 4, noise: { seed: 42, scale: 1, octaves: 4, persistence: 0.65 } },
  { key: "stone", name: "Stone", desc: "Lumpy rock-like surface", cat: R, amp: 0.5, period: 6, noise: { seed: 99, scale: 1, octaves: 5, persistence: 0.55 } },
  { key: "static", name: "Static", desc: "Sharp, jittery roughness", cat: R, amp: 0.3, period: 0.8, noise: { seed: 2024, scale: 0.5, octaves: 1, persistence: 0.5 } },
  { key: "clay", name: "Hand-made clay", desc: "Soft, uneven, hand-pressed look", cat: R, amp: 0.45, period: 10, noise: { seed: 5, scale: 1, octaves: 3, persistence: 0.4 } },
  { key: "coral", name: "Coral", desc: "Bumpy natural growth look", cat: R, amp: 0.55, period: 2.5, noise: { seed: 314, scale: 1, octaves: 4, persistence: 0.7 } },
  { key: "leather", name: "Leather", desc: "Fine, soft grain", cat: R, amp: 0.15, period: 1.2, noise: { seed: 808, scale: 1, octaves: 3, persistence: 0.6 } },
  // Mixed
  { key: "wavy-fuzz", name: "Wavy fuzz", desc: "Smooth wave with rough skin", cat: M, lat: smooth((u) => 0.75 * sine(u)), amp: 0.7, period: 5, noise: { seed: 11, scale: 0.12, octaves: 2, persistence: 0.5 } },
  { key: "zig-loops", name: "Zigzag loops", desc: "Zigzag with a loop at each turn", cat: M, lat: sharp(tri), along: smooth((u) => 0.8 * cosine(u)), amp: 1.0, period: 4, speed: flatCurve(0.7) },
  { key: "wave-beads", name: "Wave with beads", desc: "Wave with thicker spots at the turns", cat: M, lat: smooth(sine), flow: smooth((u) => 1 + 0.35 * Math.cos(TAU * 2 * u)), period: 5 },
  { key: "rough-teeth", name: "Rough teeth", desc: "Saw teeth with a grainy finish", cat: M, lat: sharp((u) => 0.8 * saw(u)), amp: 0.6, period: 5, noise: { seed: 21, scale: 0.15, octaves: 2, persistence: 0.5 } },
  { key: "bubbles", name: "Bubbles", desc: "Bumps of random size", cat: M, lat: smooth(bump, 24), amp: 0.6, period: 3, noise: { seed: 63, scale: 1.5, octaves: 1, persistence: 0.5 } },
  // ── More waves, teeth, bumps ──
  { key: "flame", name: "Flames", desc: "Licking flame shapes leaning one way", cat: W, lat: smooth(norm((u) => Math.sin(TAU * u) + 0.5 * Math.sin(TAU * 2 * u + 0.8) + 0.2 * Math.sin(TAU * 3 * u + 1.6)), 32) },
  { key: "cloud", name: "Clouds", desc: "Puffy cloud outline", cat: W, lat: smooth(norm((u) => Math.abs(Math.sin(Math.PI * 3 * u)) * (0.6 + 0.4 * Math.sin(Math.PI * u))), 48), period: 9 },
  { key: "ripple-pool", name: "Pond ripples", desc: "Small rings of ripples fading out", cat: W, lat: smooth(norm((u) => Math.cos(TAU * 5 * (u - 0.5)) * Math.exp(-(((u - 0.5) / 0.25) ** 2))), 64), period: 10 },
  { key: "tide", name: "Tide", desc: "Long gentle swell with small waves on top", cat: W, lat: smooth(sum([1, sine], [0.2, harm(6)]), 48), period: 12 },
  { key: "crown", name: "Crown", desc: "Tall points with small points between", cat: T, lat: sharp(norm((u) => Math.max(tri(u), 0.4 * tri(frac(u * 2 + 0.25)) - 0.2)), 96) },
  { key: "ruler", name: "Ruler ticks", desc: "Short and long notches like a ruler", cat: T, lat: jumps([[0, 1], [0.08, -1], [0.25, 0], [0.31, -1], [0.5, 0.5], [0.56, -1], [0.75, 0], [0.81, -1]]), amp: 0.4, period: 10 },
  { key: "battlement", name: "Battlements", desc: "Castle tops with wide gaps", cat: T, lat: jumps([[0, 1], [0.35, -1]]), amp: 0.6, period: 7 },
  { key: "bolts", name: "Lightning bolts", desc: "Jagged zigzag with a kink", cat: T, lat: sharp((u) => (u < 0.4 ? -1 + 5 * u : u < 0.55 ? 1 - 6 * (u - 0.4) : u < 0.8 ? 0.1 + 3.6 * (u - 0.55) - 0.9 : 1 - 10 * (u - 0.8))), period: 5 },
  { key: "pebbles", name: "Pebbles", desc: "Rounded bumps of mixed sizes", cat: B, lat: smooth(norm((u) => Math.abs(Math.sin(Math.PI * u)) * 0.9 + Math.abs(Math.sin(Math.PI * 3 * u)) * 0.5 - 0.6), 48), period: 6 },
  { key: "nubs", name: "Nubs", desc: "Small square studs", cat: B, lat: jumps([[0, -1], [0.4, 1], [0.6, -1]]), amp: 0.4, period: 3 },
  // ── Grids & tiles (layer effects) ──
  { key: "diamonds", name: "Diamonds", desc: "Diamond grid across the wall", cat: G, lat: smooth(gauss(0.08), 48), layers: cross(4), period: 8, fit: true },
  { key: "honeycomb", name: "Honeycomb", desc: "Six-sided cells like a beehive", cat: G, lat: smooth(gauss(0.05), 48), layers: { ...lay(12, "shift_hold", 15), cross: true }, period: 12, fit: true, amp: 0.5 },
  { key: "bricks", name: "Bricks", desc: "Rows of bricks, every other row shifted", cat: G, lat: jumps([[0, 1], [0.94, -1]]), layers: lay(180, "alternate", 12, 11, 1), amp: 0.35, period: 12, fit: true },
  { key: "small-bricks", name: "Small bricks", desc: "Little bricks in tight rows", cat: G, lat: jumps([[0, 1], [0.9, -1]]), layers: lay(180, "alternate", 6, 5, 1), amp: 0.3, period: 6, fit: true },
  { key: "checkerboard", name: "Checkerboard", desc: "Raised and sunken squares", cat: G, lat: smooth(softSquare(5), 32), layers: lay(180, "alternate", 18), amp: 0.4, period: 8, fit: true },
  { key: "waffle", name: "Waffle", desc: "Grid of square pockets", cat: G, lat: jumps([[0, 1], [0.8, -1]]), layers: lay(0, "steady", 1, 16, 3), amp: 0.4, period: 6, fit: true },
  { key: "herringbone", name: "Herringbone", desc: "Slanted blocks that flip direction", cat: G, lat: jumps([[0, 1], [0.5, -1]]), layers: lay(6, "back_and_forth", 25), amp: 0.35, period: 8, fit: true },
  { key: "chevron", name: "Chevrons", desc: "Stacked V shapes", cat: G, lat: sharp(tri), layers: lay(10, "back_and_forth", 18), period: 6, fit: true },
  { key: "argyle", name: "Argyle", desc: "Sweater-style diamond motion", cat: G, lat: smooth(gauss(0.1), 48), layers: cross(3), period: 12, fit: true },
  { key: "lattice", name: "Lattice", desc: "Crossing diagonal strips", cat: G, lat: smooth(gauss(0.12), 48), layers: cross(5), period: 7, fit: true },
  { key: "fishnet", name: "Fishnet", desc: "Open net of thin diagonal lines", cat: G, lat: smooth(gauss(0.05), 48), layers: cross(6), amp: 0.4, period: 7, fit: true },
  { key: "quilted", name: "Quilted", desc: "Soft puffy squares like a quilt", cat: G, lat: smooth(bump, 24), layers: lay(180, "alternate", 14), period: 9, fit: true },
  { key: "tiles", name: "Tiles", desc: "Square tiles with thin grooves", cat: G, lat: jumps([[0, 1], [0.94, -1]]), layers: lay(0, "steady", 1, 22, 2), amp: 0.3, period: 9, fit: true },
  { key: "golf-ball", name: "Golf ball", desc: "Rows of round dimples, offset", cat: G, lat: sharp((u) => (Math.abs(u - 0.5) < 0.3 ? 1 - 2 * Math.sqrt(1 - ((u - 0.5) / 0.3) ** 2) : 1), 80), layers: lay(180, "alternate", 8), amp: 0.4, period: 4, fit: true },
  { key: "studs", name: "Studded", desc: "Raised round studs in offset rows", cat: G, lat: smooth(gauss(0.12), 32), layers: lay(180, "alternate", 8), period: 4, fit: true },
  // ── Ribs, twists & stripes ──
  { key: "ribs", name: "Vertical ribs", desc: "Straight up-and-down ribs", cat: V, lat: smooth(sine), fit: true, period: 5 },
  { key: "fluted", name: "Fluted column", desc: "Rounded grooves like a Greek column", cat: V, lat: smooth((u) => -bump(u), 24), fit: true, period: 6 },
  { key: "corduroy", name: "Corduroy", desc: "Fine soft vertical cords", cat: V, lat: smooth(bump, 24), fit: true, amp: 0.3, period: 2 },
  { key: "pleats", name: "Pleats", desc: "Folded fabric pleats", cat: V, lat: sharp(saw), fit: true, period: 6 },
  { key: "twist", name: "Twist", desc: "Ribs that spiral up the wall", cat: V, lat: smooth(sine), layers: lay(3, "steady"), fit: true, period: 5 },
  { key: "fast-twist", name: "Fast twist", desc: "Tightly spiralling ribs", cat: V, lat: smooth(sine), layers: lay(8, "steady"), fit: true, period: 5 },
  { key: "drill", name: "Drill bit", desc: "Sharp spiral grooves", cat: V, lat: sharp(saw), layers: lay(5, "steady"), fit: true, period: 6 },
  { key: "candy-cane", name: "Candy cane", desc: "Wide spiral stripes", cat: V, lat: smooth(softSquare(4), 32), layers: lay(2, "steady"), fit: true, amp: 0.4, period: 10 },
  { key: "zigzag-ribs", name: "Wavy ribs", desc: "Vertical ribs that wiggle left and right", cat: V, lat: smooth(sine), layers: lay(6, "back_and_forth", 30), fit: true, period: 5 },
  { key: "rings", name: "Rings", desc: "Horizontal bands of texture with plain gaps", cat: V, lat: smooth(sine), layers: lay(0, "steady", 1, 10, 10), amp: 0.5, period: 2 },
  { key: "bamboo", name: "Bamboo", desc: "Smooth segments with knobbly joints", cat: V, lat: smooth(bump, 24), layers: lay(0, "steady", 1, 6, 60), amp: 0.7, period: 2 },
  { key: "stripes", name: "Bold stripes", desc: "Thick horizontal stripes of texture", cat: V, lat: smooth(bump, 24), layers: lay(0, "steady", 1, 20, 20), amp: 0.4, period: 2 },
  { key: "pinstripes", name: "Pinstripes", desc: "Thin rough lines around the wall", cat: V, noise: { seed: 3, scale: 1, octaves: 2, persistence: 0.5 }, layers: lay(0, "steady", 1, 2, 12), amp: 0.4, period: 1 },
  // ── Nature & animals ──
  { key: "dragon-scales", name: "Dragon scales", desc: "Overlapping scales in offset rows", cat: N, lat: sharp(scallop, 64), layers: lay(180, "alternate", 10), period: 6, fit: true },
  { key: "pine-cone", name: "Pine cone", desc: "Pointed scales spiralling up", cat: N, lat: sharp(norm((u) => Math.max(-1, 1 - 4 * Math.abs(u - 0.5) ** 1.3 * 2)), 64), layers: lay(30, "steady", 4), period: 7, fit: true },
  { key: "pineapple", name: "Pineapple", desc: "Diamond bumps like pineapple skin", cat: N, lat: smooth(gauss(0.14), 48), layers: { ...lay(15, "shift_hold", 12), cross: true }, period: 8, fit: true },
  { key: "turtle-shell", name: "Turtle shell", desc: "Big six-sided shell plates", cat: N, lat: smooth(gauss(0.07), 48), layers: { ...lay(9, "shift_hold", 20), cross: true }, amp: 0.7, period: 18, fit: true },
  { key: "snakeskin", name: "Snakeskin", desc: "Small diamond scales", cat: N, lat: smooth(gauss(0.12), 32), layers: cross(14), amp: 0.35, period: 3, fit: true },
  { key: "crocodile", name: "Crocodile", desc: "Chunky square scales with rough skin", cat: N, lat: jumps([[0, 1], [0.85, -1]]), layers: lay(180, "alternate", 14), amp: 0.5, period: 9, noise: { seed: 77, scale: 0.1, octaves: 2, persistence: 0.5 }, fit: true },
  { key: "wood-grain", name: "Wood grain", desc: "Long wavy grain lines like timber", cat: N, lat: smooth((u) => 0.3 * sine(u)), layers: lay(2, "steady"), amp: 0.25, period: 40, noise: { seed: 12, scale: 0.08, octaves: 4, persistence: 0.6 } },
  { key: "leaves", name: "Leaves", desc: "Leaf shapes along the wall", cat: N, lat: smooth(norm((u) => Math.sin(Math.PI * u) ** 2 * Math.sin(TAU * 2 * u) + Math.sin(Math.PI * u) ** 3), 48), period: 9, fit: true },
  { key: "feathers", name: "Feathers", desc: "Fine angled strokes like a feather", cat: N, lat: sharp(saw), layers: lay(20, "back_and_forth", 10), amp: 0.3, period: 2, fit: true },
  { key: "waves-sea", name: "Rough sea", desc: "Choppy waves with spray", cat: N, lat: smooth(norm((u) => 1 - 2 * Math.abs(Math.cos(Math.PI * u)) ** 0.6), 24), layers: lay(25, "steady", 3), noise: { seed: 9, scale: 0.15, octaves: 2, persistence: 0.5 }, amp: 0.7, period: 8 },
  { key: "sand-dunes", name: "Sand dunes", desc: "Long sloping ridges", cat: N, lat: smooth(sharkFin, 24), layers: lay(4, "steady", 2), amp: 0.6, period: 14 },
  { key: "cactus", name: "Cactus", desc: "Deep ribs with little spines", cat: N, lat: smooth(sum([1, bump], [0.15, harm(8)]), 64), amp: 0.9, period: 8, fit: true },
  // ── Decor & ornament ──
  { key: "lace", name: "Lace", desc: "Delicate scalloped edging", cat: D, lat: smooth(norm((u) => Math.abs(Math.sin(Math.PI * 4 * u)) * (0.7 + 0.3 * Math.cos(TAU * u))), 64), amp: 0.4, period: 8, fit: true },
  { key: "beading", name: "Bead and reel", desc: "Classic round bead then long reel", cat: D, lat: smooth(norm((u) => Math.exp(-(((u - 0.2) / 0.08) ** 2)) + 0.7 * Math.exp(-(((u - 0.65) / 0.2) ** 2))), 48), period: 8, fit: true },
  { key: "egg-dart", name: "Egg and dart", desc: "Ovals with arrows between, an old classic", cat: D, lat: sharp((u) => (u < 0.7 ? 2 * Math.sqrt(Math.max(0, 1 - ((u - 0.35) / 0.35) ** 2)) - 1 : u < 0.85 ? -1 + 2 * ((u - 0.7) / 0.15) : 1 - 2 * ((u - 0.85) / 0.15)), 96), period: 9, fit: true },
  { key: "greek-key", name: "Greek key", desc: "Square spiral border", cat: D, lat: jumps([[0, 1], [0.15, -1], [0.3, 0.3], [0.45, -0.3], [0.6, 1], [0.75, -1]]), amp: 0.5, period: 12, fit: true },
  { key: "rope-border", name: "Rope border", desc: "Twisted rope band around the wall", cat: D, lat: smooth(sharkFin, 24), layers: lay(30, "steady", 1, 15, 25), amp: 0.6, period: 4 },
  { key: "sunburst", name: "Sunburst", desc: "Rays fanning out", cat: D, lat: sharp(spikes), layers: lay(4, "back_and_forth", 25), period: 6, fit: true },
  { key: "art-deco", name: "Art deco", desc: "Stepped fans and bold lines", cat: D, lat: sharp(stairs(4), 96), layers: lay(180, "alternate", 16), period: 10, fit: true },
  { key: "hearts", name: "Hearts", desc: "Little heart shapes in a row", cat: D, lat: sharp((u) => { const a = Math.abs(u - 0.5) * 2; return a < 0.5 ? 2 * Math.sqrt(Math.max(0, 1 - ((a - 0.25) / 0.25) ** 2)) - 0.6 : 1 - 3.2 * (a - 0.5); }, 96), period: 6, fit: true },
  { key: "stars", name: "Star points", desc: "Five-point star tips along the wall", cat: D, lat: sharp(norm((u) => Math.abs(Math.cos(Math.PI * 5 * u)) ** 3 * 2 - 1), 160), period: 10, fit: true },
  { key: "columns", name: "Colonnade", desc: "Row of columns with gaps", cat: D, lat: smooth(norm((u) => (u > 0.25 && u < 0.75 ? Math.sin(TAU * 3 * (u - 0.25) * 2) * 0.3 + 0.7 : -1)), 64), period: 12, fit: true },
  // ── Surfaces & finishes ──
  { key: "hammered", name: "Hammered metal", desc: "Shallow dents like beaten copper", cat: S, lat: smooth((u) => -bump(u), 24), layers: lay(137, "steady", 5), amp: 0.3, period: 5, noise: { seed: 41, scale: 0.4, octaves: 1, persistence: 0.5 } },
  { key: "stucco", name: "Stucco", desc: "Rough plaster wall", cat: S, amp: 0.4, period: 3, noise: { seed: 23, scale: 1, octaves: 4, persistence: 0.6 } },
  { key: "terrazzo", name: "Terrazzo", desc: "Flecked stone floor look", cat: S, amp: 0.25, period: 2, noise: { seed: 88, scale: 0.5, octaves: 1, persistence: 0.5 }, layers: lay(0, "steady", 1, 3, 2) },
  { key: "linen", name: "Linen", desc: "Fine woven cloth", cat: S, lat: smooth(sine), layers: lay(180, "alternate", 1), amp: 0.15, period: 1, fit: true },
  { key: "canvas", name: "Canvas", desc: "Coarse woven cloth", cat: S, lat: smooth(softSquare(2), 24), layers: lay(180, "alternate", 2), amp: 0.25, period: 2, fit: true },
  { key: "denim", name: "Denim", desc: "Diagonal twill weave like jeans", cat: S, lat: smooth(sine), layers: lay(45, "steady"), amp: 0.2, period: 1.5, fit: true },
  { key: "brushed", name: "Brushed metal", desc: "Very fine lines", cat: S, amp: 0.08, period: 0.6, noise: { seed: 64, scale: 4, octaves: 2, persistence: 0.4 } },
  { key: "knurled", name: "Knurled grip", desc: "Criss-cross grip like a tool handle", cat: S, lat: sharp(tri), layers: cross(30), amp: 0.3, period: 1.6, fit: true },
  { key: "carbon", name: "Carbon weave", desc: "Tight checker weave like carbon fibre", cat: S, lat: smooth(softSquare(3), 24), layers: lay(90, "steady", 3), amp: 0.2, period: 2, fit: true },
  { key: "orange-peel", name: "Orange peel", desc: "Soft dimpled skin", cat: S, lat: smooth((u) => -bump(u), 24), layers: lay(97, "steady", 2), amp: 0.2, period: 1.4 },
  { key: "concrete", name: "Concrete", desc: "Grainy cast surface with pits", cat: S, amp: 0.3, period: 2.5, noise: { seed: 1001, scale: 1, octaves: 5, persistence: 0.45 } },
  ...mathShapes(),
  ...motionShapes(),
];

/** Motions that use up-and-down movement, pauses, blobs and lift-offs. */
function motionShapes(): Shape[] {
  const U = "Up & down", E = "Dots, stitches & jumps";
  const pause = (pct: number, ms: number, blob = 0): MotionEvent => ({ at: { mode: "percent", value: pct }, type: "dwell", params: { ms, blob_mm3: blob } });
  const lift = (pct: number, jump: number): MotionEvent => ({ at: { mode: "percent", value: pct }, type: "retract", params: { length: 0, travel_mm: jump } });
  const plastic = (pct: number, mult: number): MotionEvent => ({ at: { mode: "percent", value: pct }, type: "flow_change", params: { mult } });
  return [
    { key: "z-wave", name: "Rolling top", desc: "The nozzle rises and falls along the wall, like waves on a rim", cat: U, zc: smooth((u) => (1 - Math.cos(TAU * u)) / 2), zamp: 0.6, amp: 0, period: 12, fit: true },
    { key: "z-ripple", name: "Up-down ripple", desc: "Small fast up-and-down ripples", cat: U, zc: smooth((u) => (1 - Math.cos(TAU * u)) / 2), zamp: 0.25, amp: 0, period: 3, fit: true },
    { key: "z-scallop", name: "Scalloped rim", desc: "Rounded humps along the top edge", cat: U, zc: smooth((u) => bump(u) * 0.5 + 0.5, 24), zamp: 0.8, amp: 0, period: 10, fit: true },
    { key: "z-crenel", name: "Crenellated rim", desc: "Castle-top steps up and down", cat: U, zc: smooth((u) => (softSquare(4)(u) + 1) / 2, 32), zamp: 0.6, amp: 0, period: 10, fit: true },
    { key: "z-hammer", name: "Bumpy layers", desc: "Little rises along each layer for a hand-made look", cat: U, zc: smooth((u) => (1.6 + 0.6 * sine(u) + 0.4 * Math.sin(TAU * 3 * u + 1)) / 3.2, 32), zamp: 0.3, amp: 0.2, period: 6, noise: { seed: 17, scale: 0.3, octaves: 2, persistence: 0.5 } },
    { key: "z-wave-side", name: "3D wave", desc: "Goes in and out and up and down together", cat: U, lat: smooth(sine), zc: smooth((u) => (1 + cosine(u)) / 2), zamp: 0.35, amp: 0.6, period: 6, fit: true },
    { key: "z-corkscrew", name: "Corkscrew", desc: "Spirals round the wall, in, up, out and down", cat: U, lat: smooth(sine), zc: smooth((u) => (1 + cosine(u)) / 2), zamp: 0.3, amp: 0.5, period: 4, layers: lay(10, "steady"), fit: true },
    { key: "brick-lock", name: "Interlock", desc: "Every other stretch is lifted half a layer for stronger walls", cat: U, zc: jumps([[0, 0], [0.5, 1]]), zamp: 0.1, amp: 0, period: 10, layers: lay(180, "alternate"), fit: true },
    { key: "layer-stitch", name: "Stitched layers", desc: "Short dips into the layer below to sew layers together", cat: E, zc: sharp((u) => (Math.abs(u - 0.5) < 0.06 ? -(1 - Math.abs(u - 0.5) / 0.06) : 0), 96), zamp: 0.15, amp: 0, period: 8, layers: lay(180, "alternate"), fit: true },
    { key: "dots", name: "Dots", desc: "A little blob at every stop", cat: E, amp: 0, period: 3, events: [pause(0, 250, 1.5)] },
    { key: "big-dots", name: "Big dots", desc: "Bigger, well-spaced blobs", cat: E, amp: 0, period: 6, events: [pause(0, 400, 4)] },
    { key: "pearls", name: "Pearls on a string", desc: "Thin line with round pearls", cat: E, amp: 0, period: 4, flow: flatCurve(0.7), events: [pause(50, 300, 2.5)], limits: [0.5, 1.4] },
    { key: "stipple", name: "Stipple", desc: "Separate dots with a jump between each", cat: E, amp: 0, period: 3, events: [pause(0, 200, 1.2), lift(10, 2.4)] },
    { key: "dashed", name: "Dashed jumps", desc: "Printed dashes with small gaps", cat: E, amp: 0, period: 4, events: [lift(60, 1.4)] },
    { key: "morse-dots", name: "Dot and dash", desc: "Blobs and short dashes taking turns", cat: E, amp: 0, period: 6, events: [pause(0, 250, 1.5), lift(25, 1), lift(75, 0.8)] },
    { key: "thick-thin-steps", name: "Thick then thin", desc: "Half of each repeat thick, half thin", cat: E, amp: 0, period: 6, events: [plastic(0, 1.35), plastic(50, 0.7)] },
    { key: "wave-dots", name: "Wave with dots", desc: "Wave with a blob on every crest", cat: E, lat: smooth(sine), amp: 0.6, period: 5, events: [pause(25, 250, 1.2)] },
    { key: "pause-cool", name: "Cool-down pauses", desc: "Short pauses that let fine details set", cat: E, amp: 0, period: 15, events: [pause(0, 600)] },
  ];
}

/** Geometric figures drawn by moving side-to-side and forward-and-back at once (the nozzle still moves forward overall). */
function mathShapes(): Shape[] {
  const X = "Math curves", out: Shape[] = [];
  const slow = flatCurve(0.6);
  // Lissajous figures: side-to-side a times, forward-back b times per repeat.
  for (const [a, b, label] of [[1, 2, "1:2"], [2, 1, "2:1"], [2, 3, "2:3"], [3, 2, "3:2"], [3, 4, "3:4"], [1, 3, "1:3"], [3, 1, "3:1"], [4, 3, "4:3"]] as [number, number, string][]) {
    out.push({ key: `lissajous-${a}-${b}`, name: `Lissajous ${label}`, desc: `Woven figure: ${a} side swings for every ${b} forward-back swings`, cat: X,
      lat: smooth(harm(a), 48), along: smooth((u) => Math.sin(TAU * b * u + Math.PI / 2), 48), amp: 1.2, period: 2 + 1.2 * Math.max(a, b), speed: slow, fit: true });
  }
  // Rose curves r = cos(kθ), traced as offsets.
  for (const k of [2, 3, 4, 5, 6]) {
    const r = (u: number) => Math.cos(k * TAU * u);
    out.push({ key: `rose-${k}`, name: `Rose · ${k % 2 ? k : 2 * k} petals`, desc: "Flower drawn by a rose curve", cat: X,
      lat: smooth((u) => r(u) * Math.sin(TAU * u), 64), along: smooth((u) => r(u) * Math.cos(TAU * u), 64), amp: 1.5, period: 3.5, speed: slow, fit: true });
  }
  // Cycloids: rolling-wheel paths, from smooth arches to tight loops.
  for (const [k, name] of [[0.6, "Gentle cycloid"], [1, "Cycloid arches"], [1.6, "Looped cycloid"], [2.4, "Tight cycloid"]] as [number, string][]) {
    out.push({ key: `cycloid-${k}`, name, desc: "Path of a point on a rolling wheel", cat: X,
      lat: smooth((u) => -Math.cos(TAU * u), 24), along: smooth((u) => -Math.sin(TAU * u), 24), amp: Math.round(((k * 4) / TAU) * 1000) / 1000, period: 4, speed: k > 1 ? slow : undefined, fit: true });
  }
  // Spirograph (hypotrochoid) shapes.
  for (const [R, rr, d, name] of [[3, 1, 0.8, "Spirograph · 3 lobes"], [4, 1, 0.7, "Spirograph · 4 lobes"], [5, 2, 1.2, "Spirograph · star"], [5, 3, 1, "Spirograph · knot"]] as [number, number, number, string][]) {
    const f = (u: number) => { const t = TAU * u * rr; return [(R - rr) * Math.cos(t) + d * Math.cos(((R - rr) / rr) * t), (R - rr) * Math.sin(t) - d * Math.sin(((R - rr) / rr) * t)]; };
    let m = 0; for (let i = 0; i <= 400; i++) { const [x, y] = f(i / 400); m = Math.max(m, Math.abs(x), Math.abs(y)); }
    out.push({ key: `spiro-${R}-${rr}`, name, desc: "Looping figure like a Spirograph toy", cat: X,
      lat: smooth((u) => f(u)[1] / m, 96), along: smooth((u) => f(u)[0] / m, 96), amp: 1.6, period: 4.5, speed: slow, fit: true });
  }
  out.push({ key: "square-loops", name: "Square loops", desc: "Loops with rounded square corners", cat: X, lat: smooth(softSquare(4), 48), along: smooth((u) => softSquare(4)(frac(u + 0.25)), 48), amp: 1.1, period: 4, speed: slow, fit: true });
  out.push({ key: "triangle-loops", name: "Triangle loops", desc: "Loops with three corners", cat: X, lat: smooth((u) => (Math.sin(TAU * u) + 0.25 * Math.sin(TAU * 2 * u)) / 1.2, 48), along: smooth((u) => (Math.cos(TAU * u) - 0.25 * Math.cos(TAU * 2 * u)) / 1.25, 48), amp: 1.2, period: 4, speed: slow, fit: true });
  out.push({ key: "infinity", name: "Infinity", desc: "Sideways figure eights, bigger and slower", cat: X, lat: smooth((u) => Math.sin(TAU * 2 * u) / 2, 48), along: smooth(sine, 48), amp: 1.8, period: 6, speed: slow, fit: true });
  return out;
}

function build(s: Shape): MotionBrush {
  const curves: Record<CurveKey, Curve> = {
    lateral_offset: s.lat ?? flatCurve(0), along_offset: s.along ?? flatCurve(0), z_offset: s.zc ?? flatCurve(0),
    extrusion_mult: s.flow ?? flatCurve(1), speed_mult: s.speed ?? flatCurve(1),
  };
  const noise = s.noise ? { enabled: true, type: "value" as const, seed: 1, scale: 1, octaves: 3, persistence: 0.5, ...s.noise } : null;
  return {
    id: `preset-${s.key}`, name: s.name, version: 1,
    amplitude: s.amp ?? 0.6, period_mm: s.period ?? 4, phase_deg: 0, repeat_mode: s.fit ? "stretch" : "tile",
    curves, events: structuredClone(s.events ?? []), noise, z_amplitude: s.zamp ?? 0,
    limits: { min_flow_mult: s.limits?.[0] ?? 0.5, max_flow_mult: s.limits?.[1] ?? 1.6 },
    layers: s.layers ?? null,
    tags: ["preset"], category: s.cat, description: s.desc,
  };
}

/** Every built-in motion. Size is set per use with the Size slider. Presets are read-only; editing one saves a copy. */
export const PRESETS: MotionBrush[] = SHAPES.map(build);
