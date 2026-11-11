import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHistory } from '../../src/ui/studio/history';

describe('design history', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const make = () => {
    const st = { d: { w: 1, h: [1, 1, 1] } };
    const h = createHistory(() => st.d, (d) => { st.d = d; h.touch(); });
    const edit = (f: (d: typeof st.d) => void) => { f(st.d); h.touch(); };
    return { st, h, edit };
  };

  it('records a step once edits pause, and coalesces a burst of edits', () => {
    const { st, h, edit } = make();
    for (let i = 2; i <= 9; i++) edit((d) => { d.h[1] = i; });
    expect(h.canRedo()).toBe(false);
    vi.advanceTimersByTime(500);
    edit((d) => { d.w = 5; });
    h.undo();
    expect(st.d).toEqual({ w: 1, h: [1, 9, 1] });
    h.undo();
    expect(st.d).toEqual({ w: 1, h: [1, 1, 1] });
    expect(h.canUndo()).toBe(false);
    h.redo(); h.redo();
    expect(st.d).toEqual({ w: 5, h: [1, 9, 1] });
    expect(h.canRedo()).toBe(false);
  });

  it('ignores edits that change nothing and drops redo after a new edit', () => {
    const { st, h, edit } = make();
    edit(() => {});
    h.flush();
    expect(h.canUndo()).toBe(false);
    edit((d) => { d.w = 2; }); h.flush();
    edit((d) => { d.w = 3; }); h.flush();
    h.undo();
    expect(st.d.w).toBe(2);
    edit((d) => { d.w = 7; }); h.flush();
    expect(h.canRedo()).toBe(false);
    h.undo();
    expect(st.d.w).toBe(2);
  });

  it('restores copies, so later in-place edits do not change the history', () => {
    const { st, h, edit } = make();
    edit((d) => { d.h[0] = 4; }); h.flush();
    h.undo();
    st.d.h[0] = 99; // mutate the restored object without telling the history
    h.redo();
    expect(st.d.h[0]).toBe(4);
    h.undo();
    expect(st.d.h[0]).toBe(1);
  });

  it('reset forgets every step', () => {
    const { h, edit } = make();
    edit((d) => { d.w = 2; }); h.flush();
    h.reset();
    expect(h.canUndo()).toBe(false);
  });
});
