// Renex render setups and user profiles. A setup is everything that decides the picture (scene, light,
// camera, output, print appearance, props). Users save setups as named profiles and reuse them across
// designs; the last setup per studio is remembered.
import type { FinishKind } from './materials';
import type { SeamMode, SupportMode } from './printSurface';
import type { BackdropId, EnvId, ShotId } from './scenes';
import type { TopDressing } from './components';

export type Quality = 'fast' | 'medium' | 'slow';
export type ToneMap = 'agx' | 'aces' | 'neutral';
export type Layout = 'assembled' | 'exploded' | 'parts' | 'custom';
export type RenexSource = 'plantex' | 'lumonex';

export interface QualityPreset { id: Quality; name: string; samples: number; bounces: number; transmissiveBounces: number; filterGlossy: number; note: string }

export const QUALITY: Record<Quality, QualityPreset> = {
  fast: { id: 'fast', name: 'Fast', samples: 96, bounces: 5, transmissiveBounces: 6, filterGlossy: 0.5, note: 'Preview grade · seconds' },
  medium: { id: 'medium', name: 'Medium', samples: 640, bounces: 9, transmissiveBounces: 12, filterGlossy: 0.25, note: 'Web / social grade · about a minute' },
  slow: { id: 'slow', name: 'Slow (final)', samples: 3000, bounces: 16, transmissiveBounces: 24, filterGlossy: 0, note: 'Print / hero grade · several minutes' },
};

export interface PlantPick { id: string; scale: number; seed: number }
export interface PartLook { finish?: FinishKind; hex?: string; hidden?: boolean; offset?: [number, number, number]; spin?: number }
export interface Watermark { enabled: boolean; text: string; corner: 'br' | 'bl' | 'tr' | 'tl'; opacity: number; size: number }

export interface RenderSetup {
  env: EnvId;
  envRotation: number;
  /** Exposure compensation (EV) on top of the metered (or the environment's suggested) exposure. */
  evComp: number;
  /** Meter the product like a camera; off = fixed exposure from the environment's EV100. */
  autoExposure: boolean;
  toneMap: ToneMap;
  backdrop: BackdropId;
  backdropColour: string;
  shot: ShotId;
  az: number; el: number; focal: number; fNumber: number; dolly: number; focusZ: number; blades: number;
  width: number; height: number; aspect: string;
  quality: Quality;
  // print appearance
  supports: SupportMode;
  seam: SeamMode | 'from-settings';
  layerLines: number;
  texturedBed: boolean;
  // lamp
  lit: boolean;
  kelvin: number;
  glass: 'clear' | 'opal' | 'amber';
  cordColour: string;
  cordFabric: 'braided' | 'pvc' | 'twisted';
  plug: 'eu' | 'uk' | 'us' | 'in' | 'none';
  holderFinish: 'bakelite' | 'ceramic' | 'brass';
  feltPads: boolean;
  // planter
  plants: PlantPick[];
  dressing: TopDressing;
  moisture: number;
  saucerWater: boolean;
  // layout
  layout: Layout;
  parts: Record<string, PartLook>;
  // output
  format: 'png' | 'jpeg';
  jpegQuality: number;
  transparent: boolean;
  watermark: Watermark;
  denoise: boolean;
  /** Also store each exported render in the project (.3mf photos). */
  saveToProject: boolean;
}

export const ASPECTS: { id: string; name: string; w: number; h: number }[] = [
  { id: '1:1', name: 'Square 1:1 (Instagram, Etsy)', w: 2048, h: 2048 },
  { id: '4:5', name: 'Portrait 4:5 (Instagram feed)', w: 1638, h: 2048 },
  { id: '9:16', name: 'Story 9:16 (Reels, TikTok)', w: 1152, h: 2048 },
  { id: '3:2', name: 'Landscape 3:2 (camera)', w: 2400, h: 1600 },
  { id: '4:3', name: 'Landscape 4:3 (Etsy listing)', w: 2400, h: 1800 },
  { id: '16:9', name: 'Wide 16:9 (web hero, YouTube)', w: 2560, h: 1440 },
  { id: '2:3', name: 'Portrait 2:3 (Pinterest)', w: 1600, h: 2400 },
  { id: '4k', name: '4K UHD 3840×2160', w: 3840, h: 2160 },
  { id: 'a4', name: 'A4 print @300 dpi', w: 2480, h: 3508 },
  { id: 'custom', name: 'Custom', w: 2000, h: 2000 },
];

export function defaultSetup(source: RenexSource): RenderSetup {
  const lamp = source === 'lumonex';
  return {
    env: lamp ? 'evening-interior' : 'studio-softbox', envRotation: 0, evComp: 0, autoExposure: true, toneMap: 'agx',
    backdrop: lamp ? 'oak-table' : 'sweep', backdropColour: '#e9e4dc',
    shot: 'hero', az: 35, el: 18, focal: 85, fNumber: 8, dolly: 1, focusZ: 0, blades: 9,
    width: 2048, height: 2048, aspect: '1:1', quality: 'medium',
    supports: 'off', seam: 'from-settings', layerLines: 1, texturedBed: true,
    lit: true, kelvin: 2700, glass: 'clear', cordColour: '#1c1c1c', cordFabric: 'braided', plug: 'eu', holderFinish: 'bakelite', feltPads: true,
    plants: lamp ? [] : [{ id: 'echeveria-lola', scale: 1, seed: 1 }], dressing: 'soil', moisture: 0.2, saucerWater: false,
    layout: 'assembled', parts: {},
    format: 'png', jpegQuality: 0.92, transparent: false,
    watermark: { enabled: false, text: 'Rendered with NexSpiro Renex', corner: 'br', opacity: 0.6, size: 1 },
    denoise: true,
    saveToProject: true,
  };
}

