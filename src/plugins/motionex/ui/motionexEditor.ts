// Motionex brush editor window: library, curve editor, live 2D preview, parameters.
import { h, numInput, select, download, pickFile } from "./dom";
import { CurveEditor } from "./curveEditor";
import { CURVE_INFO, CURVE_KEYS, type CurveKey, type MotionBrush, type Interpolation, type RepeatMode, type LayerMode, type EventType, type MotionEvent } from "../model";
import { applyBrushToPath, brushAt } from "../modifier";
import { parseBrush, serializeBrush } from "../library";
import type { MotionexState } from "../index";
import type { PrintProfiles } from "../core/profiles";
import type { Toolpath } from "../core/types";

export function openMotionexEditor(root: HTMLElement, mx: MotionexState, profiles: () => PrintProfiles, startId: string | null, onClose: (changed: boolean) => void): void {
  let brush: MotionBrush = structuredClone(mx.library.get(startId ?? "") ?? mx.library.all()[0]);
  let curveKey: CurveKey = "lateral_offset";
  let dirty = false, changed = false;
  let editor: CurveEditor;
  let query = "";
  const openGroups = new Set<string>([brushGroup(brush)]);

  const win = h("div.window", { role: "dialog", "aria-label": "Motionex motion library" });
  const lib = h("div.wlib"), main = h("div.wmain"), side = h("div.wside");
  const previewCanvas = h<"canvas">("canvas", { style: "height:190px" });
  const previewCap = h("div.cap");
  const wallCanvas = h<"canvas">("canvas", { style: "height:170px" });
  const pointBox = h("div");
  const saveBtn = h<"button">("button.primary", { onclick: save }, "Save motion");
  const title = h("span.title");
  const desc = h("div.wdesc");

  win.append(
    h("div.whead", null, h("span.plugin-badge", null, "M"), h("div", null, title, desc), h("div.spacer"),
      h("button", { onclick: async () => { try { const b = parseBrush(await pickFile(".json,application/json")); brush = mx.library.save(b); changed = true; dirty = false; renderAll(); } catch (e) { alert(`That file could not be opened: ${(e as Error).message}`); } } }, "Open file…"),
      h("button", { onclick: () => download(`${brush.name.replace(/\W+/g, "-").toLowerCase()}.motionex.json`, serializeBrush(brush), "application/json") }, "Save to file"),
      saveBtn, h("button.ghost", { onclick: close, "aria-label": "Close" }, "✕")),
    lib, main, side);
  root.replaceChildren(win); root.hidden = false;
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  function close(): void {
    if (dirty && !confirm("You have unsaved changes to this motion. Close anyway?")) return;
    document.removeEventListener("keydown", onKey);
    root.hidden = true; root.replaceChildren(); onClose(changed);
  }

  function save(): void {
    brush = mx.library.save(brush); dirty = false; changed = true; renderAll();
  }

  function touch(): void { dirty = true; title.textContent = `${brush.name} •`; drawPreview(); }

  function renderLib(): void {
    const q = query.trim().toLowerCase();
    const match = (b: MotionBrush) => !q || `${b.name} ${b.category ?? ""} ${b.description ?? ""}`.toLowerCase().includes(q);
    const groups = new Map<string, MotionBrush[]>();
    for (const b of mx.library.all()) if (match(b)) { const g = brushGroup(b); groups.set(g, [...(groups.get(g) ?? []), b]); }
    const total = [...groups.values()].reduce((n, bs) => n + bs.length, 0);
    const search = h<"input">("input.lib-search", { type: "search", placeholder: `Search ${mx.library.all().length} motions…`, value: query,
      oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; renderLib(); const s = lib.querySelector<HTMLInputElement>("input"); s?.focus(); s?.setSelectionRange(query.length, query.length); } });
    lib.replaceChildren(search, ...(total ? [] : [h("div.muted", null, "No motions match.")]),
      ...[...groups].map(([g, bs]) => {
        const d = h<"details">("details.lib-group", { open: q !== "" || openGroups.has(g) }, h("summary", null, h("span", null, `${g} (${bs.length})`)), h("div.list"));
        d.addEventListener("toggle", () => { if (d.open) fillGroup(d, bs); if (!q) { if (d.open) openGroups.add(g); else openGroups.delete(g); } });
        if (d.open) fillGroup(d, bs);
        return d;
      }),
      h("div.muted", { style: "margin-top:10px" }, "Change any motion and press Save to keep your own version under My motions."));
  }

  function fillGroup(d: HTMLDetailsElement, bs: MotionBrush[]): void {
    const list = d.querySelector(".list")!;
    if (list.childElementCount) return;
    list.append(...bs.map((b) => {
      const el = h("div.item" + (b.id === brush.id ? ".sel" : ""), { title: b.description ?? "",
        onclick: () => { if (dirty && !confirm("You have unsaved changes. Switch motion anyway?")) return; brush = structuredClone(b); dirty = false; renderAll(); } },
        h("canvas", { width: 44, height: 18, style: "width:44px;height:18px" }), h("span.name", null, b.name),
        !mx.library.isPreset(b.id) ? h("button.ghost.sm", { title: "Delete", onclick: (e: Event) => { e.stopPropagation(); if (confirm(`Delete ${b.name}?`)) { mx.library.remove(b.id); changed = true; renderLib(); } } }, "✕") : null);
      thumb(el.querySelector("canvas")!, b);
      return el;
    }));
  }

  function renderMain(): void {
    const info = CURVE_INFO[curveKey];
    editor = new CurveEditor(brush.curves[curveKey], { min: info.min, max: info.max, disabled: !info.enabled, onChange: () => { renderPoint(); touch(); }, onSelect: () => renderPoint() });
    const tabs = h("div.ctabs", null, ...CURVE_KEYS.map((k) => h("button.sm" + (k === curveKey ? ".on" : ""), { onclick: () => { curveKey = k; renderMain(); } }, CURVE_INFO[k].label)));
    const interp = select<Interpolation>(brush.curves[curveKey].interpolation, [["bezier", "Smooth curves"], ["linear", "Straight lines"], ["step", "Sudden jumps"]], (v) => { brush.curves[curveKey].interpolation = v; editor.draw(); touch(); }, { style: "width:auto", disabled: !info.enabled });
    main.replaceChildren(
      h("div", { style: "display:flex;gap:8px;align-items:center;justify-content:space-between" }, tabs, interp),
      h("div.canvas-box", null, editor.canvas, h("div.cap", null, `${info.label} · ${info.unit} · double-click to add a dot`)),
      pointBox,
      h("div.section", null, "Preview: a 40 mm piece of wall, seen from above"),
      h("div.canvas-box", null, previewCanvas, previewCap),
      h("div.section", null, "Wall view: 40 mm wide, 80 layers tall, seen from the side"),
      h("div.canvas-box", null, wallCanvas, h("div.cap", null, "orange = sticks out · blue = pressed in")),
    );
    requestAnimationFrame(() => { editor.draw(); drawPreview(); });
    renderPoint();
  }

  function renderPoint(): void {
    const i = editor.selected;
    if (i === null) { pointBox.replaceChildren(h("div.muted", null, "Drag the dots to reshape the motion. Click a dot to type exact numbers or drag its handles. Press Delete to remove a dot.")); return; }
    const p = brush.curves[curveKey].points[i];
    const set = (fn: () => void) => () => { fn(); editor.draw(); touch(); };
    const last = brush.curves[curveKey].points.length - 1;
    pointBox.replaceChildren(h("div.row.three", { style: "grid-template-columns:repeat(6,1fr)" },
      h("label", null, "Position % ", numInput(Math.round(p.t * 1000) / 10, (v) => set(() => { if (i > 0 && i < last) p.t = Math.min(1, Math.max(0, v / 100)); })())),
      h("label", null, "Amount ", numInput(p.v, (v) => set(() => { p.v = v; })())),
      h("label", null, "Left handle ↔ ", numInput(p.in_handle[0], (v) => set(() => { p.in_handle[0] = Math.min(0, v); })())),
      h("label", null, "Left handle ↕ ", numInput(p.in_handle[1], (v) => set(() => { p.in_handle[1] = v; })())),
      h("label", null, "Right handle ↔ ", numInput(p.out_handle[0], (v) => set(() => { p.out_handle[0] = Math.max(0, v); })())),
      h("label", null, "Right handle ↕ ", numInput(p.out_handle[1], (v) => set(() => { p.out_handle[1] = v; })())),
    ));
  }

  function renderSide(): void {
    const row = (label: string, input: HTMLElement) => h("div.row", null, h("label", null, label), input);
    const n = brush.noise;
    side.replaceChildren(h("div", null,
      h("div.section", { style: "margin-top:0" }, "Motion"),
      row("Name", h<"input">("input", { value: brush.name, "aria-label": "Motion name", oninput: (e: Event) => { brush.name = (e.target as HTMLInputElement).value; touch(); } })),
      row("Wave height (mm)", numInput(brush.amplitude, (v) => { brush.amplitude = Math.max(0, v); touch(); }, { min: 0, step: 0.05 })),
      row("Wave length (mm)", numInput(brush.period_mm, (v) => { brush.period_mm = Math.max(0.2, v); touch(); }, { min: 0.2, step: 0.1 })),
      row("Start shift (°)", numInput(brush.phase_deg, (v) => { brush.phase_deg = ((v % 360) + 360) % 360; touch(); }, { step: 15 })),
      row("Up-and-down height (mm)", numInput(brush.z_amplitude ?? 0, (v) => { brush.z_amplitude = Math.min(5, Math.max(0, v)); touch(); }, { min: 0, step: 0.1, title: "How far the nozzle moves up and down. Shape it on the Up and down tab." })),
      row("Repeat", select<RepeatMode>(brush.repeat_mode, [["tile", "All the way round"], ["once", "Only once"], ["stretch", "Fit evenly (no seam)"]], (v) => { brush.repeat_mode = v; touch(); })),
      h("div.section", null, "Plastic limits"),
      row("Least plastic", numInput(brush.limits.min_flow_mult, (v) => { brush.limits.min_flow_mult = v; touch(); }, { step: 0.05 })),
      row("Most plastic", numInput(brush.limits.max_flow_mult, (v) => { brush.limits.max_flow_mult = v; touch(); }, { step: 0.05 })),
      h("div.muted", null, "1 is the normal amount. Nexspiro also slows down automatically if your printer can't melt plastic fast enough."),
      h("div.section", null, "Roughness"),
      h("label.inline", null, h<"input">("input", { type: "checkbox", checked: !!n?.enabled, onchange: (e: Event) => {
        const on = (e.target as HTMLInputElement).checked;
        brush.noise = on ? (n ?? { enabled: true, type: "value", seed: 1337, scale: 1, octaves: 3, persistence: 0.5 }) : n ? { ...n, enabled: false } : null;
        if (brush.noise) brush.noise.enabled = on; renderSide(); touch();
      } }), "Add random roughness"),
      n?.enabled ? h("div", null,
        row("Motion number", numInput(n.seed, (v) => { n.seed = Math.round(v); touch(); }, { step: 1 })),
        row("Size", numInput(n.scale, (v) => { n.scale = Math.max(0.05, v); touch(); }, { step: 0.1 })),
        row("Detail", numInput(n.octaves, (v) => { n.octaves = Math.min(6, Math.max(1, Math.round(v))); touch(); }, { step: 1 })),
        row("Bumpiness", numInput(n.persistence, (v) => { n.persistence = v; touch(); }, { step: 0.05 })),
      ) : null,
      h("div.section", null, "Layer by layer"),
      row("Change each layer", select<LayerMode | "none">(brush.layers ? brush.layers.mode : "none",
        [["none", "No change"], ["steady", "Twist (keep shifting)"], ["alternate", "Swap back and forth"], ["back_and_forth", "Shift, then shift back"], ["shift_hold", "Shift, pause, shift back"], ["wave", "Swing between lead and lag (wave)"]],
        (v) => { brush.layers = v === "none" ? (brush.layers && brush.layers.band_on > 0 ? { ...brush.layers, shift_deg: 0, mode: "steady" } : null) : { shift_deg: 15, every: 4, band_on: 0, band_off: 0, ...brush.layers, mode: v }; renderSide(); touch(); })),
      brush.layers ? h("div", null,
        row("Shift by (°)", numInput(brush.layers.shift_deg, (v) => { brush.layers!.shift_deg = v; touch(); }, { step: 5 })),
        row("Every … layers", numInput(brush.layers.every, (v) => { brush.layers!.every = Math.max(1, Math.round(v)); touch(); }, { min: 1, step: 1 })),
      ) : null,
      row("Motion on for … layers", numInput(brush.layers?.band_on ?? 0, (v) => { brush.layers = { shift_deg: 0, mode: "steady", every: 1, band_off: 0, ...brush.layers, band_on: Math.max(0, Math.round(v)) }; renderSide(); touch(); }, { min: 0, step: 1, title: "0 = on all the time" })),
      brush.layers && brush.layers.band_on > 0 ? row("then plain for … layers", numInput(brush.layers.band_off, (v) => { brush.layers!.band_off = Math.max(0, Math.round(v)); touch(); }, { min: 0, step: 1 })) : null,
      brush.layers && brush.layers.mode !== "alternate" ? h("label.inline", null, h<"input">("input", { type: "checkbox", checked: !!brush.layers.cross, onchange: (e: Event) => { brush.layers!.cross = (e.target as HTMLInputElement).checked; touch(); } }), "Slant both ways (makes diamonds and cells)") : null,
      h("div.muted", null, "Shifting the motion a little each layer makes twists, diamonds, bricks and honeycombs. On/off makes rings and stripes."),
      h("div.section", null, "Pauses, blobs and lift-offs"),
      ...brush.events.map((e, i) => eventRow(e, i)),
      h("div", null, ...([["dwell", "+ Pause"], ["flow_change", "+ Plastic change"], ["retract", "+ Lift-off"]] as [EventType, string][]).map(([t, l]) =>
        h("button.sm", { style: "margin:2px", onclick: () => { brush.events.push(newEvent(t)); renderSide(); touch(); } }, l))),
      h("div.muted", null, "Each one happens at its spot in every repeat (or only once). Pause can push out a blob for dots and pearls; lift-off stops printing for a short jump."),
      h("div.section", null, "About"),
      h("div.muted", null, `${brush.category ?? "My motions"} · version ${brush.version}${mx.library.isPreset(brush.id) ? " · built-in (saving keeps your own copy)" : ""}`),
    ));
  }

  function newEvent(t: EventType): MotionEvent {
    return t === "dwell" ? { at: { mode: "percent", value: 50 }, type: t, params: { ms: 300, blob_mm3: 0 } }
      : t === "flow_change" ? { at: { mode: "percent", value: 50 }, type: t, params: { mult: 1.3 } }
      : { at: { mode: "percent", value: 50 }, type: t, params: { length: 0, travel_mm: 1 } };
  }

  function eventRow(e: MotionEvent, i: number): HTMLElement {
    const label = { dwell: "Pause", flow_change: "Plastic change", retract: "Lift-off" }[e.type];
    const p = (key: string, text: string, step: number, title = "") => h("label.muted", { title }, text, numInput(e.params[key] ?? 0, (v) => { e.params[key] = Math.max(0, v); touch(); }, { min: 0, step }));
    return h("div.app", null,
      h("div.app-top", null, h("strong", { style: "flex:1" }, label),
        h("label.inline.muted", null, h<"input">("input", { type: "checkbox", checked: !!e.once, onchange: (ev: Event) => { e.once = (ev.target as HTMLInputElement).checked; touch(); } }), "only once"),
        h("button.ghost.sm", { title: "Remove", onclick: () => { brush.events.splice(i, 1); renderSide(); touch(); } }, "✕")),
      h("div.row.three", null,
        h("label.muted", null, "At (% of repeat)", numInput(e.at.mode === "percent" ? e.at.value : 0, (v) => { e.at = { mode: "percent", value: Math.min(100, Math.max(0, v)) }; touch(); }, { min: 0, max: 100, step: 5 })),
        ...(e.type === "dwell" ? [p("ms", "Pause (ms)", 50), p("blob_mm3", "Blob size (mm³)", 0.5, "0 = no blob")]
          : e.type === "flow_change" ? [h("label.muted", null, "Plastic (1 = normal)", numInput(e.params.mult ?? 1, (v) => { e.params.mult = Math.max(0, v); touch(); }, { min: 0, step: 0.1 })), h("span")]
          : [p("travel_mm", "Jump (mm)", 0.5), p("length", "Pull back (mm)", 0.1, "0 = use print settings")])));
  }

  function drawPreview(): void {
    const t0 = performance.now();
    const p = profiles();
    const L = 40;
    const base: Toolpath = { feature: "outer_wall", closed: false, points: [
      { x: 0, y: 0, z: 1, f: p.process.wallSpeed, flow: 1, e: 0 }, { x: L, y: 0, z: 1, f: p.process.wallSpeed, flow: 1, e: 0 }] };
    const out = applyBrushToPath(base, brush, p, mx.options, () => 1, () => {});
    const cv = previewCanvas, dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext("2d")!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const span = Math.max(2, brush.amplitude * 2.6);
    const sx = (W - 40) / L, sy = Math.min(sx, (H - 30) / (span * 2));
    const X = (x: number) => 20 + x * sx, Y = (y: number) => H / 2 - y * sy;
    g.strokeStyle = "#cfd5dd"; g.setLineDash([4, 4]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(L), Y(0)); g.stroke(); g.setLineDash([]);
    const bead = p.process.lineWidth * sy;
    for (let i = 1; i < out.points.length; i++) {
      const a = out.points[i - 1], b = out.points[i];
      if (b.travel) { g.strokeStyle = "#cfd5dd"; g.lineWidth = 1; g.beginPath(); g.moveTo(X(a.x), Y(a.y)); g.lineTo(X(b.x), Y(b.y)); g.stroke(); continue; }
      g.strokeStyle = `hsl(${(1 - Math.min(1, Math.max(0, (b.flow - 0.5) / 1.1))) * 240},75%,52%)`;
      g.lineWidth = Math.max(1.5, Math.min(14, bead * b.flow)); g.lineCap = "round";
      g.beginPath(); g.moveTo(X(a.x), Y(a.y)); g.lineTo(X(b.x), Y(b.y)); g.stroke();
    }
    g.fillStyle = "#8a93a0"; g.font = "11px Inter, system-ui";
    g.fillText("plain wall", X(0), Y(0) - 6 - brush.amplitude * sy);
    // Event markers: pauses as dots, lift-offs as gaps already drawn grey, plastic changes as ticks.
    for (const q of out.points) {
      if (q.post?.dwell_ms) { g.fillStyle = "#e5484d"; g.beginPath(); g.arc(X(q.x), Y(q.y), Math.max(3, Math.min(9, 3 + (q.post.blob_mm ?? 0) * 6)), 0, Math.PI * 2); g.fill(); }
      if (q.post?.retract_mm) { g.fillStyle = "#2b6cb0"; g.fillRect(X(q.x) - 1, Y(q.y) - 10, 2, 20); }
    }
    g.fillText("10 mm", X(L - 10), H - 8); g.strokeStyle = "#8a93a0"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(X(L - 10), H - 18); g.lineTo(X(L), H - 18); g.stroke();
    drawWall();
    previewCap.textContent = `colour and thickness show the amount of plastic · ${(performance.now() - t0).toFixed(0)} ms`;
  }

  function drawWall(): void {
    const cv = wallCanvas, W = Math.max(1, cv.clientWidth), H = Math.max(1, cv.clientHeight);
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d")!, img = g.createImageData(W, H), L = 40, rows = 80, A = Math.max(0.05, brush.amplitude * 1.2);
    for (let r = 0; r < rows; r++) {
      const layer = rows - 1 - r, y0 = Math.floor((r * H) / rows), y1 = Math.floor(((r + 1) * H) / rows);
      for (let x = 0; x < W; x++) {
        const m = brushAt(brush, (x / W) * L, L, layer);
        const t = m ? Math.max(-1, Math.min(1, m.lat / A)) : 0;
        const [cr, cg, cb] = t >= 0 ? [251 - 2 * t * 0, 250 - t * 110, 248 - t * 200] : [248 + t * 170, 250 + t * 110, 252];
        for (let y = y0; y < y1; y++) { const i = (y * W + x) * 4; img.data[i] = cr; img.data[i + 1] = cg; img.data[i + 2] = cb; img.data[i + 3] = 255; }
      }
    }
    g.putImageData(img, 0, 0);
  }

  function thumb(cv: HTMLCanvasElement, b: MotionBrush): void {
    const g = cv.getContext("2d")!; g.clearRect(0, 0, 44, 18);
    const p = profiles();
    const out = applyBrushToPath({ feature: "outer_wall", closed: false, points: [{ x: 0, y: 0, z: 0, f: 30, flow: 1, e: 0 }, { x: b.period_mm * 2.5, y: 0, z: 0, f: 30, flow: 1, e: 0 }] }, b, p, { ...mx.options, resampleStep: b.period_mm / 24 }, () => 1, () => {});
    const L = b.period_mm * 2.5, A = Math.max(0.01, b.amplitude * 1.3);
    g.strokeStyle = "#7c3aed"; g.lineWidth = 1.5; g.beginPath();
    out.points.forEach((q, i) => { const x = 2 + (q.x / L) * 40, y = 9 - (q.y / A) * 7; i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  }

  function renderAll(): void { title.textContent = brush.name + (dirty ? " •" : ""); desc.textContent = brush.description ?? ""; openGroups.add(brushGroup(brush)); renderLib(); renderMain(); renderSide(); }

  function brushGroup(b: MotionBrush): string { return mx.library.isPreset(b.id) ? b.category ?? "Other" : "My motions"; }
  renderAll();
}
