// Print job container (.gcode.3mf) of A1/P1/X1/H2 printers: plate G-code + MD5, thumbnail, slice info and
// project settings — the format the printers' "project_file" command expects on the SD card.
import JSZip from 'jszip';
import { md5 } from './md5';
import type { Config } from '../profiles/settings';
import type { SliceStats } from '../engine/types';

export interface PlateExport {
  gcode: string;
  stats: SliceStats;
  thumbnail?: Uint8Array; // PNG
  objects: { id: number; name: string }[];
  filaments: { type: string; color: string }[];
  supportUsed: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function buildGcode3mf(plates: PlateExport[], cfg: Config, printerModelId: string, nozzle: number): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
 ${plates[0]?.thumbnail ? '<Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>' : ''}
</Relationships>`);
  zip.file('3D/3dmodel.model', `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">NexSpiro-0.1.0</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources/>
 <build/>
</model>`);

  const plateXml: string[] = [];
  const modelPlates: string[] = [];
  plates.forEach((p, i) => {
    const n = i + 1;
    const bytes = new TextEncoder().encode(p.gcode);
    zip.file(`Metadata/plate_${n}.gcode`, bytes);
    zip.file(`Metadata/plate_${n}.gcode.md5`, md5(bytes).toUpperCase());
    if (p.thumbnail) zip.file(`Metadata/plate_${n}.png`, p.thumbnail);
    const used = p.stats.perFilament;
    plateXml.push(` <plate>
  <metadata key="index" value="${n}"/>
  <metadata key="printer_model_id" value="${esc(printerModelId)}"/>
  <metadata key="nozzle_diameters" value="${nozzle}"/>
  <metadata key="timelapse_type" value="0"/>
  <metadata key="prediction" value="${Math.round(p.stats.timeSeconds)}"/>
  <metadata key="weight" value="${p.stats.filamentGrams.toFixed(2)}"/>
  <metadata key="outside" value="false"/>
  <metadata key="support_used" value="${p.supportUsed}"/>
  <metadata key="label_object_enabled" value="false"/>
${p.objects.map((o) => `  <object identify_id="${o.id}" name="${esc(o.name)}" skipped="false"/>`).join('\n')}
${p.filaments.map((f, k) => used[k] && used[k].mm > 0 ? `  <filament id="${k + 1}" type="${esc(f.type)}" color="${esc(f.color)}" used_m="${(used[k].mm / 1000).toFixed(2)}" used_g="${used[k].grams.toFixed(2)}"/>` : '').filter(Boolean).join('\n')}
 </plate>`);
    modelPlates.push(` <plate>
  <metadata key="plater_id" value="${n}"/>
  <metadata key="plater_name" value=""/>
  <metadata key="locked" value="false"/>
  <metadata key="gcode_file" value="Metadata/plate_${n}.gcode"/>
  ${p.thumbnail ? `<metadata key="thumbnail_file" value="Metadata/plate_${n}.png"/>` : ''}
 </plate>`);
  });
  zip.file('Metadata/slice_info.config', `<?xml version="1.0" encoding="UTF-8"?>
<config>
 <header>
  <header_item key="X-BBL-Client-Type" value="slicer"/>
  <header_item key="X-BBL-Client-Version" value="01.09.00.00"/>
 </header>
${plateXml.join('\n')}
</config>`);
  zip.file('Metadata/model_settings.config', `<?xml version="1.0" encoding="UTF-8"?>
<config>
${modelPlates.join('\n')}
</config>`);
  const settings: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(cfg)) settings[k] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
  settings.filament_type = plates[0]?.filaments.map((f) => f.type) ?? [];
  settings.filament_colour = plates[0]?.filaments.map((f) => f.color) ?? [];
  settings.from = 'NexSpiro';
  zip.file('Metadata/project_settings.config', JSON.stringify(settings, null, 2));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** PrusaSlicer-style G-code thumbnails (read by Klipper/Moonraker, Creality and Elegoo screens). */
export function gcodeThumbnailBlock(png: Uint8Array, w: number, h: number): string {
  let bin = '';
  for (let i = 0; i < png.length; i++) bin += String.fromCharCode(png[i]);
  const b64 = btoa(bin);
  const lines = [`; thumbnail begin ${w}x${h} ${b64.length}`];
  for (let i = 0; i < b64.length; i += 78) lines.push(`; ${b64.slice(i, i + 78)}`);
  lines.push('; thumbnail end', ';');
  return lines.join('\n');
}
