// Unwrapped wall view of one texture layer (around × height). Drag the pattern to move it, scroll to
// scale it (Shift + scroll: slant), drag the band edges to set where it starts and ends.
import { useEffect, useRef } from 'react';
import type { TextureLayer } from '../model';
import { layerValue } from '../textures';
import { patternMask } from '../patternLink';
import { changed, pt } from './state';

const W = 280, H = 150, RW = 140, RH = 75;

export function WallMap({ L }: { L: TextureLayer }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ kind: 'move' | 'z0' | 'z1'; x: number; y: number; u: number; v: number } | null>(null);
  const Hmm = pt.spec.height;
  const key = JSON.stringify(L) + Hmm;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const img = g.createImageData(RW, RH);
    const mask = L.kind === 'pattern' && L.patternKey ? patternMask(L.patternKey) : undefined;
    const probe = { ...L, z0: 0, z1: 1, fade: L.fade };
    for (let y = 0; y < RH; y++) {
      const z = ((RH - 0.5 - y) / RH) * Hmm;
      const inBand = z >= L.z0 * Hmm && z <= L.z1 * Hmm;
      for (let x = 0; x < RW; x++) {
        // outside the band show the pattern faintly so it can be placed
        const v = inBand ? layerValue(L, (x + 0.5) / RW, z, Hmm, 50, mask) : 0.35 * layerValue(probe, (x + 0.5) / RW, z, Hmm, 50, mask);
        const cut = L.mode === 'cut' && inBand && v > L.cutLevel;
        const i = (y * RW + x) * 4;
        const k = cut ? 25 : 70 + 170 * Math.min(1, v);
        img.data[i] = cut ? 210 : k; img.data[i + 1] = cut ? 60 : k; img.data[i + 2] = cut ? 90 : k; img.data[i + 3] = 255;
      }
    }
    const tmp = document.createElement('canvas');
    tmp.width = RW; tmp.height = RH;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(tmp, 0, 0, W, H);
    g.strokeStyle = '#f0a020'; g.lineWidth = 2;
    for (const z of [L.z0, L.z1]) { const y = H - z * H; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    g.setLineDash([4, 3]); g.lineWidth = 1;
    for (const p of L.planes) { const y = H - (L.z0 + p.z * (L.z1 - L.z0)) * H; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    g.setLineDash([]);
  }, [key]);

  // native listener: scrolling over the map scales the pattern instead of scrolling the panel
  const latest = useRef(L);
  latest.current = L;
  useEffect(() => {
    const c = ref.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const T = latest.current, k = e.deltaY > 0 ? 1 / 1.1 : 1.1;
      if (e.shiftKey) T.rotate = Math.max(-80, Math.min(80, T.rotate + (e.deltaY > 0 ? -2 : 2)));
      else {
        const n = Math.round(T.countU * k);
        T.countU = Math.max(1, n === T.countU ? n + (k > 1 ? 1 : -1) : n);
        T.countV = +Math.max(0.05, T.countV * k).toFixed(3);
      }
      changed();
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, []);

  const local = (e: React.PointerEvent) => {
    const b = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height };
  };

  return (
    <div>
      <canvas ref={ref} width={W} height={H} style={{ width: '100%', borderRadius: 6, border: '1px solid var(--border)', cursor: 'grab', touchAction: 'none' }}
        onPointerDown={(e) => {
          const p = local(e), zf = 1 - p.y, tol = 6 / ref.current!.getBoundingClientRect().height;
          const kind = Math.abs(zf - L.z1) < tol ? 'z1' : Math.abs(zf - L.z0) < tol ? 'z0' : 'move';
          drag.current = { kind, x: p.x, y: p.y, u: L.offsetU, v: L.offsetV };
          (e.target as Element).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const p = local(e);
          if (d.kind === 'move') {
            L.offsetU = +(d.u - (p.x - d.x) * 360).toFixed(2);
            L.offsetV = +(d.v + ((p.y - d.y) / Math.max(0.01, L.z1 - L.z0)) * L.countV).toFixed(3);
          } else {
            const zf = Math.min(1, Math.max(0, 1 - p.y));
            if (d.kind === 'z1') L.z1 = +Math.max(L.z0 + 0.01, zf).toFixed(3); else L.z0 = +Math.min(L.z1 - 0.01, zf).toFixed(3);
          }
          changed();
        }}
        onPointerUp={() => { drag.current = null; }}
/>
      <div className="muted" style={{ fontSize: 11 }}>Unwrapped wall: drag to move · scroll to scale · Shift+scroll to slant · drag the orange lines to set the band{L.mode === 'cut' ? ' · red = opening' : ''}</div>
    </div>
  );
}
