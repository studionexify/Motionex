// Hands an SVG dropped on the canvas over to the Text / Emboss tool, which owns SVG import.
let pending: { name: string; text: string } | null = null;
const subs = new Set<() => void>();
export function offerSvg(name: string, text: string) { pending = { name, text }; subs.forEach((f) => f()); }
export function takeSvg() { const p = pending; pending = null; return p; }
export function onSvgOffered(f: () => void) { subs.add(f); return () => { subs.delete(f); }; }
