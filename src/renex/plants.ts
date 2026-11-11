// Renex plant library: procedural, botanically shaped plants to stand in Plantex planters. Every plant is
// built from real growth rules — spiral phyllotaxis (137.5°), leaves that droop under their own weight,
// ribbed cacti with areoles and spines, trailing vines that spill over the rim — with leaf materials that
// let light through (backlit leaves glow) and a waxy or velvety skin where the real plant has one.
import * as THREE from 'three';
import { merge, place, range, rng, tint, tube, type Rng } from './geo';

export type PlantCategory = 'Succulents' | 'Cacti' | 'Foliage' | 'Trailing' | 'Ferns' | 'Herbs' | 'Flowering' | 'Grasses' | 'Trees & Bonsai' | 'Air & Moss';

type Archetype = 'rosette' | 'sword' | 'arching' | 'column' | 'barrel' | 'pads' | 'clusterBall' | 'petiole' | 'trunkLeaves' | 'trailing' | 'beads' | 'fern' | 'shrub' | 'spikes' | 'orchid' | 'bulbFlower' | 'bonsai' | 'airplant' | 'moss' | 'grass';

export interface PlantDef {
  id: string;
  name: string;
  latin: string;
  category: PlantCategory;
  arch: Archetype;
  /** Typical potted height (mm) and spread (mm). */
  height: number;
  spread: number;
  leaf: string;
  leaf2?: string;
  flower?: string;
  stem?: string;
  /** Archetype parameters. */
  p?: Record<string, number>;
}

const P = (id: string, name: string, latin: string, category: PlantCategory, arch: Archetype, height: number, spread: number, leaf: string, extra: Partial<PlantDef> = {}): PlantDef =>
  ({ id, name, latin, category, arch, height, spread, leaf, ...extra });

