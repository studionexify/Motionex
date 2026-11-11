// UI side of the plugin system: which plugins exist, which are installed, and what each one
// sends to the slicing worker. A plugin adds a tab to the right dock only while installed.
import type { ComponentType } from 'react';
import type { FaceSet } from '../engine/types';
import { useStore } from '../state/store';
import type { PluginPreview } from './threads';
import { loadMotionexProject, motionexConfig, motionexProject, MotionexPanel, motionexPreview, mx } from './motionex/ui/MotionexPanel';
import { MotionStudio } from './motionex/ui/MotionStudio';
import { toConfig } from './motionex';
import { patternexConfig, patternexMotionApps, PatternexPanel, px } from './patternex/ui/PatternexPanel';
import { patternexPreview } from './patternex/ui/preview';
import { hanexConfig, HanexPanel } from './hanex/ui/HanexPanel';
import { bulnexConfig, BulnexPanel } from './bulnex/ui/BulnexPanel';
import { PlantexPanel } from './plantex/ui/PlantexPanel';
import { loadPlantexProject, plantexProject } from './plantex/ui/state';
import { LumonexPanel } from './lumonex/ui/LumonexPanel';
import { loadProject as loadLumonexProject, projectData as lumonexProject } from './lumonex/ui/state';
import { ClickexPanel } from './clickex/ui/ClickexPanel';
import { clickexProject, loadClickexProject } from './clickex/ui/state';
import { FlenexPanel } from './flenex/ui/FlenexPanel';
import { loadProject as loadFlenexProject, projectData as flenexProject } from './flenex/ui/state';

export interface UiPlugin {
  id: string;
  name: string;
  description: string;
  /** One or two letters for the dock tab. */
  badge: string;
  Panel: ComponentType;
  /** Plain-data config for the slicer, or undefined when the plugin has nothing to do. */
  sliceConfig(): unknown;
  /** Quick preview lines drawn on the model in Prepare (no slicing), or null for none. */
  preview?(): PluginPreview | null;
  /** Full-height editor shown beside the 3D view in the Motion tab. */
  Studio?: ComponentType;
  /** Plain data saved in the project file, and restored when the project is opened. */
  projectData?(): unknown;
  loadProjectData?(data: unknown): void;
}

