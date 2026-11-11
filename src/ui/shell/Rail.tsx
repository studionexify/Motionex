// Workspace tabs (Prepare / Preview / Device; the motion editor lives in the Motionex tab) shown bottom-left above the slice bar, and the plugin
// helpers. The old left rail is gone: plugins are switched on in File → Plugins and open as inspector tabs.
import { useStore, type Workspace } from '../../state/store';
import { PLUGINS } from '../../plugins/registry';
import { Icon } from '../icons';

export const PLUGIN_COLORS: Record<string, string> = {
  motionex: '#8B5CF6', patternex: '#0EA5E9', hanex: '#F97316', bulnex: '#14B8A6',
  plantex: '#22C55E', lumonex: '#EAB308', clickex: '#EC4899', flenex: '#6366F1',
};

/** Opens a plugin's tab in the print-settings column (clicking the open one again goes back to the settings). */
export function openPlugin(id: string) {
  const s = useStore.getState();
  if (!PLUGINS.some((x) => x.id === id) || !s.plugins.includes(id)) return;
  const on3d = s.workspace === 'prepare' || s.workspace === 'preview';
  const same = on3d && s.dock.open && s.dock.tab === id;
  s.set({ dock: { ...s.dock, open: !same, tab: id }, workspace: on3d ? s.workspace : 'prepare' });
}

/** Turns a plugin on or off (File → Plugins). Turning one on opens its tab. */
export function togglePlugin(id: string) {
  const s = useStore.getState();
  const on = s.plugins.includes(id);
  s.set({
    plugins: on ? s.plugins.filter((x) => x !== id) : [...s.plugins, id],
    dock: on ? { ...s.dock, open: s.dock.tab === id ? false : s.dock.open } : { ...s.dock, open: true, tab: id },
  });
  s.markDirty();
}

export function ModeTabs() {
  const workspace = useStore((s) => s.workspace);
  const set = useStore((s) => s.set);
  const tabs: [Workspace, string, string][] = [['workbench', 'layers', 'Motionex'], ['prepare', 'cube', 'Prepare'], ['preview', 'layers', 'Preview'], ['device', 'device', 'Device']];
  return (
    <div className="sh-modes" role="tablist" aria-label="Workspace">
      {tabs.map(([w, icon, label]) => (
        <button key={w} role="tab" aria-selected={workspace === w} className={workspace === w ? 'on' : ''} onClick={() => set({ workspace: w })}>
          <Icon name={icon} size={15} />{label}
        </button>
      ))}
    </div>
  );
}