/** Batch export: every combination of the chosen sizes, shots and (lamps) light states. */
export interface BatchSpec { aspects: string[]; shots: ShotId[]; light: 'current' | 'both'; /** Live-view raster (instant) or path traced at the setup's quality. */ mode?: 'realtime' | 'final' }

export function batchJobs(base: RenderSetup, b: BatchSpec, shots: { id: ShotId; az: number; el: number; focal: number; fNumber: number }[], isLamp: boolean): { label: string; setup: RenderSetup }[] {
  const out: { label: string; setup: RenderSetup }[] = [];
  const aspects = b.aspects.length ? b.aspects : [base.aspect];
  const shotIds = b.shots.length ? b.shots : [base.shot];
  const lights = isLamp && b.light === 'both' ? [true, false] : [base.lit];
  for (const a of aspects) {
    const asp = ASPECTS.find((x) => x.id === a);
    for (const sid of shotIds) {
      const sh = shots.find((x) => x.id === sid);
      for (const lit of lights) {
        const setup: RenderSetup = { ...base, lit, ...(asp && asp.id !== 'custom' ? { aspect: asp.id, width: asp.w, height: asp.h } : {}), ...(sh && sid !== base.shot ? { shot: sid, az: sh.az, el: sh.el, focal: sh.focal, fNumber: sh.fNumber, dolly: 1 } : {}) };
        out.push({ label: [a, sid, isLamp ? (lit ? 'on' : 'off') : ''].filter(Boolean).join('-').replace(/[^\w-]+/g, '_'), setup });
      }
    }
  }
  return out;
}

export interface RenderProfile { id: string; name: string; source: RenexSource | 'any'; setup: RenderSetup; createdAt: number }

const KEY = 'nexspiro.renex.profiles.v1';
const LAST = 'nexspiro.renex.last.v1';
const storage = typeof localStorage !== 'undefined' ? localStorage : null;

/** Built-in starting points (read-only). */
export function builtinProfiles(): RenderProfile[] {
  const b = (id: string, name: string, source: RenexSource | 'any', patch: Partial<RenderSetup>): RenderProfile => ({ id, name, source, createdAt: 0, setup: { ...defaultSetup(source === 'lumonex' ? 'lumonex' : 'plantex'), ...patch } });
  return [
    b('bi-etsy', 'Etsy listing · white sweep', 'any', { env: 'studio-highkey', backdrop: 'sweep', backdropColour: '#f4f2ee', aspect: '4:3', width: 2400, height: 1800, shot: 'hero' }),
    b('bi-insta', 'Instagram · warm oak', 'any', { env: 'daylight-window', backdrop: 'oak-table', aspect: '4:5', width: 1638, height: 2048 }),
    b('bi-moody', 'Moody low-key', 'any', { env: 'studio-dark', backdrop: 'concrete', shot: 'low-hero', fNumber: 4 }),
    b('bi-macro', 'Layer-line macro', 'any', { shot: 'detail', focal: 100, fNumber: 2.8, az: 30, el: 10, quality: 'slow' }),
    b('bi-flatlay', 'Flat-lay of printed parts', 'any', { shot: 'top-down', layout: 'parts', backdrop: 'linen', env: 'overcast' }),
    b('bi-lamp-night', 'Lamp · night glow', 'lumonex', { env: 'night', lit: true, backdrop: 'living-room', kelvin: 2400 }),
    b('bi-lamp-day', 'Lamp · daylight, off', 'lumonex', { env: 'daylight-window', lit: false, backdrop: 'shelf' }),
    b('bi-planter-sill', 'Planter · windowsill', 'plantex', { env: 'daylight-window', backdrop: 'windowsill', moisture: 0.5 }),
    b('bi-planter-sun', 'Planter · golden hour', 'plantex', { env: 'golden-hour', backdrop: 'terrazzo' }),
  ];
}

export function loadProfiles(): RenderProfile[] {
  try { return (JSON.parse(storage?.getItem(KEY) ?? '[]') as RenderProfile[]).map((p) => ({ ...p, setup: { ...defaultSetup(p.source === 'lumonex' ? 'lumonex' : 'plantex'), ...p.setup } })); } catch { return []; }
}
export function saveProfiles(list: RenderProfile[]) { try { storage?.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable */ } }

export function addProfile(name: string, source: RenexSource | 'any', setup: RenderSetup): RenderProfile {
  const p: RenderProfile = { id: `rp${Date.now().toString(36)}`, name: name.trim() || 'My render setup', source, setup: structuredClone(setup), createdAt: Date.now() };
  saveProfiles([...loadProfiles().filter((x) => x.name !== p.name), p]);
  return p;
}
export function deleteProfile(id: string) { saveProfiles(loadProfiles().filter((p) => p.id !== id)); }

export function lastSetup(source: RenexSource): RenderSetup {
  try { const all = JSON.parse(storage?.getItem(LAST) ?? '{}'); return { ...defaultSetup(source), ...(all[source] ?? {}) }; } catch { return defaultSetup(source); }
}
export function rememberSetup(source: RenexSource, s: RenderSetup) {
  try { const all = JSON.parse(storage?.getItem(LAST) ?? '{}'); all[source] = s; storage?.setItem(LAST, JSON.stringify(all)); } catch { /* storage unavailable */ }
}

/** Profiles that fit a studio: its own plus the shared ones. */
export const profilesFor = (source: RenexSource) => [...builtinProfiles(), ...loadProfiles()].filter((p) => p.source === 'any' || p.source === source);