export const PLUGINS: UiPlugin[] = [
  {
    id: 'motionex', name: 'Motionex', badge: 'M',
    description: 'Waves, loops, dots and textures on the walls of your print.',
    Panel: MotionexPanel,
    sliceConfig: () => {
      const printerId = useStore.getState().printerId;
      // Patternex regions that carry a motion become Motionex applications targeting that region
      const extra = useStore.getState().plugins.includes('patternex') ? patternexMotionApps() : [];
      const base = motionexConfig(printerId);
      if (!extra.length) return base;
      const c = base ?? { ...toConfig(mx, printerId), applications: [] };
      const have = new Set(c.brushes.map((b) => b.id));
      const brushes = [...c.brushes, ...extra.map((a) => a.brush_id).filter((id, i, l) => !have.has(id) && l.indexOf(id) === i).map((id) => mx.library.get(id)).filter((b): b is NonNullable<typeof b> => !!b).map((b) => structuredClone(b))];
      return { ...c, applications: [...c.applications, ...extra], brushes };
    },
    preview: motionexPreview,
    projectData: () => motionexProject(),
    loadProjectData: (d) => loadMotionexProject(d),
    Studio: MotionStudio,
  },
  {
    id: 'patternex', name: 'Patternex', badge: 'P',
    description: 'SVG and pattern artwork on the surface, with a filament change (AMS) or a manual swap inside each region.',
    Panel: PatternexPanel,
    sliceConfig: () => patternexConfig(),
    preview: () => patternexPreview(px),
  },
  {
    id: 'hanex', name: 'Hanex', badge: 'H',
    description: 'Flat and rising overhangs printed in mid-air with wave toolpaths, no supports.',
    Panel: HanexPanel,
    sliceConfig: () => hanexConfig(useStore.getState().printerId),
  },
  {
    id: 'bulnex', name: 'Bulnex', badge: 'B',
    description: 'Bulk production: print one part (or a row of copies) again and again, pushing the parts off the plate between prints. Camera monitor with phone alerts.',
    Panel: BulnexPanel,
    sliceConfig: () => bulnexConfig(),
  },
  {
    id: 'plantex', name: 'Plantex', badge: 'Pt',
    description: 'Design vases and planters: profiles, cross-sections, twist, textures (emboss, deboss, cut through) with reference planes, drain holes and saucers.',
    Panel: PlantexPanel,
    // Plantex builds meshes on the plate; nothing to do while slicing
    sliceConfig: () => undefined,
    projectData: () => plantexProject(),
    loadProjectData: (d) => loadPlantexProject(d),
  },
  {
    id: 'lumonex', name: 'Lumonex', badge: 'L',
    description: 'Parametric lamps: shades, bases, holders (E27/E14/B22/GU10/LED), 20 joint types, wall, pendant, floor, floor-to-ceiling, lantern and pipe-mount lamps, sized to your printer.',
    Panel: LumonexPanel,
    // geometry is placed on the plate as ordinary objects, so the slicer needs nothing from Lumonex
    sliceConfig: () => undefined,
    projectData: () => lumonexProject(),
    loadProjectData: (d) => loadLumonexProject(d),
  },
  {
    id: 'clickex', name: 'Clickex', badge: 'C',
    description: 'Fidget clickers from any design: an image, SVG, icon, text, name blocks or a 3D model, built around a mechanical keyboard switch with a live preview.',
    Panel: ClickexPanel,
    // geometry is placed on the plate as ordinary objects, so the slicer needs nothing from Clickex
    sliceConfig: () => undefined,
    projectData: () => clickexProject(),
    loadProjectData: (d) => loadClickexProject(d),
  },
  {
    id: 'flenex', name: 'Flenex', badge: 'F',
    description: 'Print-in-place flexi animals and characters: 47 designs with full body and add-on controls, or import a model and place ball, hinge and swivel cuts. Paint colours, export a coloured 3MF, sized and toleranced for your printer.',
    Panel: FlenexPanel,
    // the flexi is placed on the plate as an ordinary painted object, so the slicer needs nothing from Flenex
    sliceConfig: () => undefined,
    projectData: () => flenexProject(),
    loadProjectData: (d) => loadFlenexProject(d),
  },
];

export const installedPlugins = () => {
  const ids = useStore.getState().plugins;
  return PLUGINS.filter((p) => ids.includes(p.id));
};

export function pluginConfigs(): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const p of installedPlugins()) {
    const c = p.sliceConfig();
    if (c !== undefined) out[p.id] = c;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Data of every installed plugin, for the project file. */
export function pluginProjectData(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of installedPlugins()) if (p.projectData) out[p.id] = p.projectData();
  return out;
}

/** Restore plugin data from a project; installs any plugin the project uses. */
export function loadPluginProjectData(data: Record<string, unknown> | undefined) {
  if (!data) return;
  const s = useStore.getState();
  const ids = Object.keys(data).filter((id) => PLUGINS.some((p) => p.id === id));
  const missing = ids.filter((id) => !s.plugins.includes(id));
  if (missing.length) s.set({ plugins: [...s.plugins, ...missing] });
  for (const id of ids) PLUGINS.find((p) => p.id === id)!.loadProjectData?.(data[id]);
}

/** Surface sets painted or picked on an object (paint.motion values 1..n). */
export function faceSetsOf(motion: Uint8Array | undefined): FaceSet[] | undefined {
  if (!motion) return undefined;
  const by = new Map<number, number[]>();
  motion.forEach((v, t) => { if (v) { const l = by.get(v); if (l) l.push(t); else by.set(v, [t]); } });
  if (!by.size) return undefined;
  return [...by].map(([v, tris]) => ({ id: String(v), name: surfaceName(v), tris: Uint32Array.from(tris) }));
}

export const surfaceName = (n: number) => `Surface ${n}`;
