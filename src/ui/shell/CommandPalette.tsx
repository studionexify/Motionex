// Ctrl+K command palette over paletteItems(): type to filter, arrows to move, Enter to run, Esc to close.
import { useEffect, useMemo, useRef, useState } from 'react';
import { paletteItems, useUi, type PaletteItem } from '../../state/ui';
import { Icon } from '../icons';

const SECTIONS: PaletteItem['section'][] = ['Actions', 'Tools', 'Settings', 'Plugins & effects', 'Physics Core'];

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  if (!open) return null;
  return <Palette />;
}

function Palette() {
  const setUi = useUi((s) => s.set);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const all = useMemo(() => paletteItems(), []);
  const items = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = all.filter((it) => {
      const hay = `${it.label} ${it.hint ?? ''} ${it.section}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    return SECTIONS.flatMap((s) => hit.filter((it) => it.section === s)).slice(0, 80);
  }, [all, q]);
  useEffect(() => setHl(0), [q]);
  useEffect(() => { listRef.current?.querySelector('.hl')?.scrollIntoView({ block: 'nearest' }); }, [hl]);
  const close = () => setUi({ paletteOpen: false });
  const run = (it?: PaletteItem) => { if (!it) return; close(); setTimeout(() => it.run(), 0); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { setHl((h) => Math.min(items.length - 1, h + 1)); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { setHl((h) => Math.max(0, h - 1)); e.preventDefault(); }
    else if (e.key === 'Enter') { run(items[hl]); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); e.preventDefault(); }
    e.stopPropagation();
  };
  let last = '';
  return (
    <div className="sh-palette-back" onPointerDown={close}>
      <div className="sh-palette" role="dialog" aria-label="Command palette" onPointerDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="sh-palette-in">
          <Icon name="search" size={18} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings, tools, plugins, actions…"
            role="combobox" aria-expanded="true" aria-controls="sh-palette-list" />
          <kbd>Esc</kbd>
        </div>
        <div className="sh-palette-list" id="sh-palette-list" role="listbox" ref={listRef}>
          {!items.length && <div className="sh-palette-empty">No matches</div>}
          {items.map((it, i) => {
            const head = it.section !== last ? <div className="sh-palette-sec">{it.section}</div> : null;
            last = it.section;
            return (
              <div key={it.id}>
                {head}
                <div role="option" aria-selected={i === hl} className={`sh-palette-it ${i === hl ? 'hl' : ''}`}
                  onPointerEnter={() => setHl(i)} onClick={() => run(it)}>
                  <span className="t">{it.label}{it.hint && <small>{it.hint}</small>}</span>
                  {it.value && <span className="val">{it.value}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="sh-palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Esc</kbd> close</span></div>
      </div>
    </div>
  );
}
