// Tiny DOM helper: h("div.card", {onclick}, children).
type Attrs = Record<string, unknown>;
export function h<K extends keyof HTMLElementTagNameMap>(tag: string, attrs: Attrs | null = null, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name) as HTMLElementTagNameMap[K];
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) (el as unknown as Record<string, unknown>)[k] = v;
    else if (k === "value" || k === "checked") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids) if (c !== null && c !== false && c !== undefined) el.append(c);
  return el;
}

export function numInput(value: number, onChange: (v: number) => void, attrs: Attrs = {}): HTMLInputElement {
  return h<"input">("input", { type: "number", value: String(value), step: "any", ...attrs,
    onchange: (e: Event) => { const v = parseFloat((e.target as HTMLInputElement).value); if (Number.isFinite(v)) onChange(v); } });
}

export function select<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void, attrs: Attrs = {}): HTMLSelectElement {
  const s = h<"select">("select", { ...attrs, onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) },
    ...options.map(([v, l]) => h<"option">("option", { value: v, ...(v === value ? { selected: true } : {}) }, l)));
  s.value = value;
  return s;
}

export function download(name: string, text: string, type = "text/plain"): void {
  const a = h<"a">("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function pickFile(accept: string): Promise<string> {
  return new Promise((res) => {
    const i = h<"input">("input", { type: "file", accept, onchange: async () => { const f = i.files?.[0]; if (f) res(await f.text()); } });
    i.click();
  });
}
