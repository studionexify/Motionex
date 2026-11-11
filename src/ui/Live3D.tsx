// Live 3D switch: every studio preview that renders a WebGL scene sits inside <Live3D>. Off, the scene is not
// mounted at all (no GPU work), and a flat stand-in shows instead. The choice is remembered and shared app-wide;
// it can be flipped from any preview or from Preferences.
import { useSyncExternalStore, type ReactNode } from 'react';

const LS = 'nexspiro.live3d';
let on = (() => { try { return localStorage.getItem(LS) !== '0'; } catch { return true; } })();
const subs = new Set<() => void>();
export function setLive3D(v: boolean) {
  on = v; subs.forEach((f) => f());
  try { localStorage.setItem(LS, v ? '1' : '0'); } catch { /* storage off */ }
}
export const useLive3D = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => on);

/** Compact segmented switch: Live 3D | Flat. */
export function Live3DToggle({ className = '' }: { className?: string }) {
  const v = useLive3D();
  return (
    <div className={`seg live3d-toggle ${className}`} role="group" aria-label="Preview mode">
      <button className={v ? 'on' : ''} aria-pressed={v} onClick={() => setLive3D(true)} title="Render the live 3D preview (uses the GPU)">Live 3D</button>
      <button className={!v ? 'on' : ''} aria-pressed={!v} onClick={() => setLive3D(false)} title="Show a flat image instead; lighter on slow machines">Flat</button>
    </div>
  );
}

/** Mounts children only while live 3D is on; otherwise shows `flat` (or a plain stand-in). Always shows the switch. */
export function Live3D({ children, flat, label = 'Live 3D preview is off' }: { children: ReactNode; flat?: ReactNode; label?: string }) {
  const v = useLive3D();
  return (
    <>
      {v ? children : (
        <div className="live3d-off">
          {flat}
          {!flat && <div className="live3d-msg"><b>{label}</b><span>Turn it on to see the model in 3D.</span>
            <button className="btn-secondary btn-small" onClick={() => setLive3D(true)}>Show live 3D</button></div>}
        </div>
      )}
      <Live3DToggle className="live3d-float" />
    </>
  );
}
