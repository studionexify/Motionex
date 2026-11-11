// Derived Advanced-mode data for the UI: machine capabilities, the resolved technology list and the
// tools built on it, computed with the same functions the slicing worker uses.
import { useMemo } from 'react';
import { machineCaps } from '../../engine/advanced/machine';
import { resolveTechs, type ResolvedTech } from '../../engine/advanced/techs';
import { TOOLS, type ToolDef } from '../../engine/advanced/tools';
import { filamentById } from '../../profiles/filaments';
import { resolveConfig } from '../../profiles/resolve';
import { useAdvanced } from '../../state/advanced';
import { useStore } from '../../state/store';

export function useCaps() {
  const s = useStore();
  const machine = useAdvanced((a) => a.machine);
  return useMemo(() => {
    const cfg = resolveConfig({ printerId: s.printerId, plate: s.plate, filamentId: s.filaments[0].presetId, presetId: s.presetId, overrides: s.overrides, machineOverrides: s.machineOverrides });
    return { caps: machineCaps(s.printerId, cfg, machine), cfg };
  }, [s.printerId, s.plate, s.filaments, s.presetId, s.overrides, s.machineOverrides, machine]);
}

export function useResolved() {
  const { caps, cfg } = useCaps();
  const a = useAdvanced();
  const objects = useStore((s) => s.objects);
  const filaments = useStore((s) => s.filaments);
  return useMemo(() => {
    const used = new Set<number>();
    for (const o of objects) { used.add(o.filament ?? 0); o.paint?.color?.forEach((c) => { if (c) used.add(c - 1); }); }
    return resolveTechs({ intent: a.intent, printerId: caps.printerId, techs: a.techs, tools: a.tools, machine: a.machine }, {
      caps, filamentType: filamentById(filaments[0].presetId).type, materials: used.size,
      wallLoops: Math.round(Number(cfg.wall_loops ?? 2)), hasCaustic: !!a.caustic?.pixels.length,
    });
  }, [caps, cfg, a.intent, a.techs, a.tools, a.machine, a.caustic, objects, filaments]);
}

export interface ResolvedTool {
  def: ToolDef;
  /** Every technology of the tool, in its order. */
  parts: ResolvedTech[];
  /** The ones that run. */
  active: ResolvedTech[];
  enabled: boolean;
  /** Switched by the user rather than by the intent. */
  forced: boolean;
}

export function useTools(): ResolvedTool[] {
  const resolved = useResolved();
  const tools = useAdvanced((a) => a.tools);
  const techs = useAdvanced((a) => a.techs);
  return useMemo(() => {
    const byId = new Map(resolved.map((r) => [r.def.id, r]));
    return TOOLS.map((def) => {
      const parts = def.techs.map((id) => byId.get(id)!);
      const active = parts.filter((r) => r.enabled);
      return { def, parts, active, enabled: active.length > 0, forced: !!tools[def.id] || def.techs.some((id) => techs[id]?.enabled !== undefined) };
    });
  }, [resolved, tools, techs]);
}
