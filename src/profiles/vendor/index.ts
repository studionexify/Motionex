// Generated from the OrcaSlicer / Bambu Studio machine profiles (inherits and include resolved).
// Each file: the maker's G-code templates verbatim, the machine values, bed and excluded areas, with its source.
import v_bbl_a1mini from './bbl-a1mini.json';
import v_bbl_p1p from './bbl-p1p.json';
import v_bbl_x1c from './bbl-x1c.json';
import v_bbl_x1e from './bbl-x1e.json';
import v_bbl_h2d from './bbl-h2d.json';
import v_creality_ender3v3ke from './creality-ender3v3ke.json';
import v_creality_k1 from './creality-k1.json';
import v_creality_k1c from './creality-k1c.json';
import v_creality_k1max from './creality-k1max.json';
import v_creality_k2plus from './creality-k2plus.json';
import v_creality_ender3v3 from './creality-ender3v3.json';
import v_creality_ender3v3se from './creality-ender3v3se.json';
import v_creality_ender3s1 from './creality-ender3s1.json';
import v_creality_ender3v2 from './creality-ender3v2.json';
import v_creality_cr10se from './creality-cr10se.json';
import v_creality_k2plus_cfs from './creality-k2plus-cfs.json';
import v_creality_k1c_cfs from './creality-k1c-cfs.json';
import v_creality_k1max_cfs from './creality-k1max-cfs.json';
import v_creality_hi_cfs from './creality-hi-cfs.json';
import v_elegoo_neptune4 from './elegoo-neptune4.json';
import v_elegoo_neptune4pro from './elegoo-neptune4pro.json';
import v_elegoo_neptune4plus from './elegoo-neptune4plus.json';
import v_elegoo_neptune3pro from './elegoo-neptune3pro.json';
import v_elegoo_centauri from './elegoo-centauri.json';
import v_prusa_mk4s from './prusa-mk4s.json';
import v_prusa_mk3s from './prusa-mk3s.json';
import v_prusa_mini from './prusa-mini.json';
import v_prusa_coreone from './prusa-coreone.json';
import v_prusa_xl from './prusa-xl.json';
import v_prusa_xl_5t from './prusa-xl-5t.json';
import v_prusa_mk4s_mmu3 from './prusa-mk4s-mmu3.json';
import v_prusa_coreone_mmu3 from './prusa-coreone-mmu3.json';
import v_anycubic_kobra2neo from './anycubic-kobra2neo.json';
import v_anycubic_kobra2max from './anycubic-kobra2max.json';
import v_anycubic_kobra3 from './anycubic-kobra3.json';
import v_anycubic_kobra3_ace from './anycubic-kobra3-ace.json';
import v_anycubic_kobras1_ace from './anycubic-kobras1-ace.json';
import v_voron_24_350 from './voron-24-350.json';
import v_voron_trident_300 from './voron-trident-300.json';
import v_voron_02 from './voron-02.json';
import v_qidi_q1pro from './qidi-q1pro.json';
import v_qidi_xplus3 from './qidi-xplus3.json';
import v_qidi_xmax3 from './qidi-xmax3.json';
import v_sovol_sv08 from './sovol-sv08.json';
import v_sovol_sv07 from './sovol-sv07.json';
import v_sovol_sv06 from './sovol-sv06.json';
import v_artillery_x4plus from './artillery-x4plus.json';

export const GENERATED_VENDOR: Record<string, unknown> = {
  'bbl-a1mini': v_bbl_a1mini,
  'bbl-p1p': v_bbl_p1p,
  'bbl-x1c': v_bbl_x1c,
  'bbl-x1e': v_bbl_x1e,
  'bbl-h2d': v_bbl_h2d,
  'creality-ender3v3ke': v_creality_ender3v3ke,
  'creality-k1': v_creality_k1,
  'creality-k1c': v_creality_k1c,
  'creality-k1max': v_creality_k1max,
  'creality-k2plus': v_creality_k2plus,
  'creality-ender3v3': v_creality_ender3v3,
  'creality-ender3v3se': v_creality_ender3v3se,
  'creality-ender3s1': v_creality_ender3s1,
  'creality-ender3v2': v_creality_ender3v2,
  'creality-cr10se': v_creality_cr10se,
  'creality-k2plus-cfs': v_creality_k2plus_cfs,
  'creality-k1c-cfs': v_creality_k1c_cfs,
  'creality-k1max-cfs': v_creality_k1max_cfs,
  'creality-hi-cfs': v_creality_hi_cfs,
  'elegoo-neptune4': v_elegoo_neptune4,
  'elegoo-neptune4pro': v_elegoo_neptune4pro,
  'elegoo-neptune4plus': v_elegoo_neptune4plus,
  'elegoo-neptune3pro': v_elegoo_neptune3pro,
  'elegoo-centauri': v_elegoo_centauri,
  'prusa-mk4s': v_prusa_mk4s,
  'prusa-mk3s': v_prusa_mk3s,
  'prusa-mini': v_prusa_mini,
  'prusa-coreone': v_prusa_coreone,
  'prusa-xl': v_prusa_xl,
  'prusa-xl-5t': v_prusa_xl_5t,
  'prusa-mk4s-mmu3': v_prusa_mk4s_mmu3,
  'prusa-coreone-mmu3': v_prusa_coreone_mmu3,
  'anycubic-kobra2neo': v_anycubic_kobra2neo,
  'anycubic-kobra2max': v_anycubic_kobra2max,
  'anycubic-kobra3': v_anycubic_kobra3,
  'anycubic-kobra3-ace': v_anycubic_kobra3_ace,
  'anycubic-kobras1-ace': v_anycubic_kobras1_ace,
  'voron-24-350': v_voron_24_350,
  'voron-trident-300': v_voron_trident_300,
  'voron-02': v_voron_02,
  'qidi-q1pro': v_qidi_q1pro,
  'qidi-xplus3': v_qidi_xplus3,
  'qidi-xmax3': v_qidi_xmax3,
  'sovol-sv08': v_sovol_sv08,
  'sovol-sv07': v_sovol_sv07,
  'sovol-sv06': v_sovol_sv06,
  'artillery-x4plus': v_artillery_x4plus,
};
