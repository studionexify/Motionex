// Prepare-workspace actions that are one user step must also be one Undo step.
import { describe, expect, it } from 'vitest';
import { useStore } from '../src/state/store';
import { addShape, cloneObjects } from '../src/state/objectOps';
import { arrangeAll } from '../src/state/ops';

const S = () => useStore.getState();
function reset() {
  useStore.setState({
    printerId: 'bbl-a1', objects: [], selected: [], selectedPart: null, undoStack: [], redoStack: [], activePlate: 0,
    plates: [{ id: 'plate1', name: 'Plate 1', layerActions: [] }], edgeSel: null, toast: null,
  });
}

describe('one action, one undo step', () => {
  it('Clone… (copies + arrange) undoes in one step', () => {
    reset();
    addShape('box'); addShape('sphere');
    const before = S().objects;
    cloneObjects(3, [before[0].id]);
    expect(S().objects.length).toBe(5);
    S().undo();
    expect(S().objects).toBe(before);
  });
  it('Arrange all undoes in one step, also with a full undo history', () => {
    reset();
    addShape('box'); addShape('box');
    for (let i = 0; i < 60; i++) S().checkpoint();
    const before = S().objects;
    arrangeAll();
    expect(S().objects).not.toBe(before);
    S().undo();
    expect(S().objects).toBe(before);
  });
});

describe('undo / redo selection', () => {
  it('drops selected ids of objects that undo removed', () => {
    reset();
    addShape('box'); const a = S().objects[0].id;
    addShape('sphere'); const b = S().objects[1].id;
    S().set({ selected: [a, b] });
    S().undo();
    expect(S().selected).toEqual([a]);
    S().redo();
    expect(S().objects.map((o) => o.id)).toContain(b);
  });
});