export const PLANTS: PlantDef[] = [
  // Succulents
  P('echeveria-lola', 'Echeveria \'Lola\'', 'Echeveria lola', 'Succulents', 'rosette', 70, 110, '#A9B7A4', { leaf2: '#D9B3B8', p: { count: 34, thick: 3.5, round: 0.7 } }),
  P('echeveria-elegans', 'Mexican snowball', 'Echeveria elegans', 'Succulents', 'rosette', 60, 100, '#A8C3BC', { leaf2: '#E5C9CF', p: { count: 40, thick: 3, round: 0.6 } }),
  P('echeveria-perle', 'Echeveria \'Perle von Nürnberg\'', 'Echeveria × gibbiflora', 'Succulents', 'rosette', 90, 130, '#9C8AA6', { leaf2: '#E0B5C4', p: { count: 28, thick: 3, round: 0.8 } }),
  P('aloe-vera', 'Aloe vera', 'Aloe barbadensis', 'Succulents', 'rosette', 380, 360, '#7C9A5E', { leaf2: '#B5C89A', p: { count: 14, thick: 9, round: 0.05, upright: 0.85, len: 1, teeth: 1 } }),
  P('haworthia', 'Zebra haworthia', 'Haworthiopsis attenuata', 'Succulents', 'rosette', 110, 120, '#2F4F33', { leaf2: '#E6EDE2', p: { count: 30, thick: 3, round: 0.05, upright: 0.7, bands: 1 } }),
  P('agave', 'Agave', 'Agave americana', 'Succulents', 'rosette', 300, 380, '#7F9EA0', { leaf2: '#C9D6C3', p: { count: 18, thick: 7, round: 0.15, upright: 0.6, teeth: 1 } }),
  P('sempervivum', 'Hens and chicks', 'Sempervivum tectorum', 'Succulents', 'rosette', 50, 120, '#6F8C4A', { leaf2: '#9E3B3E', p: { count: 45, thick: 2.2, round: 0.2, chicks: 5 } }),
  P('graptopetalum', 'Ghost plant', 'Graptopetalum paraguayense', 'Succulents', 'rosette', 80, 110, '#B7AFAA', { leaf2: '#D7B7B3', p: { count: 26, thick: 4, round: 0.6 } }),
  P('jade', 'Jade plant', 'Crassula ovata', 'Succulents', 'shrub', 300, 260, '#4E7A3A', { leaf2: '#B5383D', stem: '#7A6A4C', p: { leafLen: 32, leafW: 20, thick: 5, branches: 7, woody: 1 } }),
  P('zebra-cactus', 'Echeveria \'Black Prince\'', 'Echeveria \'Black Prince\'', 'Succulents', 'rosette', 70, 120, '#3B2B2E', { leaf2: '#6B4B42', p: { count: 32, thick: 3, round: 0.3 } }),
  // Cacti
  P('saguaro-young', 'Column cactus', 'Cereus repandus', 'Cacti', 'column', 360, 90, '#4E7746', { flower: '#F2E9D8', p: { ribs: 8, arms: 0, spines: 1 } }),
  P('totem', 'Fairy castle cactus', 'Acanthocereus tetragonus', 'Cacti', 'column', 260, 140, '#5C8A4E', { p: { ribs: 5, arms: 6, spines: 0.6 } }),
  P('golden-barrel', 'Golden barrel', 'Echinocactus grusonii', 'Cacti', 'barrel', 160, 180, '#4D7B3F', { flower: '#F3C53C', p: { ribs: 22, spines: 1, gold: 1 } }),
  P('mammillaria', 'Pincushion cactus', 'Mammillaria elongata', 'Cacti', 'clusterBall', 110, 160, '#6C8C49', { flower: '#E8577C', p: { heads: 9, spines: 1 } }),
  P('bunny-ears', 'Bunny ears cactus', 'Opuntia microdasys', 'Cacti', 'pads', 260, 240, '#7A9D4E', { p: { pads: 7, glochids: 1 } }),
  P('moon-cactus', 'Moon cactus', 'Gymnocalycium mihanovichii', 'Cacti', 'barrel', 150, 70, '#D2443F', { stem: '#3E6B3A', p: { ribs: 8, spines: 0.5, grafted: 1 } }),
  P('star-cactus', 'Star cactus', 'Astrophytum asterias', 'Cacti', 'barrel', 50, 90, '#4D5D3D', { p: { ribs: 8, spines: 0, dots: 1, flat: 1 } }),
  P('christmas-cactus', 'Christmas cactus', 'Schlumbergera', 'Cacti', 'trailing', 250, 360, '#3F6E33', { flower: '#E2306C', p: { vines: 9, segments: 1, droop: 0.5 } }),
  // Foliage
  P('snake-plant', 'Snake plant', 'Dracaena trifasciata', 'Foliage', 'sword', 600, 260, '#2F5233', { leaf2: '#C7C46A', p: { count: 9, width: 55, bands: 1, edge: 1 } }),
  P('snake-hahnii', 'Bird\'s nest snake plant', 'Dracaena trifasciata \'Hahnii\'', 'Foliage', 'rosette', 160, 180, '#2F5233', { leaf2: '#B8C26A', p: { count: 14, thick: 2, round: 0.15, upright: 0.8, bands: 1, len: 1 } }),
  P('zz', 'ZZ plant', 'Zamioculcas zamiifolia', 'Foliage', 'petiole', 550, 420, '#2C5B2A', { stem: '#3D5D2A', p: { stems: 9, leaflets: 12, leafLen: 65, leafW: 30, glossy: 1, upright: 0.9 } }),
  P('monstera', 'Monstera', 'Monstera deliciosa', 'Foliage', 'petiole', 700, 700, '#1F5A2A', { stem: '#4C7A3A', p: { stems: 7, leafLen: 260, leafW: 240, heart: 1, fenestra: 1, glossy: 0.6 } }),
  P('philodendron', 'Heartleaf philodendron', 'Philodendron hederaceum', 'Foliage', 'petiole', 300, 400, '#2E6B2C', { stem: '#5D8A44', p: { stems: 12, leafLen: 90, leafW: 70, heart: 1, glossy: 0.7 } }),
  P('pilea', 'Chinese money plant', 'Pilea peperomioides', 'Foliage', 'petiole', 300, 320, '#3E7A35', { stem: '#7A9A50', p: { stems: 16, leafLen: 60, leafW: 60, round: 1, glossy: 0.5, peltate: 1, trunk: 120 } }),
  P('calathea', 'Calathea orbifolia', 'Goeppertia orbifolia', 'Foliage', 'petiole', 500, 500, '#4F7E4B', { leaf2: '#B8CCA8', stem: '#6E8F55', p: { stems: 10, leafLen: 200, leafW: 170, round: 1, stripes: 1, upright: 0.7 } }),
  P('calathea-rattlesnake', 'Rattlesnake plant', 'Goeppertia lancifolia', 'Foliage', 'petiole', 500, 400, '#7C9A55', { leaf2: '#2F4D2A', stem: '#5B2A3A', p: { stems: 12, leafLen: 260, leafW: 55, spots: 1, wavy: 1, upright: 0.95 } }),
  P('alocasia', 'Alocasia \'Polly\'', 'Alocasia × amazonica', 'Foliage', 'petiole', 450, 400, '#1E3A2A', { leaf2: '#D8E6D0', stem: '#4E6E45', p: { stems: 6, leafLen: 230, leafW: 120, arrow: 1, veins: 1, glossy: 0.9, upright: 0.8 } }),
  P('peace-lily', 'Peace lily', 'Spathiphyllum wallisii', 'Foliage', 'arching', 500, 450, '#24572B', { flower: '#F6F5EE', p: { count: 18, leafLen: 260, leafW: 80, petiole: 180, spathes: 4, glossy: 0.8 } }),
  P('rubber-plant', 'Rubber plant', 'Ficus elastica', 'Trees & Bonsai', 'trunkLeaves', 800, 400, '#1B3A22', { stem: '#5E5444', leaf2: '#7A2A2A', p: { leaves: 16, leafLen: 200, leafW: 95, glossy: 1, trunks: 1 } }),
  P('fiddle-leaf', 'Fiddle-leaf fig', 'Ficus lyrata', 'Trees & Bonsai', 'trunkLeaves', 1000, 450, '#2D5A28', { stem: '#6B5E4A', p: { leaves: 18, leafLen: 260, leafW: 170, fiddle: 1, glossy: 0.6, trunks: 1 } }),
  P('dracaena', 'Dragon tree', 'Dracaena marginata', 'Trees & Bonsai', 'trunkLeaves', 900, 450, '#2F5D2C', { stem: '#7B6F5B', leaf2: '#B8384B', p: { leaves: 60, leafLen: 300, leafW: 10, tufts: 3, edge: 1, trunks: 3 } }),
  P('croton', 'Croton', 'Codiaeum variegatum', 'Foliage', 'trunkLeaves', 450, 380, '#2F5D2C', { stem: '#5E5444', leaf2: '#E4A23A', p: { leaves: 28, leafLen: 160, leafW: 55, veins: 1, glossy: 0.9, trunks: 1 } }),
  P('dieffenbachia', 'Dumb cane', 'Dieffenbachia seguine', 'Foliage', 'trunkLeaves', 600, 450, '#3E7A3A', { stem: '#8DAA6A', leaf2: '#E6EFC8', p: { leaves: 14, leafLen: 250, leafW: 110, splash: 1, trunks: 1 } }),
  P('aspidistra', 'Cast iron plant', 'Aspidistra elatior', 'Foliage', 'arching', 550, 450, '#1F4A26', { p: { count: 14, leafLen: 380, leafW: 85, petiole: 160, glossy: 0.5 } }),
  P('parlour-palm', 'Parlour palm', 'Chamaedorea elegans', 'Trees & Bonsai', 'fern', 600, 500, '#356B2E', { stem: '#4C6B33', p: { fronds: 9, len: 420, pinna: 24, pinnaW: 14, pinnaL: 130, upright: 0.85 } }),
  P('areca', 'Areca palm', 'Dypsis lutescens', 'Trees & Bonsai', 'fern', 900, 650, '#4F8A3C', { stem: '#A8A04A', p: { fronds: 12, len: 650, pinna: 34, pinnaW: 12, pinnaL: 170, upright: 0.9 } }),
  P('bird-nest-fern', 'Bird\'s nest fern', 'Asplenium nidus', 'Ferns', 'arching', 400, 500, '#5E9A3A', { p: { count: 14, leafLen: 380, leafW: 75, petiole: 10, wavy: 1, glossy: 0.7, upright: 0.7 } }),
  // Trailing
  P('pothos', 'Golden pothos', 'Epipremnum aureum', 'Trailing', 'trailing', 180, 500, '#3E7A34', { leaf2: '#E5DB79', stem: '#6C8F48', p: { vines: 8, leaves: 9, leafLen: 70, leafW: 50, heart: 1, splash: 1, droop: 1 } }),
  P('ivy', 'English ivy', 'Hedera helix', 'Trailing', 'trailing', 150, 450, '#2E4F28', { leaf2: '#C9D3B8', stem: '#5F4B3A', p: { vines: 9, leaves: 12, leafLen: 45, leafW: 45, lobed: 1, veins: 1, droop: 1 } }),
  P('string-of-hearts', 'String of hearts', 'Ceropegia woodii', 'Trailing', 'trailing', 60, 500, '#5E6E4C', { leaf2: '#C7CDBA', stem: '#7A4A5A', p: { vines: 10, leaves: 16, leafLen: 16, leafW: 16, heart: 1, thick: 1.5, droop: 1.3 } }),
  P('string-of-pearls', 'String of pearls', 'Curio rowleyanus', 'Trailing', 'beads', 60, 450, '#6C9A4B', { stem: '#6C7A4B', p: { vines: 14, beads: 22, bead: 3.2 } }),
  P('string-of-bananas', 'String of bananas', 'Curio radicans', 'Trailing', 'beads', 60, 450, '#7FA65A', { stem: '#6C7A4B', p: { vines: 12, beads: 16, bead: 3, elong: 3 } }),
  P('tradescantia', 'Wandering dude', 'Tradescantia zebrina', 'Trailing', 'trailing', 150, 450, '#4C5A7A', { leaf2: '#B9C7D4', stem: '#6B3A5A', p: { vines: 10, leaves: 10, leafLen: 55, leafW: 26, stripes: 1, droop: 0.8 } }),
  P('hoya', 'Wax plant', 'Hoya carnosa', 'Trailing', 'trailing', 200, 500, '#2F5A30', { flower: '#F3D6DE', stem: '#6C5A4A', p: { vines: 6, leaves: 10, leafLen: 70, leafW: 32, thick: 2.5, glossy: 1, droop: 0.9, umbels: 2 } }),
  P('peperomia-hope', 'Peperomia \'Hope\'', 'Peperomia tetraphylla', 'Trailing', 'trailing', 120, 300, '#4D7A3A', { stem: '#7A5A4A', p: { vines: 10, leaves: 14, leafLen: 14, leafW: 12, round: 1, thick: 2, droop: 0.6 } }),
  // Ferns
  P('boston-fern', 'Boston fern', 'Nephrolepis exaltata', 'Ferns', 'fern', 400, 650, '#4A8A33', { stem: '#4E6E2E', p: { fronds: 30, len: 500, pinna: 42, pinnaW: 6, pinnaL: 36, upright: 0.45 } }),
  P('maidenhair', 'Maidenhair fern', 'Adiantum raddianum', 'Ferns', 'fern', 300, 400, '#6BA845', { stem: '#2A1F1A', p: { fronds: 22, len: 300, pinna: 18, pinnaW: 9, pinnaL: 9, fan: 1, upright: 0.6 } }),
  P('staghorn', 'Staghorn fern', 'Platycerium bifurcatum', 'Ferns', 'arching', 350, 450, '#6F9A5A', { p: { count: 8, leafLen: 320, leafW: 70, petiole: 20, fork: 1, upright: 0.6 } }),
  // Herbs
  P('basil', 'Sweet basil', 'Ocimum basilicum', 'Herbs', 'shrub', 300, 260, '#3F8A2E', { stem: '#5E8A3A', p: { leafLen: 45, leafW: 26, cupped: 1, branches: 6, glossy: 0.6 } }),
  P('mint', 'Spearmint', 'Mentha spicata', 'Herbs', 'shrub', 280, 300, '#4C8A3A', { stem: '#5A6E3A', p: { leafLen: 38, leafW: 18, serrated: 1, branches: 9 } }),
  P('rosemary', 'Rosemary', 'Salvia rosmarinus', 'Herbs', 'shrub', 380, 300, '#4E6B4A', { stem: '#7A6A52', p: { leafLen: 22, leafW: 2.4, needles: 1, branches: 8, woody: 1 } }),
  P('thyme', 'Thyme', 'Thymus vulgaris', 'Herbs', 'shrub', 150, 260, '#5E7A4E', { stem: '#7A6A52', p: { leafLen: 6, leafW: 3, branches: 24, woody: 1, mound: 1 } }),
  P('lavender', 'English lavender', 'Lavandula angustifolia', 'Herbs', 'spikes', 400, 350, '#8BA38A', { flower: '#7A6BB4', stem: '#8BA38A', p: { spikes: 24 } }),
  P('parsley', 'Curly parsley', 'Petroselinum crispum', 'Herbs', 'shrub', 220, 260, '#3B7A2A', { stem: '#5E9A3A', p: { leafLen: 14, leafW: 12, curly: 1, branches: 14 } }),
  P('chives', 'Chives', 'Allium schoenoprasum', 'Herbs', 'grass', 300, 180, '#3E7A34', { flower: '#B07AC8', p: { blades: 60, width: 3, tube: 1, flowers: 6 } }),
  // Flowering
  P('orchid', 'Moth orchid', 'Phalaenopsis', 'Flowering', 'orchid', 550, 300, '#2F5A2E', { flower: '#F4EEF2', leaf2: '#C6448A', stem: '#4E5A32', p: { flowers: 7 } }),
  P('orchid-pink', 'Moth orchid (pink)', 'Phalaenopsis', 'Flowering', 'orchid', 550, 300, '#2F5A2E', { flower: '#E87DB4', leaf2: '#B02A6E', stem: '#4E5A32', p: { flowers: 8 } }),
  P('african-violet', 'African violet', 'Streptocarpus ionanthus', 'Flowering', 'rosette', 120, 220, '#2E4A2A', { flower: '#7A3FB0', p: { count: 16, thick: 1.6, round: 1, velvet: 1, flowers: 9, upright: 0.25, petiole: 1 } }),
  P('anthurium', 'Flamingo flower', 'Anthurium andraeanum', 'Flowering', 'arching', 450, 380, '#1F4A26', { flower: '#C8102E', p: { count: 10, leafLen: 180, leafW: 110, petiole: 220, heart: 1, spathes: 4, glossy: 1, waxy: 1 } }),
  P('tulip', 'Tulips', 'Tulipa', 'Flowering', 'bulbFlower', 380, 200, '#6E9A6A', { flower: '#D92B3A', p: { stems: 7, cup: 1 } }),
  P('daffodil', 'Daffodils', 'Narcissus', 'Flowering', 'bulbFlower', 350, 200, '#5E8A4E', { flower: '#F6D530', p: { stems: 7, trumpet: 1 } }),
  P('cyclamen', 'Cyclamen', 'Cyclamen persicum', 'Flowering', 'bulbFlower', 250, 260, '#2E4A2A', { flower: '#E04A82', leaf2: '#9AAE98', p: { stems: 9, reflex: 1, basal: 1 } }),
  P('kalanchoe', 'Flaming Katy', 'Kalanchoe blossfeldiana', 'Flowering', 'shrub', 250, 250, '#2F6A2E', { flower: '#F06A2A', stem: '#4E7A3A', p: { leafLen: 50, leafW: 36, thick: 3, branches: 6, glossy: 0.8, clusters: 6 } }),
  P('bromeliad', 'Bromeliad', 'Guzmania lingulata', 'Flowering', 'rosette', 400, 450, '#2F6A30', { flower: '#E2283A', p: { count: 18, thick: 1.4, round: 0.05, upright: 0.55, len: 2.8, bract: 1, glossy: 0.8 } }),
  // Grasses
  P('ornamental-grass', 'Blue fescue', 'Festuca glauca', 'Grasses', 'grass', 250, 260, '#8AA6B0', { p: { blades: 220, width: 1.2 } }),
  P('spider-plant', 'Spider plant', 'Chlorophytum comosum', 'Grasses', 'arching', 300, 500, '#3E8A3A', { leaf2: '#F1F2E2', p: { count: 30, leafLen: 330, leafW: 16, petiole: 0, variegated: 1, droop: 1, upright: 0.6 } }),
  P('carex', 'Sedge', 'Carex oshimensis \'Evergold\'', 'Grasses', 'grass', 280, 380, '#4A7A30', { leaf2: '#E4D86A', p: { blades: 160, width: 4, variegated: 1, droop: 1 } }),
  P('cat-grass', 'Cat grass', 'Dactylis glomerata', 'Grasses', 'grass', 200, 160, '#5DAA3A', { p: { blades: 260, width: 2.4, upright: 1 } }),
  // Trees & bonsai
  P('bonsai-ficus', 'Ficus bonsai', 'Ficus retusa', 'Trees & Bonsai', 'bonsai', 300, 320, '#2E5A26', { stem: '#7A6A58', p: { pads: 7, leaf: 12, aerial: 1 } }),
  P('bonsai-juniper', 'Juniper bonsai', 'Juniperus procumbens', 'Trees & Bonsai', 'bonsai', 260, 360, '#3B5A3A', { stem: '#6E4E3A', p: { pads: 9, leaf: 4, needles: 1, twist: 1 } }),
  P('olive', 'Olive tree', 'Olea europaea', 'Trees & Bonsai', 'trunkLeaves', 900, 500, '#6E7E5A', { stem: '#8A7E6A', leaf2: '#B8C0A8', p: { leaves: 220, leafLen: 50, leafW: 9, crown: 1, trunks: 1 } }),
  P('lemon', 'Dwarf lemon tree', 'Citrus × limon', 'Trees & Bonsai', 'trunkLeaves', 800, 500, '#2E5A26', { stem: '#7A6A58', flower: '#F2DA3A', p: { leaves: 140, leafLen: 80, leafW: 38, glossy: 1, crown: 1, fruit: 6, trunks: 1 } }),
  // Air & moss
  P('air-plant', 'Air plant', 'Tillandsia ionantha', 'Air & Moss', 'airplant', 80, 90, '#9AB09A', { leaf2: '#D2456A', p: { count: 26 } }),
  P('air-xerographica', 'Xerographica', 'Tillandsia xerographica', 'Air & Moss', 'airplant', 160, 260, '#B9C2B2', { p: { count: 30, curl: 1.6 } }),
  P('moss-ball', 'Cushion moss', 'Leucobryum glaucum', 'Air & Moss', 'moss', 50, 140, '#6E9A4A', {}),
  P('moss-sheet', 'Sheet moss', 'Hypnum cupressiforme', 'Air & Moss', 'moss', 18, 200, '#5A7E3A', { p: { flat: 1 } }),
];

