// Bottom-left view toggles and bottom-right camera buttons.
import { useStore } from '../../state/store';
import { viewApi } from '../../viewport/Viewport';
import { Icon } from '../icons';

export function ViewBar() {
  const { liveToolpaths, threadView, showOverhangs, set, workspace } = useStore();
  return (
    <div className="float sh-float sh-viewbar">
      {(workspace === 'prepare' || workspace === 'motion') && (
        <button className="sh-ib" aria-pressed={liveToolpaths} onClick={() => set({ liveToolpaths: !liveToolpaths })}
          title="Toolpath view: draw the walls on the model in their filament colours and motions, instantly, without slicing">
          <span className={`sh-switch ${liveToolpaths ? 'on' : ''}`} aria-hidden="true" />Toolpath view
        </button>
      )}
      {(workspace === 'prepare' || workspace === 'motion') && liveToolpaths && (
        <button className={`sh-ib ${threadView ? 'on' : ''}`} aria-pressed={threadView} onClick={() => set({ threadView: !threadView })}
          title="Thick-thread view: draw every move at its real line width and layer height, as it looks when printed. Turn off for single lines.">
          <Icon name="layers" size={16} />Thick thread
        </button>
      )}
      <button className={`sh-ib ${showOverhangs ? 'on' : ''}`} aria-pressed={showOverhangs} title="Highlight overhangs" onClick={() => set({ showOverhangs: !showOverhangs })}>
        <Icon name="overhang" size={16} />Overhangs
      </button>
    </div>
  );
}

export function CameraBar() {
  return (
    <div className="float sh-float sh-camera">
      <button className="sh-ib" title="Fit (Z)" aria-label="Fit" onClick={() => viewApi.current?.fit()}><Icon name="fit" size={16} /></button>
      <button className="sh-ib" title="Default view (Ctrl+0)" aria-label="Isometric view" onClick={() => viewApi.current?.setView('iso')}><Icon name="view" size={16} /></button>
      <button className="sh-ib" title="Top view (Ctrl+1)" aria-label="Top view" onClick={() => viewApi.current?.setView('top')}><Icon name="plate" size={16} /></button>
    </div>
  );
}
