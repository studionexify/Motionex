// Reopening a plugin step of a plate object in its Studio: the generator's design is loaded and bound to the
// objects it made (sending it back replaces them in place); Patternex and Motionex open on the object.
import { useStore, type SceneObject } from '../state/store';
import { designOf, type PluginStep } from '../state/steps';
import { PLUGINS } from './registry';
import { studioOf } from './studios';
import * as clickex from './clickex/ui/state';
import * as lumonex from './lumonex/ui/state';
import * as plantex from './plantex/ui/state';
import * as flenex from './flenex/ui/state';

const BIND: Record<string, { setPlaced: (ids: string[]) => void; applyPlateColours: (objs: SceneObject[]) => void }> = { clickex, lumonex, plantex, flenex };

/** Open a step of an object in its Studio. Returns false when its design is not available (older project). */
export function editStep(o: SceneObject, step: PluginStep): boolean {
  const s = useStore.getState();
  if (step.plugin === 'patternex' || step.plugin === 'motionex') {
    s.set({ selected: [o.id], selectedPart: null });
    studioOf(step.plugin)?.open();
    return true;
  }
  const d = designOf(o);
  const p = PLUGINS.find((x) => x.id === step.plugin);
  if (!d || !p?.loadProjectData || !BIND[step.plugin]) { s.set({ toast: { kind: 'warn', text: `The ${step.plugin} design of ${o.name} was not saved with it, so it cannot be reopened.` } }); return false; }
  p.loadProjectData(structuredClone(d.spec));
  const b = BIND[step.plugin];
  b.setPlaced(d.objects.map((x) => x.id));
  b.applyPlateColours(d.objects);
  s.set({ selected: d.objects.map((x) => x.id), selectedPart: null });
  studioOf(step.plugin)?.open();
  return true;
}