export const PLANT_CATEGORIES = [...new Set(PLANTS.map((p) => p.category))];
export const plantById = (id: string) => PLANTS.find((p) => p.id === id);

// ---------------------------------------------------------------------------------------------------
// Leaf builder

interface LeafOpts {
  len: number; width: number;
  /** Width profile along the leaf (0 base … 1 tip) → 0..1. */
  shape?: (t: number) => number;
  /** Initial elevation (rad, 0 = horizontal, π/2 = straight up). */
  pitch: number;
  /** Curvature over the whole length (rad, + droops toward the ground). */
  bend?: number;
  /** V-fold along the midrib (0 flat … 1 strongly folded). */
  fold?: number;
  twist?: number;
  /** Succulent thickness at the midrib (mm); 0 = thin blade (double-sided). */
  thick?: number;
  /** Ripple amplitude at the edge (mm), for wavy leaves. */
  wave?: number;
  segL?: number; segW?: number;
  colour?: (t: number, s: number) => THREE.Color;
}

const SHAPES = {
  lance: (t: number) => Math.sin(Math.PI * Math.pow(t, 0.75)) * (1 - t * 0.15),
  oval: (t: number) => Math.sin(Math.PI * t),
  round: (t: number) => Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)),
  heart: (t: number) => Math.min(1, Math.sin(Math.PI * Math.pow(t, 0.62)) * 1.08) * (t < 0.08 ? 0.75 + t * 3 : 1),
  sword: (t: number) => (t < 0.85 ? 0.75 + 0.25 * Math.sin(Math.PI * t / 0.85) : (1 - t) / 0.15 * 0.8),
  strap: (t: number) => Math.min(1, t * 8) * (t > 0.9 ? (1 - t) / 0.1 : 1),
  spoon: (t: number) => 0.45 + 0.55 * Math.sin(Math.PI * Math.pow(t, 1.6)) * (t > 0.92 ? (1 - t) / 0.08 : 1),
  fiddle: (t: number) => (0.55 + 0.45 * Math.sin(Math.PI * Math.pow(t, 1.5))) * (t > 0.95 ? (1 - t) / 0.05 : 1) * (1 - 0.18 * Math.exp(-((t - 0.45) ** 2) / 0.01)),
  arrow: (t: number) => (t < 0.25 ? 0.6 + t * 1.6 : Math.max(0, 1 - (t - 0.25) / 0.75)),
  needle: () => 1,
};

/** One leaf, base at the origin, growing toward +Y and curving in the Y–Z plane. */
function leaf(o: LeafOpts): THREE.BufferGeometry {
  const nL = o.segL ?? 14, nW = o.segW ?? 4;
  const shape = o.shape ?? SHAPES.lance;
  const thick = o.thick ?? 0;
  const rows: { c: THREE.Vector3; N: THREE.Vector3; S: THREE.Vector3; w: number; t: number }[] = [];
  let y = 0, z = 0;
  const dl = o.len / nL;
  for (let i = 0; i <= nL; i++) {
    const t = i / nL;
    const ang = o.pitch - (o.bend ?? 0) * t;
    const tw = (o.twist ?? 0) * t;
    const T = new THREE.Vector3(0, Math.cos(ang), Math.sin(ang));
    const N0 = new THREE.Vector3(0, -Math.sin(ang), Math.cos(ang));
    const S = new THREE.Vector3(1, 0, 0).applyAxisAngle(T, tw);
    const N = N0.clone().applyAxisAngle(T, tw);
    rows.push({ c: new THREE.Vector3(0, y, z), N, S, w: (o.width / 2) * Math.max(0, shape(t)), t });
    y += Math.cos(ang) * dl; z += Math.sin(ang) * dl;
  }
  const pos: number[] = [], col: number[] = [], uv: number[] = [];
  const vert = (r: (typeof rows)[number], s: number, side: number) => {
    const x = s * r.w;
    const foldZ = Math.abs(s) * r.w * (o.fold ?? 0) * 0.6;
    const wave = (o.wave ?? 0) * Math.abs(s) ** 2 * Math.sin(r.t * 22);
    const bulge = thick ? side * thick * 0.5 * (1 - s * s) * Math.sin(Math.PI * Math.min(1, r.t * 1.1 + 0.05)) : 0;
    const p = r.c.clone().addScaledVector(r.S, x).addScaledVector(r.N, foldZ + wave + bulge);
    pos.push(p.x, p.y, p.z);
    const c = o.colour ? o.colour(r.t, s) : new THREE.Color(1, 1, 1);
    col.push(c.r, c.g, c.b);
    uv.push(s * 0.5 + 0.5, r.t);
  };
  const sheet = (side: number) => {
    for (let i = 0; i < nL; i++) for (let j = 0; j < nW * 2; j++) {
      const s0 = j / nW - 1, s1 = (j + 1) / nW - 1;
      const A = rows[i], B = rows[i + 1];
      if (side > 0) { vert(A, s0, side); vert(B, s0, side); vert(A, s1, side); vert(B, s0, side); vert(B, s1, side); vert(A, s1, side); }
      else { vert(A, s0, side); vert(A, s1, side); vert(B, s0, side); vert(B, s0, side); vert(A, s1, side); vert(B, s1, side); }
    }
  };
  sheet(1);
  if (thick) sheet(-1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Put a +Y leaf at `at`, facing compass angle `yaw` (rad, around Z). */
function setLeaf(g: THREE.BufferGeometry, at: THREE.Vector3, yaw: number) {
  g.rotateZ(yaw - Math.PI / 2);
  g.translate(at.x, at.y, at.z);
  return g;
}

function flower(r: Rng, colour: string, petals: number, len: number, width: number, cup: number, dir: THREE.Vector3, at: THREE.Vector3): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const c = new THREE.Color(colour);
  for (let k = 0; k < petals; k++) {
    const g = leaf({ len, width, shape: SHAPES.oval, pitch: Math.PI / 2 - cup, bend: -cup * 0.6, segL: 6, segW: 2, colour: (t) => c.clone().offsetHSL(0, 0, (t - 0.5) * 0.08 + range(r, -0.03, 0.03)) });
    g.rotateZ((k / petals) * Math.PI * 2 + range(r, -0.1, 0.1));
    out.push(place(g, at, dir));
  }
  const centre = new THREE.SphereGeometry(Math.max(1, width * 0.18), 8, 6);
  out.push(tint(place(centre, at, dir), c.clone().lerp(new THREE.Color('#E8C33A'), 0.7)));
  return out;
}

function spineCluster(at: THREE.Vector3, n: THREE.Vector3, len: number, count: number, r: Rng): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let k = 0; k < count; k++) {
    const g = new THREE.ConeGeometry(0.25, len * range(r, 0.6, 1.1), 3, 1);
    g.translate(0, len / 2, 0); g.rotateX(Math.PI / 2);
    const d = n.clone().add(new THREE.Vector3(range(r, -0.7, 0.7), range(r, -0.7, 0.7), range(r, -0.7, 0.7))).normalize();
    out.push(place(g, at, d));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Materials

export type PlantMat = 'leaf' | 'leafGlossy' | 'succulent' | 'cactus' | 'stem' | 'bark' | 'flower' | 'spine' | 'moss' | 'fruit';

export function plantMaterial(kind: PlantMat): THREE.MeshPhysicalMaterial {
  const base = { vertexColors: true, side: THREE.DoubleSide } as const;
  switch (kind) {
    // leaves: thin translucent tissue (sun through a leaf goes yellow-green), waxy cuticle sheen
    case 'leaf': return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.55, transmission: 0.18, thickness: 0.25, ior: 1.42, sheen: 0.3, sheenRoughness: 0.5, sheenColor: new THREE.Color('#d8f0c0') });
    case 'leafGlossy': return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.32, transmission: 0.12, thickness: 0.3, ior: 1.45, clearcoat: 0.6, clearcoatRoughness: 0.18 });
    case 'succulent': return new THREE.MeshPhysicalMaterial({ ...base, side: THREE.FrontSide, roughness: 0.6, transmission: 0.08, thickness: 3, ior: 1.38, sheen: 0.6, sheenColor: new THREE.Color('#e9eef0'), sheenRoughness: 0.35 });
    case 'cactus': return new THREE.MeshPhysicalMaterial({ ...base, side: THREE.FrontSide, roughness: 0.5, clearcoat: 0.25, clearcoatRoughness: 0.4 });
    case 'stem': return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.6, transmission: 0.05, thickness: 1 });
    case 'bark': return new THREE.MeshPhysicalMaterial({ ...base, side: THREE.FrontSide, roughness: 0.92 });
    case 'flower': return new THREE.MeshPhysicalMaterial({ ...base, roughness: 0.5, transmission: 0.3, thickness: 0.2, sheen: 0.7, sheenRoughness: 0.3, sheenColor: new THREE.Color('#ffffff') });
    case 'spine': return new THREE.MeshPhysicalMaterial({ ...base, color: '#efe6c8', roughness: 0.45, transmission: 0.3, thickness: 0.3, vertexColors: false });
    case 'moss': return new THREE.MeshPhysicalMaterial({ ...base, side: THREE.FrontSide, roughness: 1, sheen: 1, sheenRoughness: 0.8, sheenColor: new THREE.Color('#b8d890') });
    case 'fruit': return new THREE.MeshPhysicalMaterial({ ...base, side: THREE.FrontSide, roughness: 0.35, clearcoat: 0.5 });
  }
}

