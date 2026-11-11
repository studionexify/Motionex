// Technology modules in pipeline order. Within a stage, earlier modules run first (and win the wall
// and infill hooks for the regions they claim).
import type { TechModule } from '../session';
import { harmonicDome } from './harmonicDome';
import { sgdSlicing } from './sgdSlicing';
import { eikonalOffsets } from './eikonal';
import { conformalLayers } from './conformal';
import { thickVase } from './thickVase';
import { eulerianSpiral } from './eulerianSpiral';
import { tangentEntry, scarfSplice } from './seams';
import { conformalIroning, perimeterFeathering, subvoxelAA } from './surfacePasses';
import { knotBraiding, zWeave } from './weave';
import { feaStress, spinorFields } from './fea';
import { quasicrystal } from './quasicrystal';
import { turingInfill } from './turing';
import { bandGap } from './bandGap';
import { homogenization, metamaterial } from './cells';
import { foamControl } from './foam';
import { inverseWarp } from './inverseWarp';
import { spatialLattice } from './lattice';
import { dovetail } from './dovetail';
import { coMolding } from './coMolding';
import { metricMorph } from './metricMorph';
import { mongeAmpere } from './mongeAmpere';
import { cornerOvershoot, kinematicExtrusion, symplecticShaper } from './motion';
import { glossModulation, hotOnHot, isoGloss } from './rheology';
import { morseRouter } from './morse';

export const MODULES: TechModule[] = [
  // topology first: the Morse–Smale router reads the whole part
  morseRouter,
  // cross-sections and material regions: cast cavities, carved lenses, interface fingers
  coMolding, mongeAmpere, dovetail,
  // layer plan (curved layers): dome field first, SGD refines it
  harmonicDome, sgdSlicing,
  // walls, then wall post-edits
  eikonalOffsets, knotBraiding,
  // fields shared by later stages
  spinorFields,
  // infill: helical bands claim their regions first, then the zone router hands each sub-region to the
  // technology made for it (stress paths where loaded, …)
  thickVase, eulerianSpiral, feaStress, quasicrystal, bandGap, turingInfill, metamaterial, homogenization,
  // toolpath passes, in order: surfaces, helix, interlocking, seams, final burnishing
  conformalLayers, subvoxelAA, perimeterFeathering, zWeave, tangentEntry, scarfSplice, conformalIroning, cornerOvershoot,
  // passes that replace the part (truss, flat morph sheet), then the shrinkage pre-distortion of everything
  spatialLattice, metricMorph, inverseWarp,
  // rheology on the final move list (surface gloss, layer bond, foam), then motion (flow from the
  // planner, acceleration timing against the frame resonance)
  isoGloss, glossModulation, hotOnHot, foamControl, kinematicExtrusion, symplecticShaper,
];
