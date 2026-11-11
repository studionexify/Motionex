// Runs enabled plugins. Order is fixed by this list: Hanex first (it replaces whole regions of a
// layer, so Motionex must not have bent paths it then removes); Patternex shifts change points after
// Motionex has changed path lengths (spec §8). Bulnex repeats the finished program, so it runs last.
import type { LayerOps } from '../engine/gcode';
import type { EnginePlugin, PluginContext, PluginSession, PrepareContext } from './api';
import { motionexEngine } from './motionex/engine';
import { patternexEngine } from './patternex/engine';
import { hanexEngine } from './hanex/engine';
import { bulnexEngine } from './bulnex/engine';

export const ENGINE_PLUGINS: EnginePlugin<any, any>[] = [hanexEngine, motionexEngine, patternexEngine, bulnexEngine];

export interface PluginRun { header: string[]; reports: Record<string, unknown> }
export type Sessions = Map<string, PluginSession>;

export function preparePlugins(configs: Record<string, unknown> | undefined, ctx: PrepareContext): Sessions {
  const out: Sessions = new Map();
  if (!configs) return out;
  for (const p of ENGINE_PLUGINS) {
    const config = configs[p.id];
    if (config === undefined || !p.prepare) continue;
    const s = p.prepare(config, ctx);
    if (s) out.set(p.id, s);
  }
  return out;
}

export function runPlugins(layers: LayerOps[], configs: Record<string, unknown> | undefined, ctx: Omit<PluginContext, 'session' | 'sharedRegions'>, sessions: Sessions = new Map()): PluginRun {
  const header: string[] = [];
  const reports: Record<string, unknown> = {};
  if (!configs) return { header, reports };
  const sharedRegions = [...sessions.values()].flatMap((s) => s.sharedRegions?.() ?? []);
  for (const p of ENGINE_PLUGINS) {
    const config = configs[p.id];
    if (config === undefined) continue;
    reports[p.id] = p.postToolpath(layers, config, { ...ctx, sharedRegions, session: sessions.get(p.id) });
    header.push(`; plugin: ${p.name} ${p.version}`, ...(p.gcodeHeader?.(config) ?? []));
  }
  return { header, reports };
}

/** Lets plugins rewrite the program body (between start and end G-code), in plugin order. */
export function programBodyPlugins(configs: Record<string, unknown> | undefined, ctx: Omit<PluginContext, 'session' | 'sharedRegions'>, sessions: Sessions): ((body: string[]) => string[]) | undefined {
  if (!configs) return undefined;
  const active = ENGINE_PLUGINS.filter((p) => p.programBody && configs[p.id] !== undefined);
  if (!active.length) return undefined;
  return (body) => active.reduce((b, p) => p.programBody!(b, configs[p.id], { ...ctx, sharedRegions: [], session: sessions.get(p.id) }), body);
}
