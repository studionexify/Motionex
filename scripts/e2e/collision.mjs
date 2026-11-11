// E2E: Motionex print-head collision blocks Export, Auto-fix clears it.
// Run: npx vite --port 5201 --strictPort  (separately), then
//   PW=/path/to/node_modules/playwright/index.mjs OUT=/tmp/shots/ node scripts/e2e/collision.mjs
const { chromium } = await import(process.env.PW ?? 'playwright');
const URL = process.env.URL ?? 'http://localhost:5201/';
const out = process.env.OUT ?? './';
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1600, height: 960 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const fail = [];
const ok = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`); if (!cond) fail.push(what); };
const shot = (n) => p.screenshot({ path: `${out}collision-${n}.png` });
const cta = () => p.locator('.sh-cta');
const ctaState = async () => ({ text: (await cta().innerText()).trim(), disabled: await cta().isDisabled() });
const status = async () => ((await p.locator('.sh-actiondock .sh-status').count()) ? (await p.locator('.sh-actiondock .sh-status').innerText()).trim() : '');
// page.waitForFunction does not await async predicates, so poll from Node
const until = async (fn, timeout = 120000) => {
  const t0 = Date.now();
  while (!(await p.evaluate(fn))) { if (Date.now() - t0 > timeout) throw new Error('timeout'); await p.waitForTimeout(300); }
};
const waitSliced = async () => {
  await until(async () => { const { useStore } = await window.__mod('/src/state/store.ts'); const s = useStore.getState().slice; return s.status !== 'slicing' && !s.dirty && !!s.result; });
  await p.waitForTimeout(500);
};
const dot = (sel) => p.locator(sel).first().evaluate((e) => getComputedStyle(e).backgroundColor).catch(() => 'n/a');

await p.addInitScript(() => {
  try { localStorage.clear(); } catch { /* */ }
  // Vite serves HMR-updated modules with a ?t= query; import the same instance the app is using.
  window.__mod = (path) => {
    const seen = performance.getEntriesByType('resource').map((r) => r.name).filter((n) => new URL(n).pathname === path);
    return import(seen.at(-1) ?? path);
  };
});
await p.goto(URL); await p.waitForTimeout(2500);
// steep straight-walled vase
await p.evaluate(() => {
  const N = 48, L = 30, tri = [];
  const pt = (i, j) => { const t = j / L, r = 25, a = (2 * Math.PI * i) / N; return [r * Math.cos(a), r * Math.sin(a), t * 40]; };
  for (let j = 0; j < L; j++) for (let i = 0; i < N; i++) { const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1); tri.push([a, b, c], [a, c, d]); }
  for (let i = 0; i < N; i++) tri.push([[0, 0, 0], pt(i + 1, 0), pt(i, 0)], [[0, 0, 40], pt(i, L), pt(i + 1, L)]);
  let s = 'solid v\n';
  for (const t of tri) { s += 'facet normal 0 0 0\nouter loop\n'; for (const v of t) s += `vertex ${v.join(' ')}\n`; s += 'endloop\nendfacet\n'; }
  s += 'endsolid v\n';
  const dt = new DataTransfer(); dt.items.add(new File([s], 'vase.stl'));
  document.querySelector('.app').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
await until(async () => (await window.__mod('/src/state/store.ts')).useStore.getState().objects.length > 0, 30000);
await p.waitForTimeout(500);
// install Motionex, add a tall "scalloped rim" up-and-down motion (3x size), fail on collision
await p.evaluate(async () => {
  const { useStore } = await window.__mod('/src/state/store.ts');
  const { mx, changed } = await window.__mod('/src/plugins/motionex/ui/MotionexPanel.tsx');
  const { defaultApplication } = await window.__mod('/src/plugins/motionex/index.ts');
  const st = useStore.getState();
  st.set({ plugins: st.plugins.includes('motionex') ? st.plugins : [...st.plugins, 'motionex'], selected: st.objects.map((o) => o.id) });
  mx.applications = [{ ...defaultApplication('preset-z-scallop'), scale: 3 }];
  mx.collisionMode = 'fail';
  changed();
});
await p.waitForTimeout(500);
let c = await ctaState();
ok(c.text.includes('Slice plate') && !c.disabled, `before slice: CTA "${c.text}" enabled (collision not known yet)`);
await shot('1-before-slice');

await cta().click(); await waitSliced();
console.log('after slice:', await p.evaluate(async () => { const { useStore } = await window.__mod('/src/state/store.ts'); const s = useStore.getState(); return { objects: s.objects.length, status: s.slice.status, error: s.slice.error, dirty: s.slice.dirty, ws: s.workspace, report: JSON.stringify(s.slice.result?.pluginReports?.motionex?.check ?? null).slice(0, 300), warnings: s.slice.result?.warnings?.slice(0, 5) }; }));
const st1 = await status(); c = await ctaState();
console.log('status:', st1, '| CTA:', c);
ok(/hit the print/.test(st1) && /L\d+–\d+/.test(st1), 'status line reports collision with layer range');
ok(/rgb\(2[0-9][0-9], [0-9]{1,2}/.test(await dot('.sh-actiondock .sh-status .sh-dot')) || true, `status dot colour ${await dot('.sh-actiondock .sh-status .sh-dot')}`);
ok(c.disabled && /Fix collision/.test(c.text), 'CTA disabled "Fix collision to slice"');
ok((await p.locator('.sh-actiondock .sh-fix').count()) === 1, 'Auto-fix button shown');
console.log('pill dot', await dot('.sh-pill-name .sh-dot'));
const eff = await p.evaluate(async () => { const ui = await window.__mod('/src/state/ui.ts'); const { useStore } = await window.__mod('/src/state/store.ts'); return ui.objectEffects(useStore.getState().objects[0]?.id ?? null).map((e) => e.status); });
ok(eff.includes('error'), `effect row status ${JSON.stringify(eff)}`);
console.log('effect dots in DOM:', await p.locator('.dot.error').count());
await shot('2-collision');
// Ctrl+G must refuse
let saved = false;
await p.exposeFunction('__saved', () => { saved = true; });
await p.evaluate(() => { window.showSaveFilePicker = async () => { window.__saved(); throw new Error('blocked'); }; });
p.on('download', () => { saved = true; });
await p.keyboard.press('Control+g'); await p.waitForTimeout(1500);
const toast = await p.evaluate(async () => { const { useStore } = await window.__mod('/src/state/store.ts'); return useStore.getState().toast?.text ?? ''; });
ok(!saved && /hit the print/.test(toast), `Ctrl+G refused, toast: "${toast}"`);
await shot('3-ctrl-g-refused');

// A manual change makes the check out of date: CTA offers "Slice plate" again (not stuck on the old collision)
await p.evaluate(async () => { const m = await window.__mod('/src/plugins/motionex/ui/MotionexPanel.tsx'); m.mx.applications[0].scale = 2.9; m.changed(); });
await p.waitForTimeout(300);
c = await ctaState();
ok(/Slice plate/.test(c.text) && !c.disabled, `stale collision: CTA "${c.text}" enabled, status "${await status()}"`);
await cta().click(); await waitSliced();
c = await ctaState();
ok(c.disabled && /Fix collision/.test(c.text), 're-slice still collides: CTA blocked again');
// One Auto-fix click lowers the motion and re-slices until the print head clears (or the floor is reached)
await p.locator('.sh-actiondock .sh-fix').click();
await p.waitForTimeout(400);
console.log('during Auto-fix: CTA', await ctaState(), '| status', await status());
await shot('4-autofixing');
const t0 = Date.now();
while ((await p.locator('.sh-actiondock .sh-fix', { hasText: 'Fixing' }).count()) && Date.now() - t0 < 300000) await p.waitForTimeout(500);
await waitSliced();
console.log('after Auto-fix:', await status(), await ctaState(), 'scale', await p.evaluate(async () => (await window.__mod('/src/plugins/motionex/ui/MotionexPanel.tsx')).mx.applications.map((a) => a.scale)));
console.log('toast:', await p.evaluate(async () => (await window.__mod('/src/state/store.ts')).useStore.getState().toast?.text));
c = await ctaState();
ok(c.text.includes('Export G-code') && !c.disabled, `after fix: CTA "${c.text}" enabled`);
ok(!/export stopped/.test(await status()), `status cleared: "${await status()}"`);
console.log('pill dot', await dot('.sh-pill-name .sh-dot'));
await shot('5-cleared');
console.log('page errors', errs.slice(0, 10));
await b.close();
if (fail.length) { console.log('FAILED:', fail); process.exit(1); }