// ---------------------------------------------------------------------------------------------------
// Builders

type Parts = Partial<Record<PlantMat, THREE.BufferGeometry[]>>;
const push = (parts: Parts, k: PlantMat, ...g: THREE.BufferGeometry[]) => { (parts[k] ??= []).push(...g); };
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function shadeFn(r: Rng, a: string, b: string | undefined, mode: 'tip' | 'bands' | 'stripes' | 'edge' | 'splash' | 'variegated' | 'spots' | 'veins' | 'plain') {
  const A = new THREE.Color(a), B = new THREE.Color(b ?? a);
  const jitter = range(r, -0.04, 0.04);
  return (t: number, s: number) => {
    let k = 0;
    if (mode === 'tip') k = Math.pow(t, 3);
    if (mode === 'bands') k = Math.sin(t * 60 + Math.sin(s * 9) * 1.5) > 0.55 ? 0.8 : 0;
    if (mode === 'stripes') k = Math.abs(s) > 0.15 && Math.sin(t * 30) > 0.3 ? 0.7 : 0;
    if (mode === 'edge') k = Math.abs(s) > 0.85 ? 1 : 0;
    if (mode === 'splash') k = Math.sin(t * 13.1 + s * 7.7) * Math.sin(t * 5.3 - s * 11) > 0.35 ? 0.8 : 0;
    if (mode === 'variegated') k = Math.abs(s) > 0.55 || Math.abs(s) < 0.12 ? 0.9 : 0;
    if (mode === 'spots') k = Math.abs(s) > 0.2 && Math.abs(s) < 0.7 && Math.sin(t * 26) > 0.2 ? 1 : 0;
    if (mode === 'veins') k = Math.abs(s) < 0.06 || Math.abs(Math.sin((t * 6 + Math.abs(s) * 4) * Math.PI)) < 0.08 ? 0.85 : 0;
    return A.clone().lerp(B, k).offsetHSL(0, 0, jitter + (t - 0.5) * 0.04);
  };
}

function buildRosette(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  const count = p.count ?? 24, R = d.spread / 2;
  const mode = p.bands ? 'bands' : d.leaf2 ? 'tip' : 'plain';
  const mat: PlantMat = (p.thick ?? 0) > 2.5 ? 'succulent' : p.glossy ? 'leafGlossy' : 'leaf';
  const len = p.len ?? 1;
  for (let i = 0; i < count; i++) {
    const f = i / count; // 0 inner → 1 outer
    const ll = R * (0.35 + 0.65 * Math.sqrt(f)) * (len > 1 ? 1 : 1) * range(r, 0.92, 1.05) * (len > 1.5 ? len * 0.5 : 1);
    const lw = (p.round ?? 0.4) > 0.5 ? ll * 0.75 : ll * (0.2 + (p.round ?? 0.4) * 0.6);
    const up = p.upright ?? 0.35;
    const g = leaf({
      len: d.arch === 'rosette' && up > 0.6 ? Math.max(ll, d.height * (0.5 + 0.5 * (1 - f))) : ll, width: lw,
      shape: (p.round ?? 0) > 0.5 ? SHAPES.spoon : SHAPES.lance,
      pitch: (Math.PI / 2) * (up + (1 - up) * (1 - f) * 0.9), bend: (p.thick ?? 0) > 2 ? 0.25 : 0.6 * f,
      fold: (p.round ?? 0) > 0.5 ? 0.25 : 0.55, thick: p.thick ?? 0, segL: 10, segW: 3,
      colour: shadeFn(r, d.leaf, d.leaf2, mode as 'tip'),
    });
    setLeaf(g, new THREE.Vector3(0, 0, i * 0.02 * d.height / count), i * GOLDEN);
    push(parts, mat, g);
  }
  if (p.chicks) for (let k = 0; k < p.chicks; k++) {
    const sub: Parts = {};
    buildRosette({ ...d, spread: d.spread * 0.35, p: { ...p, count: 18, chicks: 0 } }, r, sub);
    const a = range(r, 0, Math.PI * 2), dist = d.spread * range(r, 0.42, 0.55);
    for (const [k2, gs] of Object.entries(sub)) for (const g of gs!) { g.translate(Math.cos(a) * dist, Math.sin(a) * dist, 0); push(parts, k2 as PlantMat, g); }
  }
  if (p.flowers && d.flower) for (let k = 0; k < p.flowers; k++) {
    const a = range(r, 0, Math.PI * 2), dist = range(r, 0, R * 0.35);
    push(parts, 'flower', ...flower(r, d.flower, 5, 11, 9, 0.5, new THREE.Vector3(Math.cos(a) * 0.3, Math.sin(a) * 0.3, 1), new THREE.Vector3(Math.cos(a) * dist, Math.sin(a) * dist, d.height * range(r, 0.8, 1))));
  }
  if (p.bract && d.flower) {
    for (let k = 0; k < 14; k++) {
      const g = leaf({ len: d.height * 0.35, width: 26, shape: SHAPES.lance, pitch: 1.35 - k * 0.04, bend: 0.3, fold: 0.6, segL: 6, segW: 2, colour: () => new THREE.Color(d.flower!) });
      setLeaf(g, new THREE.Vector3(0, 0, d.height * 0.5 + k * 6), k * GOLDEN);
      push(parts, 'flower', g);
    }
  }
}

function buildSword(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  for (let i = 0; i < (p.count ?? 7); i++) {
    const h = d.height * range(r, 0.6, 1);
    const g = leaf({ len: h, width: (p.width ?? 40) * range(r, 0.8, 1.1), shape: SHAPES.sword, pitch: Math.PI / 2 - range(r, 0.02, 0.16), bend: range(r, -0.05, 0.12), fold: 0.35, twist: range(r, -0.5, 0.5), thick: 2, segL: 12, segW: 3, colour: shadeFn(r, d.leaf, d.leaf2, p.edge ? 'edge' : 'bands') });
    // banded snake-plant leaves have edge colour plus bands: blend both
    if (p.bands && p.edge) { const c2 = shadeFn(r, d.leaf, '#7FA060', 'bands'); const C = g.getAttribute('color') as THREE.BufferAttribute; const U = g.getAttribute('uv') as THREE.BufferAttribute; for (let k = 0; k < C.count; k++) { const s = U.getX(k) * 2 - 1; if (Math.abs(s) < 0.85) { const c = c2(U.getY(k), s); C.setXYZ(k, c.r, c.g, c.b); } } }
    const a = range(r, 0, Math.PI * 2), dd = range(r, 0, d.spread * 0.25);
    setLeaf(g, new THREE.Vector3(Math.cos(a) * dd, Math.sin(a) * dd, 0), i * GOLDEN);
    push(parts, 'succulent', g);
  }
}

function buildArching(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  const mat: PlantMat = p.glossy ? 'leafGlossy' : 'leaf';
  const stem = new THREE.Color(d.stem ?? d.leaf).offsetHSL(0, -0.05, 0.08);
  for (let i = 0; i < (p.count ?? 12); i++) {
    const yaw = i * GOLDEN + range(r, -0.2, 0.2);
    const pitch = (Math.PI / 2) * (p.upright ?? 0.75) * range(r, 0.8, 1.1);
    const pet = (p.petiole ?? 0) * range(r, 0.7, 1.1);
    let base = new THREE.Vector3(0, 0, 0);
    if (pet > 0) {
      const lean = Math.cos(pitch) * 0.6;
      const tip = new THREE.Vector3(Math.cos(yaw) * pet * lean, Math.sin(yaw) * pet * lean, pet * Math.sin(pitch) * 0.95);
      push(parts, 'stem', tint(tube([base, base.clone().lerp(tip, 0.5).add(new THREE.Vector3(0, 0, pet * 0.05)), tip], 2.2, 6, 10), stem));
      base = tip;
    }
    const mode = p.variegated ? 'variegated' : 'plain';
    const g = leaf({ len: (p.leafLen ?? 200) * range(r, 0.75, 1.05), width: (p.leafW ?? 60) * range(r, 0.85, 1.1), shape: p.heart ? SHAPES.heart : p.leafW && p.leafW < 25 ? SHAPES.strap : SHAPES.lance, pitch: pet ? pitch * 0.55 : pitch, bend: (p.droop ?? 0.6) * range(r, 1.2, 2.2), fold: p.fork ? 0.1 : 0.3, wave: p.wavy ? 3 : 0, segL: 14, segW: 3, colour: shadeFn(r, d.leaf, d.leaf2, mode) });
    setLeaf(g, base, yaw);
    push(parts, mat, g);
  }
  if (p.spathes && d.flower) for (let k = 0; k < p.spathes; k++) {
    const yaw = range(r, 0, Math.PI * 2), h = d.height * range(r, 0.85, 1.05), lean = range(r, 0.05, 0.2);
    const top = new THREE.Vector3(Math.cos(yaw) * h * lean, Math.sin(yaw) * h * lean, h);
    push(parts, 'stem', tint(tube([new THREE.Vector3(), top.clone().multiplyScalar(0.5), top], 2, 6, 10), stem));
    const sp = leaf({ len: p.heart ? 90 : 110, width: p.heart ? 80 : 55, shape: p.heart ? SHAPES.heart : SHAPES.oval, pitch: p.heart ? 0.3 : 1.25, bend: p.heart ? 0.2 : 0.5, fold: p.heart ? 0.05 : 0.5, segL: 10, segW: 3, colour: () => new THREE.Color(d.flower!) });
    setLeaf(sp, top, yaw + Math.PI);
    push(parts, p.waxy ? 'leafGlossy' : 'flower', sp);
    const spadix = new THREE.CylinderGeometry(3, 4, p.heart ? 50 : 40, 10); spadix.rotateX(Math.PI / 2); spadix.translate(0, 0, 22);
    push(parts, 'fruit', tint(place(spadix, top, new THREE.Vector3(Math.cos(yaw) * 0.3, Math.sin(yaw) * 0.3, 1)), p.heart ? '#F2D25A' : '#EDE6C8'));
  }
}

