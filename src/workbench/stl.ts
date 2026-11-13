// STL export: the CAD-quality export mesh (see meshbuild.ts).
import type { Design } from './design';
import { buildMesh, meshToStl } from './meshbuild';
export const stlFromDesign = (d: Design): ArrayBuffer => meshToStl(buildMesh(d, 'export'));
