// #3 Eulerian continuous spiralization: sparse infill as connected concentric spirals.
import { spiralFill } from '../eulerian';
import type { TechModule } from '../session';

export const eulerianSpiral: TechModule = {
  id: 'eulerian_spiral',
  infill(s, _o, region, c) {
    const r = s.report('eulerian_spiral');
    const nz = s.caps.nozzle;
    const paths = spiralFill(region, {
      spacing: c.width / Math.max(0.05, Math.min(1, c.density)), width: c.width,
      minW: Math.max(s.pnum('eulerian_spiral', 'minW'), nz * 0.75), maxW: Math.min(s.pnum('eulerian_spiral', 'maxW'), nz * 2.5),
    });
    if (!paths.length) return undefined;
    if (!r.stats || !('regions' in r.stats)) r.stats = { regions: 0, extrusions: 0, widened: 0 };
    r.stats.regions = (r.stats.regions as number) + 1;
    r.stats.extrusions = (r.stats.extrusions as number) + paths.length;
    r.stats.widened = (r.stats.widened as number) + paths.filter((p) => p.widths).length;
    return paths;
  },
};
