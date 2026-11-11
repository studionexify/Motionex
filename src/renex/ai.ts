// Renex optional AI pass. Off by default: Renex is a physically based renderer and needs no AI. When the
// user adds an API key and turns the pass on, the finished render can be sent to an image model for
// photographic polish (structure-preserving modes only, so the printed geometry stays as designed). Any
// image that went through this pass is marked as AI-assisted in its metadata (see metadata.ts).

export type AiProviderId = 'stability' | 'openai' | 'replicate' | 'custom';

export interface AiProviderInfo { id: AiProviderId; name: string; keyHint: string; note: string }

export const AI_PROVIDERS: AiProviderInfo[] = [
  { id: 'stability', name: 'Stability AI (Structure control)', keyHint: 'sk-…', note: 'Keeps the render\'s structure; restyles light and texture only.' },
  { id: 'openai', name: 'OpenAI Images (edit)', keyHint: 'sk-…', note: 'Image edit with a preservation prompt.' },
  { id: 'replicate', name: 'Replicate (any img2img model)', keyHint: 'r8_…', note: 'Set the model version in "Model".' },
  { id: 'custom', name: 'Custom HTTP endpoint', keyHint: 'Bearer token', note: 'POST multipart (image, prompt, strength) → image bytes.' },
];

export interface AiSettings {
  enabled: boolean;
  provider: AiProviderId;
  keys: Partial<Record<AiProviderId, string>>;
  /** Replicate model version or custom endpoint URL. */
  model: string;
  endpoint: string;
  /** 0 = keep the render, 1 = free reinterpretation. Kept low by default. */
  strength: number;
  prompt: string;
}

const KEY = 'nexspiro.renex.ai.v1';
const storage = typeof localStorage !== 'undefined' ? localStorage : null;

export const defaultAi = (): AiSettings => ({
  enabled: false, provider: 'stability', keys: {}, model: '', endpoint: '', strength: 0.25,
  prompt: 'Professional product photograph of a 3D printed object, visible FDM layer lines, natural light, sharp focus. Keep the object\'s shape, colours, size and every detail exactly as in the input.',
});

export function loadAi(): AiSettings {
  try { return { ...defaultAi(), ...JSON.parse(storage?.getItem(KEY) ?? '{}') }; } catch { return defaultAi(); }
}
/** Keys are stored only on this device (local storage), never in projects or exported images. */
export function saveAi(s: AiSettings) { try { storage?.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } }

export const aiReady = (s: AiSettings) => s.enabled && !!s.keys[s.provider] && (s.provider !== 'custom' || !!s.endpoint) && (s.provider !== 'replicate' || !!s.model);

/** Send a rendered image through the configured provider; resolves to the new image bytes (PNG/JPEG). */
export async function aiEnhance(image: Blob, s: AiSettings, signal?: AbortSignal): Promise<Blob> {
  if (!aiReady(s)) throw new Error('AI pass is not configured (enable it and add an API key).');
  const key = s.keys[s.provider]!;
  const strength = Math.max(0, Math.min(1, s.strength));
  if (s.provider === 'stability') {
    const f = new FormData();
    f.append('image', image, 'render.png'); f.append('prompt', s.prompt); f.append('control_strength', String(1 - strength * 0.6)); f.append('output_format', 'png');
    const r = await fetch('https://api.stability.ai/v2beta/stable-image/control/structure', { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'image/*' }, body: f, signal });
    if (!r.ok) throw new Error(`Stability AI: ${r.status} ${await r.text()}`);
    return r.blob();
  }
  if (s.provider === 'openai') {
    const f = new FormData();
    f.append('model', 'gpt-image-1'); f.append('image', image, 'render.png'); f.append('prompt', s.prompt); f.append('input_fidelity', 'high');
    const r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: f, signal });
    if (!r.ok) throw new Error(`OpenAI: ${r.status} ${await r.text()}`);
    const j = await r.json() as { data: { b64_json: string }[] };
    return b64ToBlob(j.data[0].b64_json);
  }
  if (s.provider === 'replicate') {
    const dataUrl = await blobToDataUrl(image);
    const start = await fetch('https://api.replicate.com/v1/predictions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'wait' }, body: JSON.stringify({ version: s.model, input: { image: dataUrl, prompt: s.prompt, prompt_strength: strength } }), signal });
    if (!start.ok) throw new Error(`Replicate: ${start.status} ${await start.text()}`);
    let pred = await start.json() as { status: string; output?: string | string[]; urls: { get: string }; error?: string };
    while (pred.status !== 'succeeded' && pred.status !== 'failed' && pred.status !== 'canceled') {
      await new Promise((res) => setTimeout(res, 1500));
      pred = await (await fetch(pred.urls.get, { headers: { Authorization: `Bearer ${key}` }, signal })).json();
    }
    if (pred.status !== 'succeeded') throw new Error(`Replicate: ${pred.error ?? pred.status}`);
    const url = Array.isArray(pred.output) ? pred.output[0] : pred.output!;
    return (await fetch(url, { signal })).blob();
  }
  const f = new FormData();
  f.append('image', image, 'render.png'); f.append('prompt', s.prompt); f.append('strength', String(strength));
  const r = await fetch(s.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: f, signal });
  if (!r.ok) throw new Error(`Custom endpoint: ${r.status} ${await r.text()}`);
  return r.blob();
}

function b64ToBlob(b64: string): Blob { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: 'image/png' }); }
function blobToDataUrl(b: Blob): Promise<string> { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.onerror = rej; fr.readAsDataURL(b); }); }