function buildColumn(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  const ribs = p.ribs ?? 8;
  const col = (h: number, rad: number, at: THREE.Vector3, dir: THREE.Vector3) => {
    const seg = ribs * 6, rows = Math.max(8, Math.round(h / 6));
    const pos: number[] = [], idx: number[] = [];
    for (let i = 0; i <= rows; i++) {
      const t = i / rows, z = h * t;
      const taper = t > 0.88 ? Math.sqrt(Math.max(0, 1 - ((t - 0.88) / 0.12) ** 2)) : 1;
      for (let j = 0; j < seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const rib = 1 - 0.13 * (1 - Math.abs(Math.cos(a * ribs / 2)));
        const rr = rad * rib * taper * (0.92 + 0.08 * Math.min(1, t * 6));
        pos.push(Math.cos(a) * rr, Math.sin(a) * rr, z);
      }
    }
    for (let i = 0; i < rows; i++) for (let j = 0; j < seg; j++) { const a = i * seg + j, b = i * seg + (j + 1) % seg, c = a + seg, e = b + seg; idx.push(a, b, c, b, e, c); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    push(parts, 'cactus', tint(place(g, at, dir), new THREE.Color(d.leaf).offsetHSL(0, 0, range(r, -0.03, 0.03))));
    if ((p.spines ?? 1) > 0) for (let i = 1; i < rows; i += 2) for (let k = 0; k < ribs; k++) {
      const a = (k / ribs) * Math.PI * 2, z = (i / rows) * h;
      const local = new THREE.Vector3(Math.cos(a) * rad, Math.sin(a) * rad, z);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
      const wp = local.clone().applyQuaternion(q).add(at), wn = new THREE.Vector3(Math.cos(a), Math.sin(a), 0).applyQuaternion(q);
      push(parts, 'spine', ...spineCluster(wp, wn, 8 * (p.spines ?? 1), 4, r));
    }
  };
  const rad = d.spread / 2 * (p.arms ? 0.35 : 0.9);
  col(d.height, rad, new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
  for (let k = 0; k < (p.arms ?? 0); k++) {
    const a = range(r, 0, Math.PI * 2), h0 = d.height * range(r, 0.15, 0.5);
    const dir = new THREE.Vector3(Math.cos(a) * 0.35, Math.sin(a) * 0.35, 1);
    col(d.height * range(r, 0.3, 0.6), rad * 0.75, new THREE.Vector3(Math.cos(a) * rad * 0.6, Math.sin(a) * rad * 0.6, h0), dir);
  }
}

function buildBarrel(d: PlantDef, r: Rng, parts: Parts, at = new THREE.Vector3(), scale = 1) {
  const p = d.p ?? {};
  const ribs = p.ribs ?? 16, R = (d.spread / 2) * scale, H = (p.grafted ? d.height * 0.35 : d.height) * scale;
  const seg = ribs * 4, rows = 24;
  const pos: number[] = [], idx: number[] = [];
  const z0 = p.grafted ? d.height * 0.65 * scale : 0;
  for (let i = 0; i <= rows; i++) {
    const t = i / rows, ang = (t * Math.PI) / 2 + (p.flat ? 0 : 0);
    const prof = Math.sin(0.15 + t * (Math.PI - 0.3) * 0.62) / Math.sin(0.15 + (Math.PI - 0.3) * 0.31);
    void ang;
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const rib = 1 - 0.12 * (1 - Math.abs(Math.cos(a * ribs / 2)));
      const rr = R * Math.min(1, prof) * rib * (t > 0.97 ? 0.2 : 1);
      pos.push(at.x + Math.cos(a) * rr, at.y + Math.sin(a) * rr, at.z + z0 + H * (p.flat ? 0.5 * Math.sin(t * Math.PI / 2) : Math.sin(t * Math.PI / 2)));
    }
  }
  for (let i = 0; i < rows; i++) for (let j = 0; j < seg; j++) { const a = i * seg + j, b = i * seg + (j + 1) % seg, c = a + seg, e = b + seg; idx.push(a, b, c, b, e, c); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  push(parts, 'cactus', tint(g, d.leaf));
  if (p.grafted) { const s = new THREE.CylinderGeometry(R * 0.35, R * 0.4, z0, 12); s.rotateX(Math.PI / 2); s.translate(at.x, at.y, at.z + z0 / 2); push(parts, 'cactus', tint(s, d.stem ?? '#3E6B3A')); }
  if (p.dots) { for (let k = 0; k < 160; k++) { const a = range(r, 0, Math.PI * 2), t = range(r, 0.05, 0.9); const s = new THREE.SphereGeometry(0.8, 4, 3); s.translate(at.x + Math.cos(a) * R * Math.cos(t * 1.2), at.y + Math.sin(a) * R * Math.cos(t * 1.2), at.z + H * 0.5 * Math.sin(t * 1.4)); push(parts, 'flower', tint(s, '#E8E6DA')); } }
  if ((p.spines ?? 1) > 0) for (let i = 2; i < rows - 1; i += 2) for (let k = 0; k < ribs; k++) {
    const a = (k / ribs) * Math.PI * 2 + (i % 4 ? Math.PI / ribs : 0);
    const vi = i * seg + k * 4;
    const wp = new THREE.Vector3(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
    const wn = new THREE.Vector3(Math.cos(a), Math.sin(a), (i / rows) * 1.2).normalize();
    for (const s of spineCluster(wp, wn, (p.gold ? 14 : 6) * (p.spines ?? 1) * scale, p.gold ? 6 : 4, r)) push(parts, 'spine', s);
  }
  if (d.flower) push(parts, 'flower', ...flower(r, d.flower, 12, 14 * scale, 5 * scale, 0.7, new THREE.Vector3(0, 0, 1), new THREE.Vector3(at.x, at.y, at.z + z0 + H)));
}

function buildClusterBall(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  for (let k = 0; k < (p.heads ?? 7); k++) {
    const a = k * GOLDEN * 2, dist = k === 0 ? 0 : d.spread * 0.18 * Math.sqrt(k);
    const s = range(r, 0.3, 0.45);
    buildBarrel({ ...d, height: d.height * range(r, 0.7, 1.1), p: { ribs: 13, spines: 1 }, flower: k % 3 === 0 ? d.flower : undefined }, r, parts, new THREE.Vector3(Math.cos(a) * dist, Math.sin(a) * dist, 0), s);
  }
}

function buildPads(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  const pad = (at: THREE.Vector3, dir: THREE.Vector3, size: number, spin: number) => {
    const g = new THREE.SphereGeometry(1, 20, 12);
    g.scale(size * 0.65, size * 0.12, size); g.translate(0, 0, size * 0.9);
    place(g, at, dir, spin);
    push(parts, 'cactus', tint(g, new THREE.Color(d.leaf).offsetHSL(0, 0, range(r, -0.04, 0.04))));
    // glochid tufts (tiny fuzzy dots)
    if (p.glochids) for (let k = 0; k < 26; k++) {
      const u = range(r, -0.8, 0.8), v = range(r, 0.15, 1.75), side = r() > 0.5 ? 1 : -1;
      const local = new THREE.Vector3(u * size * 0.55 * Math.sqrt(Math.max(0, 1 - ((v - 0.9) / 0.9) ** 2)), side * size * 0.11, v * size);
      const s = new THREE.SphereGeometry(1.4, 4, 3);
      s.translate(local.x, local.y, local.z);
      push(parts, 'spine', place(s, at, dir, spin));
    }
    return new THREE.Vector3(0, 0, size * 1.75).applyAxisAngle(new THREE.Vector3(0, 0, 1), spin).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize())).add(at);
  };
  const size0 = d.height * 0.32;
  const top = pad(new THREE.Vector3(), new THREE.Vector3(0, 0, 1), size0, 0);
  for (let k = 1; k < (p.pads ?? 5); k++) {
    const a = range(r, -1, 1), b = range(r, 0, Math.PI * 2);
    const from = k < 3 ? top.clone().multiplyScalar(range(r, 0.6, 0.95)) : top;
    pad(from, new THREE.Vector3(Math.sin(a), Math.cos(a) * 0.3, 1), size0 * range(r, 0.55, 0.8), b);
  }
}

function petioleLeaf(d: PlantDef, r: Rng, parts: Parts, base: THREE.Vector3, yaw: number, pitch: number, len: number, w: number) {
  const p = d.p ?? {};
  const mode = p.stripes ? 'stripes' : p.spots ? 'spots' : p.veins ? 'veins' : p.splash ? 'splash' : d.leaf2 ? 'tip' : 'plain';
  const shape = p.round ? SHAPES.round : p.heart ? SHAPES.heart : p.arrow ? SHAPES.arrow : p.fiddle ? SHAPES.fiddle : SHAPES.lance;
  const g = leaf({ len, width: w, shape, pitch, bend: range(r, 0.3, 0.8), fold: p.round ? 0.08 : 0.25, wave: p.wavy ? 4 : 0, segL: 16, segW: 5, colour: shadeFn(r, d.leaf, d.leaf2, mode as 'plain') });
  if (p.fenestra) {
    // monstera: split the outer blade into fingers by pushing alternate edge strips down (reads as slits)
    const P = g.getAttribute('position') as THREE.BufferAttribute, U = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let k = 0; k < P.count; k++) { const s = Math.abs(U.getX(k) * 2 - 1), t = U.getY(k); if (s > 0.55 && Math.sin(t * 40) > 0.5) P.setZ(k, P.getZ(k) - 8 * (s - 0.55)); }
    g.computeVertexNormals();
  }
  setLeaf(g, base, yaw);
  push(parts, p.glossy ? 'leafGlossy' : 'leaf', g);
}

