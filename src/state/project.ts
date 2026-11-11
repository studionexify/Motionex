// NexSpiro project files: a standard 3MF (meshes + build transforms, so any slicer can open it)
// plus Metadata/nexspiro_project.json with the full scene state, settings and project notes.
import JSZip from 'jszip';
import { saveFile } from '../platform';
import { emptyProject, newId, objectMatrix, objectPlate, useStore, type FilamentSlotState, type Plate, type ProjectInfo, type SceneObject } from './store';
import { migrateConfig, type Config } from '../profiles/settings';
import { sanitizeUserPresets, type UserPreset } from '../profiles/userPresets';
import { mergeUserPresets } from './userPresets';
import type { PatternexProjectData } from '../plugins/patternex/ui/state';
import type { PrimSpec } from './ops';
import { sequenceToBambu } from '../engine/toolmap';

const VERSION = 2; // 2: current setting keys (see migrateConfig)

const b64 = (a: Uint8Array) => { let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const f32 = (a: Float32Array) => b64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
const u32 = (a: Uint32Array) => b64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
const toF32 = (s: string) => { const b = unb64(s); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const toU32 = (s: string) => { const b = unb64(s); return new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4); };

interface ProjectJson {
  version: number;
  app: 'NexSpiro';
  printerId: string; plate: string; presetId: string;
  overrides: Config; machineOverrides: Config;
  filaments: FilamentSlotState[];
  mixes?: import('../profiles/mixing').MixedFilament[];
  /** User process presets saved in this project (optional; older projects have none). */
  userPresets?: UserPreset[];
  userPresetId?: string | null;
  plates: Plate[];
  project: ProjectInfo;
  /** Older projects stored Patternex placements here; they now live on each object. */
  patternex?: PatternexProjectData;
  /** Data of installed plugins, by plugin id. */
  plugins?: Record<string, unknown>;
  objects: (Omit<SceneObject, 'mesh' | 'parts' | 'paint'> & {
    meshIndex: number;
    /** Source face id per triangle (quad / polygon groups from OBJ import), kept so subdivision still sees quads. */
    faceGroups?: string;
    groupKind?: 'cad';
    parts?: { id: string; name: string; type: string; position: number[]; rotation: number[]; scale: number[]; overrides: Config; prim?: PrimSpec; v: string; i: string }[];
    paint?: Record<string, string>;
  })[];
}

const meshXml = (o: SceneObject, id: number) => {
  const v = o.mesh.vertices, ix = o.mesh.indices;
  const parts: string[] = [`  <object id="${id}" name="${o.name.replace(/[<>&"]/g, '_')}" type="model"><mesh><vertices>`];
  for (let k = 0; k < v.length; k += 3) parts.push(`<vertex x="${+v[k].toFixed(5)}" y="${+v[k + 1].toFixed(5)}" z="${+v[k + 2].toFixed(5)}"/>`);
  parts.push('</vertices><triangles>');
  for (let k = 0; k < ix.length; k += 3) parts.push(`<triangle v1="${ix[k]}" v2="${ix[k + 1]}" v3="${ix[k + 2]}"/>`);
  parts.push('</triangles></mesh></object>');
  return parts.join('');
};
/** 3MF build transform (row-vector 3x4) from a THREE column-major matrix. */
const xform = (o: SceneObject) => {
  const e = objectMatrix(o).elements;
  return [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10], e[12], e[13], e[14]].map((x) => +x.toFixed(6)).join(' ');
};

const xmlAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
/** Bambu / Orca plate settings (Metadata/model_settings.config): plate names, locks, the objects on each plate and the
 *  filament printing sequence, under Bambu's keys so the plates carry over to Bambu Studio. */
