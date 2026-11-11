// Brush save/load. JSON in, JSON out; user library persisted in browser storage when present.
import { CURVE_KEYS, flatCurve, CURVE_INFO, type MotionBrush } from "./model";
import { PRESETS } from "./presets";

const STORAGE_KEY = "nexspiro.motionex.library.v1";

export function serializeBrush(b: MotionBrush): string { return JSON.stringify({ format: "motionex-brush", ...b }, null, 2); }

/** Parse and validate a brush; missing curves become neutral. Throws with a readable message. */
export function parseBrush(json: string): MotionBrush {
  const o = JSON.parse(json);
  if (typeof o !== "object" || !o) throw new Error("not a brush object");
  for (const f of ["id", "name"] as const) if (typeof o[f] !== "string") throw new Error(`missing ${f}`);
  for (const f of ["amplitude", "period_mm"] as const) if (!(typeof o[f] === "number" && o[f] >= 0)) throw new Error(`invalid ${f}`);
  if (o.period_mm <= 0) throw new Error("period_mm must be > 0");
  if (!["tile", "once", "stretch"].includes(o.repeat_mode)) throw new Error("invalid repeat_mode");
  const curves = o.curves ?? {};
  for (const k of CURVE_KEYS) {
    const c = curves[k] ?? flatCurve(CURVE_INFO[k].neutral);
    if (!Array.isArray(c.points) || c.points.length === 0) throw new Error(`curve ${k} has no points`);
    if (!["bezier", "linear", "step"].includes(c.interpolation)) throw new Error(`curve ${k} interpolation`);
    c.points.sort((a: { t: number }, b: { t: number }) => a.t - b.t);
    curves[k] = c;
  }
  const { format: _f, ...rest } = o;
  return {
    version: 1, phase_deg: 0, events: [], noise: null, limits: { min_flow_mult: 0.5, max_flow_mult: 1.6 },
    ...rest, curves,
  } as MotionBrush;
}

export interface KeyValueStore { getItem(k: string): string | null; setItem(k: string, v: string): void }

export class BrushLibrary {
  private user: MotionBrush[] = [];
  private store: KeyValueStore | null;
  constructor(store: KeyValueStore | null) {
    this.store = store;
    try {
      const raw = store?.getItem(STORAGE_KEY);
      if (raw) this.user = (JSON.parse(raw) as unknown[]).map((b) => parseBrush(JSON.stringify(b)));
    } catch { this.user = []; }
  }
  all(): MotionBrush[] { return [...PRESETS, ...this.user]; }
  user_brushes(): MotionBrush[] { return this.user; }
  get(id: string): MotionBrush | undefined { return this.all().find((b) => b.id === id); }
  isPreset(id: string): boolean { return PRESETS.some((b) => b.id === id); }
  /** Saves a brush; presets are never overwritten — a copy with a new id is stored instead. Returns the stored brush. */
  save(b: MotionBrush): MotionBrush {
    let copy = structuredClone(b);
    if (this.isPreset(copy.id)) copy = { ...copy, id: `user-${Date.now().toString(36)}`, name: `${copy.name} (custom)`, tags: ["custom"] };
    const i = this.user.findIndex((u) => u.id === copy.id);
    if (i >= 0) { copy.version = this.user[i].version + 1; this.user[i] = copy; } else this.user.push(copy);
    this.persist();
    return copy;
  }
  remove(id: string): void { this.user = this.user.filter((b) => b.id !== id); this.persist(); }
  private persist(): void { try { this.store?.setItem(STORAGE_KEY, JSON.stringify(this.user)); } catch { /* storage unavailable */ } }
}