function buildPetiole(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  const stemC = new THREE.Color(d.stem ?? d.leaf);
  const trunkH = p.trunk ?? 0;
  if (trunkH) push(parts, 'stem', tint(tube([new THREE.Vector3(), new THREE.Vector3(2, 0, trunkH * 0.5), new THREE.Vector3(0, 2, trunkH)], 5, 8, 12), stemC));
  for (let i = 0; i < (p.stems ?? 8); i++) {
    const yaw = i * GOLDEN + range(r, -0.15, 0.15);
    const up = (p.upright ?? 0.65) * range(r, 0.85, 1.1);
    const L = (d.height - (p.leafLen ?? 100) * 0.6) * range(r, 0.55, 1);
    const from = trunkH ? new THREE.Vector3(0, 0, trunkH * range(r, 0.3, 1)) : new THREE.Vector3(range(r, -5, 5), range(r, -5, 5), 0);
    const lean = Math.cos((up * Math.PI) / 2);
    const tip = from.clone().add(new THREE.Vector3(Math.cos(yaw) * L * (lean + 0.15), Math.sin(yaw) * L * (lean + 0.15), L * Math.sin((up * Math.PI) / 2) * (trunkH ? 0.3 : 1)));
    const mid = from.clone().lerp(tip, 0.5).add(new THREE.Vector3(0, 0, L * 0.08));
    if (p.leaflets) {
      // ZZ: thick rachis with paired glossy leaflets
      push(parts, 'stem', tint(tube([from, mid, tip], (t) => 5 * (1 - t * 0.6) * (t < 0.1 ? 1.6 : 1), 8, 18), stemC));
      const curve = new THREE.CatmullRomCurve3([from, mid, tip]);
      for (let k = 0; k < p.leaflets; k++) {
        const t = 0.3 + (k / p.leaflets) * 0.7, at = curve.getPointAt(t);
        const side = k % 2 ? 1 : -1;
        petioleLeaf({ ...d, p: { ...p, leaflets: 0 } }, r, parts, at, yaw + side * 1.1, 0.5, (p.leafLen ?? 60) * range(r, 0.85, 1.05), p.leafW ?? 28);
      }
      continue;
    }
    push(parts, 'stem', tint(tube([from, mid, tip], 2.5, 6, 12), stemC));
    const leafPitch = p.peltate ? 0.1 : (up > 0.8 ? 1.0 : 0.35);
    petioleLeaf(d, r, parts, tip, yaw, leafPitch, (p.leafLen ?? 100) * range(r, 0.75, 1.05), (p.leafW ?? 70) * range(r, 0.8, 1.05));
  }
}

function buildTrunkLeaves(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  const stemC = new THREE.Color(d.stem ?? '#6B5E4A');
  const trunks = p.trunks ?? 1;
  for (let k = 0; k < trunks; k++) {
    const a = range(r, 0, Math.PI * 2), off = trunks > 1 ? 12 : 0;
    const h = d.height * (p.crown ? 0.55 : 0.85) * range(r, 0.8, 1);
    const pts = [new THREE.Vector3(Math.cos(a) * off, Math.sin(a) * off, 0), new THREE.Vector3(Math.cos(a) * off * 2 + range(r, -10, 10), Math.sin(a) * off * 2 + range(r, -10, 10), h * 0.5), new THREE.Vector3(Math.cos(a) * off * 3 + range(r, -15, 15), Math.sin(a) * off * 3, h)];
    push(parts, 'bark', tint(tube(pts, (t) => (p.crown ? 9 : 6) * (1 - t * 0.5), 10, 16), stemC));
    const curve = new THREE.CatmullRomCurve3(pts);
    const n = Math.round((p.leaves ?? 20) / trunks);
    if (p.tufts) {
      // dracaena: leaf tufts at the trunk tips
      const top = pts[2];
      for (let i = 0; i < n; i++) {
        const g = leaf({ len: (p.leafLen ?? 300) * range(r, 0.6, 1), width: p.leafW ?? 10, shape: SHAPES.strap, pitch: range(r, 0.2, 1.4), bend: range(r, 0.6, 1.4), fold: 0.3, segL: 12, segW: 2, colour: shadeFn(r, d.leaf, d.leaf2, 'edge') });
        setLeaf(g, top, i * GOLDEN);
        push(parts, 'leaf', g);
      }
      continue;
    }
    for (let i = 0; i < n; i++) {
      const crown = p.crown ? 1 : 0;
      const t = crown ? range(r, 0.85, 1) : 0.25 + (i / n) * 0.75;
      const at = curve.getPointAt(Math.min(1, t));
      if (crown) at.add(new THREE.Vector3(range(r, -1, 1), range(r, -1, 1), range(r, -0.2, 1)).normalize().multiplyScalar(range(r, 10, d.spread * 0.42)));
      const yaw = i * GOLDEN * (crown ? 3 : 1);
      petioleLeaf({ ...d, p: { ...p } }, r, parts, at, yaw, range(r, 0.2, 0.8), (p.leafLen ?? 150) * range(r, 0.75, 1.05), (p.leafW ?? 60) * range(r, 0.8, 1.05));
    }
    if (p.fruit && d.flower) for (let i = 0; i < p.fruit; i++) {
      const at = curve.getPointAt(1).clone().add(new THREE.Vector3(range(r, -1, 1), range(r, -1, 1), range(r, -0.6, 0.3)).normalize().multiplyScalar(range(r, 30, d.spread * 0.4)));
      const s = new THREE.SphereGeometry(18, 16, 12); s.scale(1, 1, 1.25); s.translate(at.x, at.y, at.z);
      push(parts, 'fruit', tint(s, d.flower));
    }
  }
}

/** Vines that climb out of the pot, arch over the rim and hang. `rimR` / `rimZ` locate the pot lip relative to the soil. */
function buildTrailing(d: PlantDef, r: Rng, parts: Parts, rimR: number, rimZ: number, beads = false) {
  const p = d.p ?? {};
  const stemC = new THREE.Color(d.stem ?? d.leaf);
  for (let v = 0; v < (p.vines ?? 8); v++) {
    const yaw = v * GOLDEN * 1.3 + range(r, -0.2, 0.2);
    const dir = new THREE.Vector3(Math.cos(yaw), Math.sin(yaw), 0);
    const hang = d.spread * range(r, 0.3, 0.75) * (p.droop ?? 1);
    const out = rimR + range(r, 4, 14);
    const pts = [
      new THREE.Vector3(dir.x * 8, dir.y * 8, 0),
      dir.clone().multiplyScalar(rimR * 0.6).add(new THREE.Vector3(0, 0, Math.max(rimZ, 0) + d.height * 0.35)),
      dir.clone().multiplyScalar(out).add(new THREE.Vector3(0, 0, Math.max(rimZ, 0) + 10)),
      dir.clone().multiplyScalar(out + 10).add(new THREE.Vector3(range(r, -8, 8), range(r, -8, 8), rimZ - hang * 0.45)),
      dir.clone().multiplyScalar(out + 18).add(new THREE.Vector3(range(r, -15, 15), range(r, -15, 15), rimZ - hang)),
    ];
    push(parts, 'stem', tint(tube(pts, beads ? 0.8 : 1.6, 5, 40), stemC));
    const curve = new THREE.CatmullRomCurve3(pts);
    const n = beads ? p.beads ?? 20 : p.leaves ?? 10;
    for (let i = 0; i < n; i++) {
      const t = 0.12 + (i / n) * 0.88, at = curve.getPointAt(t), tan = curve.getTangentAt(t);
      if (beads) {
        const s = new THREE.SphereGeometry(p.bead ?? 3, 10, 8);
        if (p.elong) s.scale(1, 1, p.elong);
        const side = new THREE.Vector3(-tan.y, tan.x, 0).normalize().multiplyScalar((i % 2 ? 1 : -1) * (p.bead ?? 3) * 1.4);
        push(parts, 'succulent', tint(place(s, at.clone().add(side), p.elong ? side.clone().normalize().add(new THREE.Vector3(0, 0, 0.6)) : undefined), new THREE.Color(d.leaf).offsetHSL(0, 0, range(r, -0.04, 0.04))));
        continue;
      }
      const side = i % 2 ? 1 : -1;
      const yawL = Math.atan2(tan.y, tan.x) + side * (Math.PI / 2) * range(r, 0.6, 1);
      const L = (p.leafLen ?? 50) * range(r, 0.7, 1.05) * (0.7 + 0.3 * (1 - t));
      const mode = p.splash ? 'splash' : p.stripes ? 'stripes' : p.veins ? 'veins' : 'plain';
      const g = leaf({ len: L, width: (p.leafW ?? 40) * (L / (p.leafLen ?? 50)), shape: p.heart ? SHAPES.heart : p.round ? SHAPES.round : p.lobed ? SHAPES.heart : SHAPES.lance, pitch: range(r, -0.3, 0.4), bend: 0.4, fold: 0.15, thick: p.thick ?? 0, segL: 8, segW: 3, colour: shadeFn(r, d.leaf, d.leaf2, mode as 'plain') });
      setLeaf(g, at, yawL);
      push(parts, p.thick ? 'succulent' : p.glossy ? 'leafGlossy' : 'leaf', g);
      if (p.segments && d.flower && i === n - 1) push(parts, 'flower', ...flower(r, d.flower, 8, 28, 7, 1.1, tan, at));
    }
    if (p.umbels && d.flower && v < p.umbels) {
      const at = curve.getPointAt(0.35);
      for (let k = 0; k < 14; k++) push(parts, 'flower', ...flower(r, d.flower, 5, 5, 4, 0.2, new THREE.Vector3(range(r, -1, 1), range(r, -1, 1), range(r, -0.3, 1)).normalize(), at.clone().add(new THREE.Vector3(range(r, -12, 12), range(r, -12, 12), range(r, -6, 8)))));
    }
  }
}

