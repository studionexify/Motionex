// #4 Non-planar conformal layering: top skins ride the true surface (projected geodesics) instead of
// stepping, inside their own layer band, checked against the head clearance afterwards.
import { snapToSurface } from '../surface';
import type { TechModule } from '../session';

export const conformalLayers: TechModule = {
  id: 'conformal_layers',
  post(s, layers) {
    const r = s.report('conformal_layers');
    const moved = snapToSurface(layers, s.parts, {
      features: new Set(['top_surface', 'ironing']), maxSlope: Math.max(1, Math.min(89, s.caps.maxSlopeDeg)), minH: 0.04, reach: 0.5, rampDeg: s.caps.maxSlopeDeg,
    });
    if (!moved) { r.status = 'idle'; r.reason = 'No sloped top skins.'; return; }
    s.nonPlanar = true;
    r.stats = { draped_points: moved };
  },
};