export function plateSettingsXml(plates: Plate[], objPlates: number[]): string {
  const md = (k: string, v: string) => `    <metadata key="${k}" value="${xmlAttr(v)}"/>\n`;
  const body = plates.map((p, i) => {
    let x = `  <plate>\n${md('plater_id', String(i + 1))}${md('plater_name', p.name)}${md('locked', p.locked ? 'true' : 'false')}`;
    if (p.printSequence) x += md('print_sequence', p.printSequence);
    if (p.filamentSequence) for (const [k, v] of Object.entries(sequenceToBambu(p.filamentSequence))) x += md(k, v);
    objPlates.forEach((pl, k) => { if (pl === i) x += `    <model_instance>\n  ${md('object_id', String(k + 1))}  ${md('instance_id', '0')}    </model_instance>\n`; });
    return x + '  </plate>\n';
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${body}</config>\n`;
}

export async function buildProject(): Promise<Uint8Array> {
  const s = useStore.getState();
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="json" ContentType="application/json"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="jpg" ContentType="image/jpeg"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`);
  const objs = s.objects;
  const meta = (k: string, v: string) => (v ? ` <metadata name="${k}">${v.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</metadata>\n` : '');
  zip.file('3D/3dmodel.model', `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Application">NexSpiro-0.1.0</metadata>
${meta('Title', s.project.title)}${meta('Designer', s.project.author)}${meta('Description', s.project.description)}${meta('License', s.project.license)} <resources>
${objs.map((o, i) => meshXml(o, i + 1)).join('\n')}
 </resources>
 <build>
${objs.map((o, i) => `  <item objectid="${i + 1}" transform="${xform(o)}"/>`).join('\n')}
 </build>
</model>`);
  const project: ProjectInfo = { ...s.project, photos: [] };
  s.project.photos.forEach((p, i) => {
    const m = /^data:image\/(png|jpe?g);base64,(.*)$/.exec(p.dataUrl);
    if (!m) return;
    const path = `Metadata/photos/${i + 1}.${m[1] === 'png' ? 'png' : 'jpg'}`;
    zip.file(path, unb64(m[2]));
    project.photos.push({ name: p.name, dataUrl: path });
  });
  const json: ProjectJson = {
    version: VERSION, app: 'NexSpiro',
    printerId: s.printerId, plate: s.plate, presetId: s.presetId, overrides: s.overrides, machineOverrides: s.machineOverrides,
    filaments: s.filaments, mixes: s.mixes, plates: s.plates, project,
    userPresets: s.userPresets, userPresetId: s.userPresetId,
    plugins: (await import('../plugins/registry')).pluginProjectData(),
    objects: objs.map((o, i) => ({
      id: o.id, name: o.name, position: o.position, rotation: o.rotation, scale: o.scale, openEdges: o.openEdges,
      filament: o.filament, overrides: o.overrides, layerHeights: o.layerHeights, printable: o.printable, patternex: o.patternex, meshIndex: i, faceGroups: objs[i].mesh.faceGroups ? u32(objs[i].mesh.faceGroups!) : undefined, groupKind: objs[i].mesh.groupKind,
      heightRanges: o.heightRanges, brimEars: o.brimEars, hidden: o.hidden, prim: o.prim, steps: o.steps,
      parts: o.parts?.map((p) => ({ id: p.id, name: p.name, type: p.type, position: p.position, rotation: p.rotation, scale: p.scale, overrides: p.overrides, prim: p.prim, v: f32(p.mesh.vertices), i: u32(p.mesh.indices) })),
      paint: o.paint ? Object.fromEntries(Object.entries(o.paint).filter(([, a]) => a).map(([k, a]) => [k, b64(a as Uint8Array)])) : undefined,
    })),
  };
  zip.file('Metadata/nexspiro_project.json', JSON.stringify(json));
  zip.file('Metadata/model_settings.config', plateSettingsXml(s.plates, objs.map((o) => objectPlate(o, s.printerId, s.plates.length))));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function saveProject() {
  const s = useStore.getState();
  if (!s.objects.length) return;
  const bytes = await buildProject();
  const name = (s.project.title || s.objects[0].name || 'project').replace(/[^\w.-]+/g, '_');
  const saved = await saveFile(`${name}.3mf`, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '3mf');
  if (saved) s.set({ toast: { kind: 'info', text: `Project saved: ${saved}` } });
}

/** True if the buffer is a NexSpiro project (has our metadata). */
export async function isProject(data: ArrayBuffer) {
  try { return !!(await JSZip.loadAsync(data)).file('Metadata/nexspiro_project.json'); } catch { return false; }
}

export async function loadProject(data: ArrayBuffer) {
  const zip = await JSZip.loadAsync(data);
  const json = JSON.parse(await zip.file('Metadata/nexspiro_project.json')!.async('string')) as ProjectJson;
  if (json.app !== 'NexSpiro') throw new Error('Not a NexSpiro project');
  const doc = new DOMParser().parseFromString(await zip.file('3D/3dmodel.model')!.async('string'), 'application/xml');
  const objEls = Array.from(doc.getElementsByTagNameNS('*', 'object'));
  const meshes = objEls.map((el) => {
    const vs = Array.from(el.getElementsByTagNameNS('*', 'vertex'));
    const ts = Array.from(el.getElementsByTagNameNS('*', 'triangle'));
    const vertices = new Float32Array(vs.length * 3);
    vs.forEach((v, k) => { vertices[k * 3] = +v.getAttribute('x')!; vertices[k * 3 + 1] = +v.getAttribute('y')!; vertices[k * 3 + 2] = +v.getAttribute('z')!; });
    const indices = new Uint32Array(ts.length * 3);
    ts.forEach((t, k) => { indices[k * 3] = +t.getAttribute('v1')!; indices[k * 3 + 1] = +t.getAttribute('v2')!; indices[k * 3 + 2] = +t.getAttribute('v3')!; });
    return { vertices, indices };
  });
  const photos: ProjectInfo['photos'] = [];
  for (const p of json.project?.photos ?? []) {
    const f = zip.file(p.dataUrl);
    if (f) photos.push({ name: p.name, dataUrl: `data:image/${p.dataUrl.endsWith('png') ? 'png' : 'jpeg'};base64,${await f.async('base64')}` });
  }
  const objects: SceneObject[] = json.objects.map((o) => ({
    id: o.id || newId(), name: o.name, position: o.position, rotation: o.rotation, scale: o.scale, openEdges: o.openEdges ?? 0,
    filament: o.filament, overrides: o.overrides ? migrateConfig(o.overrides, json.version) : undefined, layerHeights: o.layerHeights, printable: o.printable,
    heightRanges: o.heightRanges?.map((r) => ({ ...r, overrides: migrateConfig(r.overrides, json.version) })), brimEars: o.brimEars, hidden: o.hidden, prim: o.prim, steps: Array.isArray(o.steps) ? o.steps : undefined,
    patternex: o.patternex ?? legacyPatternex(json.patternex, o.id),
    mesh: o.faceGroups ? { ...meshes[o.meshIndex], faceGroups: toU32(o.faceGroups), ...(o.groupKind ? { groupKind: o.groupKind } : {}) } : meshes[o.meshIndex],
    parts: o.parts?.map((p) => ({ id: p.id, name: p.name, type: p.type as any, position: p.position as any, rotation: p.rotation as any, scale: p.scale as any, overrides: p.overrides ?? {}, prim: p.prim, mesh: { vertices: toF32(p.v), indices: toU32(p.i) } })),
    paint: o.paint ? Object.fromEntries(Object.entries(o.paint).map(([k, v]) => [k, unb64(v)])) : undefined,
  }));
  useStore.getState().set({
    objects, selected: [], selectedPart: null, undoStack: [], redoStack: [],
    printerId: json.printerId, plate: json.plate as any, presetId: json.presetId, overrides: migrateConfig(json.overrides, json.version), machineOverrides: json.machineOverrides ?? {},
    filaments: json.filaments, mixes: Array.isArray(json.mixes) ? json.mixes : [], plates: json.plates?.length ? json.plates : [{ id: 'plate1', name: 'Plate 1', layerActions: [] }], activePlate: 0,
    project: { ...emptyProject(), ...json.project, photos },
    slice: { status: 'idle', stage: '', progress: 0, result: null, error: null, dirty: true, plate: 0 },
    workspace: 'prepare',
  });
  const ups = sanitizeUserPresets(json.userPresets).map((p) => ({ ...p, overrides: migrateConfig(p.overrides, json.version) }));
  mergeUserPresets(ups);
  const active = typeof json.userPresetId === 'string' ? useStore.getState().userPresets.find((p) => p.id === json.userPresetId) : undefined;
  useStore.getState().set({ userPresetId: active?.id ?? null });
  (await import('../plugins/registry')).loadPluginProjectData(json.plugins);
}

export async function openProjectDialog() {
  const { openFiles } = await import('../platform');
  const files = await openFiles([{ name: 'NexSpiro project / 3MF', extensions: ['3mf'] }], false);
  const f = files[0];
  if (!f) return;
  const { importBuffers } = await import('./actions');
  if (await isProject(f.data)) {
    try { await loadProject(f.data); useStore.getState().set({ toast: { kind: 'info', text: `Opened ${f.name}` } }); }
    catch (e: any) { useStore.getState().set({ toast: { kind: 'error', text: `Could not open ${f.name}: ${e?.message ?? e}` } }); }
  } else await importBuffers([f]);
}

/** Projects saved before placements moved onto objects kept them in one list keyed by object id. */
function legacyPatternex(d: PatternexProjectData | undefined, objectId: string) {
  if (!d?.placements?.length) return undefined;
  const placements = d.placements.filter((p) => p.object_id === objectId);
  if (!placements.length) return undefined;
  const ids = new Set(placements.map((p) => p.id));
  return { placements, actions: (d.actions ?? []).filter((a) => ids.has(a.region_ref.placement_id)), patterns: (d.patterns ?? []).filter((p) => placements.some((q) => q.pattern_id === p.id)) };
}