function buildFern(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  const stemC = new THREE.Color(d.stem ?? d.leaf);
  for (let f = 0; f < (p.fronds ?? 20); f++) {
    const yaw = f * GOLDEN + range(r, -0.2, 0.2);
    const up = (p.upright ?? 0.5) * range(r, 0.75, 1.15);
    const L = (p.len ?? 400) * range(r, 0.6, 1);
    const pitch = (up * Math.PI) / 2, bend = range(r, 0.9, 1.6) * (1.1 - up);
    const pts: THREE.Vector3[] = [];
    let y = 0, z = 0;
    for (let i = 0; i <= 8; i++) { const ang = pitch - bend * (i / 8); pts.push(new THREE.Vector3(Math.cos(yaw) * y, Math.sin(yaw) * y, z)); y += Math.cos(ang) * L / 8; z += Math.sin(ang) * L / 8; }
    push(parts, 'stem', tint(tube(pts, (t) => 2.2 * (1 - t * 0.8), 5, 24), stemC));
    const curve = new THREE.CatmullRomCurve3(pts);
    const n = p.pinna ?? 30;
    for (let i = 0; i < n; i++) {
      const t = 0.12 + (i / n) * 0.88, at = curve.getPointAt(t), tan = curve.getTangentAt(t);
      const yawT = Math.atan2(tan.y, tan.x);
      const size = Math.sin(Math.PI * Math.min(1, t * 1.05)) * (p.pinnaL ?? 40);
      for (const side of [-1, 1]) {
        const g = leaf({ len: size, width: p.pinnaW ?? 6, shape: p.fan ? SHAPES.round : SHAPES.lance, pitch: Math.asin(Math.max(-1, Math.min(1, tan.z))) * 0.6, bend: 0.3, fold: 0.2, segL: p.fan ? 4 : 6, segW: 2, colour: shadeFn(r, d.leaf, d.leaf2, 'plain') });
        setLeaf(g, at, yawT + side * (Math.PI / 2) * 0.85);
        push(parts, 'leaf', g);
      }
    }
  }
}

function buildShrub(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  const stemC = new THREE.Color(d.stem ?? d.leaf);
  const branches = p.branches ?? 6;
  const mat: PlantMat = (p.thick ?? 0) > 2 ? 'succulent' : p.glossy ? 'leafGlossy' : 'leaf';
  for (let b = 0; b < branches; b++) {
    const yaw = b * GOLDEN * 2 + range(r, -0.3, 0.3);
    const lean = p.mound ? range(r, 0.5, 0.9) : range(r, 0.1, 0.45);
    const h = d.height * range(r, 0.65, 1) * (p.mound ? 0.8 : 1);
    const pts = [new THREE.Vector3(range(r, -6, 6), range(r, -6, 6), 0)];
    for (let i = 1; i <= 4; i++) { const t = i / 4; pts.push(new THREE.Vector3(Math.cos(yaw) * d.spread * 0.45 * lean * t + range(r, -6, 6), Math.sin(yaw) * d.spread * 0.45 * lean * t + range(r, -6, 6), h * t * (1 - (p.mound ? 0.35 * t * t : 0)))); }
    push(parts, p.woody ? 'bark' : 'stem', tint(tube(pts, (t) => (p.woody ? 4.5 : 2) * (1 - t * 0.6), 6, 18), stemC));
    const curve = new THREE.CatmullRomCurve3(pts);
    const nodes = p.needles ? 46 : Math.max(4, Math.round(h / ((p.leafLen ?? 30) * 0.55)));
    for (let i = 0; i < nodes; i++) {
      const t = 0.15 + (i / nodes) * 0.85, at = curve.getPointAt(t);
      const pair = p.needles ? 1 : 2;
      for (let k = 0; k < pair; k++) {
        const yawL = i * (p.needles ? GOLDEN : Math.PI / 2) + k * Math.PI + range(r, -0.2, 0.2);
        const L = (p.leafLen ?? 30) * range(r, 0.75, 1.1) * (p.needles ? 1 : 0.6 + 0.4 * (1 - t));
        const g = leaf({ len: L, width: p.leafW ?? 15, shape: p.needles ? SHAPES.needle : p.curly ? SHAPES.round : SHAPES.oval, pitch: p.needles ? range(r, 0.6, 1.2) : range(r, 0.1, 0.6), bend: p.cupped ? -0.4 : 0.3, fold: p.cupped ? 0.6 : 0.25, wave: p.serrated ? 0.8 : p.curly ? 2 : 0, thick: p.thick ?? (p.needles ? 0.6 : 0), segL: p.needles ? 3 : 7, segW: p.needles ? 1 : 3, colour: shadeFn(r, d.leaf, d.leaf2, d.leaf2 ? 'edge' : 'plain') });
        setLeaf(g, at, yawL);
        push(parts, mat, g);
      }
    }
    if (p.clusters && d.flower && b < p.clusters) {
      const top = curve.getPointAt(1);
      for (let k = 0; k < 10; k++) push(parts, 'flower', ...flower(r, d.flower, 4, 6, 5, 0.3, new THREE.Vector3(range(r, -0.5, 0.5), range(r, -0.5, 0.5), 1).normalize(), top.clone().add(new THREE.Vector3(range(r, -12, 12), range(r, -12, 12), range(r, 0, 10)))));
    }
  }
}

function buildSpikes(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  // lavender: grey-green needle foliage mound + flower spikes on long stems
  buildShrub({ ...d, height: d.height * 0.45, p: { leafLen: 30, leafW: 3, needles: 1, branches: 10, woody: 1, mound: 1 } }, r, parts);
  for (let k = 0; k < (p.spikes ?? 20); k++) {
    const yaw = k * GOLDEN, lean = range(r, 0.05, 0.35);
    const top = new THREE.Vector3(Math.cos(yaw) * d.spread * 0.5 * lean, Math.sin(yaw) * d.spread * 0.5 * lean, d.height * range(r, 0.8, 1));
    push(parts, 'stem', tint(tube([new THREE.Vector3(0, 0, d.height * 0.3), top.clone().multiplyScalar(0.6).setZ(top.z * 0.65), top], 1.1, 4, 10), d.stem ?? d.leaf));
    const dir = top.clone().normalize();
    for (let i = 0; i < 9; i++) {
      const s = new THREE.SphereGeometry(3.2 - i * 0.2, 6, 5); s.scale(1, 1, 1.3);
      push(parts, 'flower', tint(place(s, top.clone().addScaledVector(dir, -i * 6)), new THREE.Color(d.flower ?? '#7A6BB4').offsetHSL(0, 0, range(r, -0.05, 0.05))));
    }
  }
}

function buildOrchid(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  for (let k = 0; k < 4; k++) {
    const g = leaf({ len: range(r, 150, 220), width: range(r, 60, 80), shape: SHAPES.oval, pitch: range(r, 0.15, 0.45), bend: 0.5, fold: 0.35, thick: 2.5, segL: 12, segW: 3, colour: shadeFn(r, d.leaf, undefined, 'plain') });
    setLeaf(g, new THREE.Vector3(0, 0, k * 6), k * Math.PI + range(r, -0.2, 0.2));
    push(parts, 'leafGlossy', g);
  }
  // aerial roots
  for (let k = 0; k < 4; k++) { const a = range(r, 0, Math.PI * 2); push(parts, 'stem', tint(tube([new THREE.Vector3(0, 0, 5), new THREE.Vector3(Math.cos(a) * 40, Math.sin(a) * 40, 20), new THREE.Vector3(Math.cos(a) * 70, Math.sin(a) * 70, 0)], 3, 6, 12), '#B8C2A8')); }
  // flower spike staked upright, arching at the top
  const pts = [new THREE.Vector3(0, 0, 10), new THREE.Vector3(5, 0, d.height * 0.5), new THREE.Vector3(15, 0, d.height * 0.85), new THREE.Vector3(70, 0, d.height * 0.92), new THREE.Vector3(130, 0, d.height * 0.8)];
  push(parts, 'stem', tint(tube(pts, 2.2, 6, 30), d.stem ?? '#4E5A32'));
  push(parts, 'bark', tint(tube([new THREE.Vector3(-4, 0, -40), new THREE.Vector3(-4, 0, d.height * 0.8)], 2, 6, 4), '#9A7A52'));
  const curve = new THREE.CatmullRomCurve3(pts);
  for (let i = 0; i < (p.flowers ?? 6); i++) {
    const t = 0.55 + (i / (p.flowers ?? 6)) * 0.45, at = curve.getPointAt(t);
    const dir = new THREE.Vector3(0.2, -1, 0.15).normalize();
    // 3 sepals + 2 broad petals + lip
    const c = new THREE.Color(d.flower ?? '#ffffff');
    for (let k = 0; k < 5; k++) {
      const broad = k === 1 || k === 3;
      const g = leaf({ len: broad ? 38 : 34, width: broad ? 40 : 18, shape: broad ? SHAPES.round : SHAPES.oval, pitch: Math.PI / 2 - 0.15, bend: -0.2, segL: 6, segW: 3, colour: () => c });
      g.rotateZ((k / 5) * Math.PI * 2);
      push(parts, 'flower', place(g, at, dir));
    }
    const lip = leaf({ len: 22, width: 16, shape: SHAPES.spoon, pitch: 1.2, bend: -0.6, fold: 0.7, segL: 5, segW: 2, colour: () => new THREE.Color(d.leaf2 ?? '#C6448A') });
    lip.rotateZ(Math.PI);
    push(parts, 'flower', place(lip, at, dir));
  }
}

