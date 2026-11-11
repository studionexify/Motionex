// Filament holders: machine ↔ project slots, RFID vs hand-set trays, and the ask-each-time prompt.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore, type SceneObject } from '../src/state/store';
import { useDevices } from '../src/state/devices';
import { activeKey, adoptTrays, answerPrompt, mergeTrays, plan, pullFromMachine, pushToMachine, registerFilamentLink, setHolders, useHolders, type Holder } from '../src/state/holders';
import type { AmsSlot } from '../src/profiles/amsSync';
import { mmuTrays, spoolmanTray, taskConfigTrays } from '../src/connect/http';

const tray = (t: string, presetId: string, color: string, rfid = false): AmsSlot => ({ tray: t, presetId, color, trayType: presetId, matched: true, rfid });
const cube = (name: string, filament: number): SceneObject => ({ id: name, name, mesh: { vertices: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) }, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], openEdges: 0, filament });

beforeEach(() => {
  useDevices.setState({ devices: [{ id: 'd1', name: 'P1S', printerId: 'bbl-p1s', config: { kind: 'bbl_lan' } }], status: {}, selected: 'd1' });
  useStore.setState({ printerId: 'bbl-p1s', objects: [], filaments: [{ presetId: 'generic-pla', color: '#FF0000' }, { presetId: 'generic-pla', color: '#00FF00' }], mixes: [] });
  useHolders.setState({ lists: {}, linked: true, prompt: null });
});

describe('filament holders', () => {
  it('keys holders by saved device, else by printer model', () => {
    expect(activeKey()).toBe('d1');
    useStore.setState({ printerId: 'generic-ender3' });
    expect(activeKey()).toBe('model:generic-ender3');
  });

  it('project slots write to the machine, planned slots do not', () => {
    useStore.setState({ filaments: [{ presetId: 'generic-pla', color: '#FF0000' }, { presetId: 'generic-petg', color: '#123456', planned: true }] });
    pushToMachine();
    expect(useHolders.getState().lists.d1.map((h) => h.color)).toEqual(['#FF0000']);
  });

  it('RFID trays fill holders; hand-set holders keep the user value and show the reading', () => {
    const old: Holder[] = [{ presetId: 'generic-petg', color: '#111111', source: 'user', tray: 'A1' }, { presetId: 'generic-pla', color: '#222222', source: 'user', tray: 'A2' }];
    const m = mergeTrays(old, [tray('A1', 'generic-pla', '#FFFFFF'), tray('A2', 'generic-abs', '#000000', true)]);
    expect(m[0]).toMatchObject({ presetId: 'generic-petg', color: '#111111', source: 'user', reported: { color: '#FFFFFF' } });
    expect(m[1]).toMatchObject({ presetId: 'generic-abs', color: '#000000', source: 'rfid' });
    // Sync AMS (force) takes every tray as reported
    expect(mergeTrays(old, [tray('A1', 'generic-pla', '#FFFFFF')], true)[0]).toMatchObject({ color: '#FFFFFF', source: 'printer' });
  });

  it('applies machine changes silently when nothing uses the changed slot', () => {
    setHolders('d1', [{ presetId: 'generic-pla', color: '#FF0000', source: 'user' }, { presetId: 'generic-pla', color: '#0000FF', source: 'user' }]);
    expect(useHolders.getState().prompt).toBeNull();
    expect(useStore.getState().filaments[1].color).toBe('#0000FF');
  });

  it('asks when objects use a changed slot: follow recolours, keep moves the part to its filament', () => {
    useStore.setState({ objects: [cube('Vase', 1)] });
    let seen: number[] | null = null;
    registerFilamentLink({ id: 'test', label: () => 'Test design', slotsUsed: () => [1], remap: (m) => { seen = m; } });
    adoptTrays('d1', [tray('A1', 'generic-pla', '#00FF00'), tray('A2', 'generic-petg', '#FFFFFF')]);
    const p = useHolders.getState().prompt!;
    expect(p.affected).toEqual(expect.arrayContaining(['Vase', 'Test design']));
    answerPrompt('keep');
    const s = useStore.getState();
    // green moved to holder 1 (A1); the red that nothing uses is replaced
    expect(s.objects[0].filament).toBe(0);
    expect(s.filaments.map((f) => f.color)).toEqual(['#00FF00', '#FFFFFF']);
    expect(seen).toEqual([0, 0]); // old slot → new slot
  });

  it('keep adds a planned slot when no holder has the filament', () => {
    useStore.setState({ objects: [cube('Vase', 1)] });
    const holders: Holder[] = [{ presetId: 'generic-pla', color: '#FFFFFF', source: 'user' }];
    const r = plan(holders, 'keep');
    expect(r.next[r.map[1]]).toMatchObject({ color: '#00FF00', planned: true });
  });

  it('not now unlinks the project until relinked', () => {
    useStore.setState({ objects: [cube('Vase', 1)] });
    setHolders('d1', [{ presetId: 'generic-pla', color: '#FF0000', source: 'user' }, { presetId: 'generic-abs', color: '#000000', source: 'user' }]);
    answerPrompt('later');
    expect(useHolders.getState().linked).toBe(false);
    pullFromMachine();
    expect(useHolders.getState().prompt).toBeNull();
    expect(useStore.getState().filaments[1].color).toBe('#00FF00');
  });
});

describe('printer filament readers', () => {
  it('Happy Hare gates, Spoolman spools and U1 RFID heads', () => {
    expect(mmuTrays({ gate_material: ['PLA', 'PETG'], gate_color: ['ff0000', ''], gate_status: [1, 0], gate: 0 })![0].trays.map((t) => [t.type, t.color])).toEqual([['PLA', '#ff0000'], ['', '#FFFFFF']]);
    expect(spoolmanTray({ filament: { material: 'PETG', color_hex: '1E88E5' } })).toMatchObject({ type: 'PETG', color: '#1E88E5' });
    expect(spoolmanTray({})).toBeUndefined();
    const u1 = taskConfigTrays({ filament_type: ['PLA', 'PLA'], filament_color_rgba: ['FF0000FF', '00FF00FF'], filament_exist: [true, true], filament_official: [true, false] })!;
    expect(u1[0].trays.map((t) => t.rfid)).toEqual([true, false]);
  });
});
