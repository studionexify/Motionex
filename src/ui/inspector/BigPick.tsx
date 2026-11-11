// Big centred picker for plugin tabs. Long dropdowns, picture libraries (.mx-lib-grid) and chip rows of 4+ choices
// (.mx-chips, .fx-chips) are folded into a single "current choice" button in the tab; clicking it opens a centred
// window that mirrors the original controls live. Picks click the real (hidden) button, so each plugin's own logic runs.
import { useEffect, useReducer, useState } from 'react';
import { Modal } from '../Modals';

/** Dropdowns with more options than this open the window instead of a long native list. */
export const BIG_SELECT = 10;
const CHIP_MIN = 4;

/** Sets a <select>'s or <input>'s value the way a user would, so React's onChange fires. */
function setNative(el: HTMLSelectElement | HTMLInputElement, value: string, ev: 'change' | 'input') {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event(ev, { bubbles: true }));
}

const choices = (el: Element) => Array.from(el.children).filter((c): c is HTMLButtonElement => c instanceof HTMLButtonElement);

/** The picker blocks inside a plugin tab: each is a list of sibling elements shown together in one window. */
function findBlocks(root: HTMLElement): HTMLElement[][] {
  const out: HTMLElement[][] = [];
  const used = new Set<Element>();
  root.querySelectorAll<HTMLElement>('.mx-lib-grid').forEach((g) => {
    if (choices(g).length < 2) return;
    const block = [g];
    // a filter row and a search box right above a library belong to it
    let p = g.previousElementSibling as HTMLElement | null;
    for (let i = 0; i < 2 && p; i++, p = p.previousElementSibling as HTMLElement | null) {
      if (p.matches('.mx-chips, input.input')) block.unshift(p); else break;
    }
    block.forEach((b) => used.add(b));
    out.push(block);
  });
  root.querySelectorAll<HTMLElement>('.mx-chips:not(.px-tabs), .fx-chips').forEach((c) => {
    if (!used.has(c) && choices(c).length >= CHIP_MIN) out.push([c]);
  });
  return out;
}

function titleOf(el: HTMLElement): string {
  const card = el.closest('.mx-card');
  const t = card?.querySelector('.mx-card-title')?.textContent?.trim();
  let p = el.previousElementSibling;
  while (p && !p.matches('.mx-label, .mx-card-title')) p = p.previousElementSibling;
  return p?.textContent?.trim() || t || 'Choose';
}

export type PickTarget = { kind: 'select'; sel: HTMLSelectElement; title: string } | { kind: 'block'; els: HTMLElement[]; title: string };

/** Folds the picker blocks under `root` behind trigger buttons; returns a cleanup. */
export function foldPickers(root: HTMLElement, open: (t: PickTarget) => void): () => void {
  let busy = false;
  const sync = () => {
    if (busy) return;
    busy = true;
    const blocks = findBlocks(root);
    const keep = new Set<Element>();
    for (const els of blocks) {
      const first = els[0];
      let trig = first.previousElementSibling as HTMLButtonElement | null;
      if (!trig?.dataset.bp) {
        trig = document.createElement('button');
        trig.dataset.bp = '1';
        trig.className = 'select bp-trigger';
        first.before(trig);
      }
      keep.add(trig);
      const last = els[els.length - 1];
      const cur = choices(last).find((b) => b.classList.contains('on'));
      const label = (cur?.querySelector('span')?.textContent ?? cur?.textContent ?? '').trim() || `Choose… (${choices(last).length})`;
      if (trig.textContent !== label) trig.textContent = label;
      trig.onclick = (e) => { e.preventDefault(); open({ kind: 'block', els, title: titleOf(first) }); };
      els.forEach((e) => e.classList.add('bp-hidden'));
    }
    root.querySelectorAll<HTMLElement>('[data-bp]').forEach((t) => { if (!keep.has(t)) t.remove(); });
    busy = false;
  };
  sync();
  const mo = new MutationObserver(() => { mo.disconnect(); sync(); mo.observe(root, { childList: true, subtree: true }); });
  mo.observe(root, { childList: true, subtree: true });
  const onDown = (e: MouseEvent) => {
    const sel = (e.target as HTMLElement).closest('select');
    if (!sel || sel.disabled || sel.options.length <= BIG_SELECT) return;
    e.preventDefault();
    const title = sel.getAttribute('aria-label') || sel.closest('label')?.firstChild?.textContent?.trim() || 'Choose';
    open({ kind: 'select', sel, title });
  };
  root.addEventListener('mousedown', onDown);
  return () => {
    mo.disconnect();
    root.removeEventListener('mousedown', onDown);
    root.querySelectorAll('[data-bp]').forEach((t) => t.remove());
  };
}

/** Re-renders whenever the mirrored source elements change. */
function useWatch(els: Element[]) {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const mo = new MutationObserver(bump);
    els.forEach((e) => e.parentElement && mo.observe(e.parentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src'] }));
    return () => mo.disconnect();
  }, [els]);
}

export function BigPicker({ target, onClose }: { target: PickTarget; onClose: () => void }) {
  return (
    <Modal title={target.title} onClose={onClose}>
      <div className="bigpick">
        {target.kind === 'select' ? <SelectBody sel={target.sel} onClose={onClose} /> : <BlockBody els={target.els} onClose={onClose} />}
      </div>
    </Modal>
  );
}

function SelectBody({ sel, onClose }: { sel: HTMLSelectElement; onClose: () => void }) {
  const [q, setQ] = useState('');
  const groups: [string, HTMLOptionElement[]][] = [];
  for (const o of Array.from(sel.options)) {
    const g = o.parentElement instanceof HTMLOptGroupElement ? o.parentElement.label : '';
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(o); else groups.push([g, [o]]);
  }
  const f = q.trim().toLowerCase();
  return <>
    <input className="input" autoFocus placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter options" />
    {groups.map(([g, os]) => {
      const shown = os.filter((o) => !f || o.text.toLowerCase().includes(f));
      if (!shown.length) return null;
      return (
        <div key={g || '_'}>
          {g && <div className="grp">{g}</div>}
          <div className="bigpick-grid">
            {shown.map((o) => (
              <button key={o.value} disabled={o.disabled} className={o.value === sel.value ? 'on' : ''}
                onClick={() => { setNative(sel, o.value, 'change'); onClose(); }}>{o.text}</button>
            ))}
          </div>
        </div>
      );
    })}
  </>;
}

function BlockBody({ els, onClose }: { els: HTMLElement[]; onClose: () => void }) {
  useWatch(els);
  return <>
    {els.map((el, i) => {
      if (!el.isConnected) return null;
      const final = i === els.length - 1;
      if (el instanceof HTMLInputElement) {
        return <input key={i} className="input" autoFocus placeholder={el.placeholder} defaultValue={el.value} onChange={(e) => setNative(el, e.target.value, 'input')} />;
      }
      const lib = el.classList.contains('mx-lib-grid');
      return (
        <div key={i} className={lib ? 'bigpick-lib' : final ? 'bigpick-grid' : 'bigpick-chips'}>
          {choices(el).map((b, k) => (
            <button key={k} disabled={b.disabled} className={b.classList.contains('on') ? 'on' : ''} title={b.dataset.tip ?? b.title}
              onClick={() => { b.click(); if (final) onClose(); }}
              // mirrors the app's own button markup (thumbnail + name), never user HTML
              dangerouslySetInnerHTML={{ __html: b.innerHTML }} />
          ))}
        </div>
      );
    })}
  </>;
}