function buildBulbFlower(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  const stems = p.stems ?? 5;
  for (let k = 0; k < stems; k++) {
    const yaw = k * GOLDEN * 2, off = range(r, 5, d.spread * 0.25);
    const base = new THREE.Vector3(Math.cos(yaw) * off, Math.sin(yaw) * off, 0);
    const h = d.height * range(r, 0.75, 1);
    const top = base.clone().add(new THREE.Vector3(Math.cos(yaw) * range(r, 5, 30), Math.sin(yaw) * range(r, 5, 30), h));
    if (p.basal) {
      const g = leaf({ len: 70, width: 70, shape: SHAPES.heart, pitch: 0.2, bend: 0.2, segL: 8, segW: 3, colour: shadeFn(r, d.leaf, d.leaf2, 'veins') });
      setLeaf(g, new THREE.Vector3(0, 0, 10), yaw);
      push(parts, 'leaf', g);
    } else {
      for (let j = 0; j < 2; j++) {
        const g = leaf({ len: h * 0.6, width: 30, shape: SHAPES.lance, pitch: 1.2, bend: 0.7, fold: 0.6, segL: 10, segW: 2, colour: shadeFn(r, d.leaf, undefined, 'plain') });
        setLeaf(g, base, yaw + j * Math.PI + range(r, -0.3, 0.3));
        push(parts, 'leaf', g);
      }
    }
    push(parts, 'stem', tint(tube([base, base.clone().lerp(top, 0.5), top], 2.4, 6, 12), new THREE.Color(d.leaf).offsetHSL(0, 0, 0.06)));
    const dir = p.reflex ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 0, 1);
    if (p.cup) push(parts, 'flower', ...flower(r, d.flower!, 6, 45, 32, 0.15, dir, top));
    else if (p.trumpet) { push(parts, 'flower', ...flower(r, d.flower!, 6, 34, 20, 1.3, new THREE.Vector3(Math.cos(yaw), Math.sin(yaw), 0.2), top)); const t = new THREE.CylinderGeometry(9, 6, 22, 14, 1, true); t.rotateX(Math.PI / 2); t.translate(0, 0, 11); push(parts, 'flower', tint(place(t, top, new THREE.Vector3(Math.cos(yaw), Math.sin(yaw), 0.2)), '#F2A630')); }
    else push(parts, 'flower', ...flower(r, d.flower!, 5, 30, 14, -0.9, dir, top));
  }
}

function buildBonsai(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  const stemC = new THREE.Color(d.stem ?? '#7A6A58');
  const trunk = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(18, 0, d.height * 0.25), new THREE.Vector3(-10, 6, d.height * 0.5), new THREE.Vector3(8, -4, d.height * 0.7)];
  push(parts, 'bark', tint(tube(trunk, (t) => 18 * (1 - t * 0.7) * (t < 0.08 ? 1.5 : 1), 12, 24), stemC));
  const curve = new THREE.CatmullRomCurve3(trunk);
  if (p.aerial) for (let k = 0; k < 4; k++) { const a = range(r, 0, Math.PI * 2); push(parts, 'bark', tint(tube([new THREE.Vector3(Math.cos(a) * 10, Math.sin(a) * 10, d.height * 0.2), new THREE.Vector3(Math.cos(a) * 25, Math.sin(a) * 25, 0)], 3, 6, 6), stemC)); }
  for (let k = 0; k < (p.pads ?? 6); k++) {
    const t = 0.4 + (k / (p.pads ?? 6)) * 0.6, at = curve.getPointAt(t);
    const yaw = k * GOLDEN * 2, reach = range(r, 40, d.spread * 0.45);
    const end = at.clone().add(new THREE.Vector3(Math.cos(yaw) * reach, Math.sin(yaw) * reach, range(r, 5, 25)));
    push(parts, 'bark', tint(tube([at, at.clone().lerp(end, 0.5).add(new THREE.Vector3(0, 0, -5)), end], (s) => 5 * (1 - s * 0.6), 6, 10), stemC));
    // foliage pad: a flattened cloud of small leaves
    const n = p.needles ? 260 : 140;
    for (let i = 0; i < n; i++) {
      const q = new THREE.Vector3(range(r, -1, 1), range(r, -1, 1), range(r, -0.25, 0.4));
      if (q.length() > 1) continue;
      const at2 = end.clone().add(q.multiplyScalar(reach * 0.5));
      const g = leaf({ len: (p.leaf ?? 10) * range(r, 0.8, 1.2), width: p.needles ? 1.5 : (p.leaf ?? 10) * 0.55, shape: p.needles ? SHAPES.needle : SHAPES.oval, pitch: range(r, -0.2, 0.8), bend: 0.2, segL: 3, segW: 1, colour: shadeFn(r, d.leaf, undefined, 'plain') });
      setLeaf(g, at2, range(r, 0, Math.PI * 2));
      push(parts, 'leafGlossy', g);
    }
  }
}

function buildAirplant(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  for (let i = 0; i < (p.count ?? 24); i++) {
    const f = i / (p.count ?? 24);
    const g = leaf({ len: d.spread * 0.55 * (0.5 + 0.5 * f), width: d.spread * 0.08, shape: SHAPES.lance, pitch: (Math.PI / 2) * (1 - f * 0.8), bend: (p.curl ?? 0.8) * (0.5 + f), fold: 0.7, twist: range(r, -0.5, 0.5), thick: 1.2, segL: 12, segW: 2, colour: shadeFn(r, d.leaf, d.leaf2, d.leaf2 ? 'tip' : 'plain') });
    setLeaf(g, new THREE.Vector3(0, 0, 4), i * GOLDEN);
    push(parts, 'succulent', g);
  }
}

function buildMoss(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  const R = d.spread / 2;
  const g = new THREE.SphereGeometry(1, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2);
  g.rotateX(Math.PI / 2);
  const P = g.getAttribute('position') as THREE.BufferAttribute;
  for (let k = 0; k < P.count; k++) {
    const x = P.getX(k), y = P.getY(k), z = P.getZ(k);
    const bump = 1 + 0.05 * Math.sin(x * 37 + y * 11) * Math.sin(y * 29 - x * 7) + 0.03 * Math.sin(x * 91 + y * 83);
    P.setXYZ(k, x * R * bump, y * R * bump, z * d.height * (p.flat ? 0.4 : 1) * bump);
  }
  g.computeVertexNormals();
  push(parts, 'moss', tint(g, new THREE.Color(d.leaf).offsetHSL(0, 0, range(r, -0.03, 0.03))));
}

function buildGrass(d: PlantDef, r: Rng, parts: Parts) {
  const p = d.p ?? {};
  for (let i = 0; i < (p.blades ?? 100); i++) {
    const a = range(r, 0, Math.PI * 2), dist = Math.sqrt(r()) * d.spread * 0.15;
    const up = p.upright ? range(r, 1.25, 1.5) : range(r, 0.7, 1.5);
    const g = leaf({ len: d.height * range(r, 0.6, 1.15), width: p.width ?? 2, shape: SHAPES.strap, pitch: up, bend: (p.droop ?? 0.6) * range(r, 0.5, 1.4) * (1.6 - up * 0.8), fold: p.tube ? 0.9 : 0.4, twist: range(r, -0.6, 0.6), thick: p.tube ? 1 : 0, segL: 10, segW: 1, colour: shadeFn(r, d.leaf, d.leaf2, p.variegated ? 'variegated' : 'plain') });
    setLeaf(g, new THREE.Vector3(Math.cos(a) * dist, Math.sin(a) * dist, 0), a + range(r, -0.6, 0.6));
    push(parts, 'leaf', g);
  }
  if (p.flowers && d.flower) for (let k = 0; k < p.flowers; k++) {
    const a = range(r, 0, Math.PI * 2), top = new THREE.Vector3(Math.cos(a) * 25, Math.sin(a) * 25, d.height * range(r, 0.9, 1.1));
    push(parts, 'stem', tint(tube([new THREE.Vector3(), top], 1.2, 4, 4), d.leaf));
    const s = new THREE.SphereGeometry(11, 10, 8); s.translate(top.x, top.y, top.z);
    push(parts, 'flower', tint(s, d.flower));
  }
}

export interface PlantBuildOptions { seed?: number; scale?: number; rimRadius?: number; rimAboveSoil?: number }

/** Build a plant (Z up, mm), its base at the origin on the soil surface. */
export function buildPlant(def: PlantDef, o: PlantBuildOptions = {}): THREE.Group {
  const r = rng((o.seed ?? 1) * 9973 + def.id.length * 131);
  const parts: Parts = {};
  switch (def.arch) {
    case 'rosette': buildRosette(def, r, parts); break;
    case 'sword': buildSword(def, r, parts); break;
    case 'arching': buildArching(def, r, parts); break;
    case 'column': buildColumn(def, r, parts); break;
    case 'barrel': buildBarrel(def, r, parts); break;
    case 'clusterBall': buildClusterBall(def, r, parts); break;
    case 'pads': buildPads(def, r, parts); break;
    case 'petiole': buildPetiole(def, r, parts); break;
    case 'trunkLeaves': buildTrunkLeaves(def, r, parts); break;
    case 'trailing': buildTrailing(def, r, parts, o.rimRadius ?? def.spread * 0.3, o.rimAboveSoil ?? 15); break;
    case 'beads': buildTrailing(def, r, parts, o.rimRadius ?? def.spread * 0.3, o.rimAboveSoil ?? 15, true); break;
    case 'fern': buildFern(def, r, parts); break;
    case 'shrub': buildShrub(def, r, parts); break;
    case 'spikes': buildSpikes(def, r, parts); break;
    case 'orchid': buildOrchid(def, r, parts); break;
    case 'bulbFlower': buildBulbFlower(def, r, parts); break;
    case 'bonsai': buildBonsai(def, r, parts); break;
    case 'airplant': buildAirplant(def, r, parts); break;
    case 'moss': buildMoss(def, r, parts); break;
    case 'grass': buildGrass(def, r, parts); break;
  }
  const group = new THREE.Group();
  group.name = def.name;
  for (const [k, list] of Object.entries(parts)) {
    if (!list?.length) continue;
    const g = merge(list, true);
    const m = new THREE.Mesh(g, plantMaterial(k as PlantMat));
    m.name = `${def.name} ${k}`;
    group.add(m);
  }
  if (o.scale && o.scale !== 1) group.scale.setScalar(o.scale);
  return group;
}
