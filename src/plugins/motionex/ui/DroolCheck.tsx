// Drool check card: how far the threads sit from the layer below in the toolpath view, worked out ahead of
// slicing. Up to the safe reach the thread is held up; beyond it the thread sags, and further out hot plastic drips.
import { useDrool } from '../../droolState';
import { useStore } from '../../../state/store';

export function DroolCheck() {
  const d = useDrool();
  const on = useStore((s) => s.liveToolpaths);
  if (!on || !d || !d.beads) return null;
  const mm = (v: number) => `${v.toFixed(2)} mm`;
  const rows: [boolean, string][] = [
    [d.level === 'ok', `Furthest reach from the layer below: ${mm(d.worstMm)} (held up to ${mm(d.safeMm)})`],
    [d.sagging === 0, d.sagging ? `${d.sagging} threads sag` : 'No threads sag'],
    [d.drips === 0, d.drips ? `${d.drips} hot drips where threads reach past ${mm(d.dripMm)}` : `No drips (they start past ${mm(d.dripMm)})`],
  ];
  if (d.strings) rows.push([false, `${d.strings} long travels leave strings: add a pull-back (retract) to the motion`]);
  return (
    <section className="mx-card">
      <div className="mx-card-title">Drool check</div>
      {rows.map(([ok, t], k) => <div key={k} className="mx-check"><span className={ok ? 'ok' : 'bad'}>{ok ? '✓' : '!'}</span>{t}</div>)}
      {d.level !== 'ok' && <div className="mx-muted" style={{ margin: 0, display: 'block' }}>Lower the depth or the pull-in, or make the motion lean over more layers, until the reach is under {mm(d.dripMm)} (best under {mm(d.safeMm)}). The check is worked out from the preview, so it needs no slicing.</div>}
      {d.thinned && <div className="mx-muted" style={{ margin: 0, display: 'block' }}>The view was thinned to stay fast; the real print has every thread.</div>}
    </section>
  );
}
