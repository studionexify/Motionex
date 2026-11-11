// User process presets (save → change → apply resolves identically) and AMS tray → filament slot mapping.
import { describe, expect, it, beforeEach } from 'vitest';
import { useStore } from '../src/state/store';
import { resolveConfig } from '../src/profiles/resolve';
import { applyUserPreset, deleteUserPreset, isActiveUserPresetModified, renameUserPreset, saveUserPreset, selectSystemPreset, updateUserPreset } from '../src/state/userPresets';
import { amsToSlots, closestFilament } from '../src/profiles/amsSync';
import { amsUnavailableReason, slotsFromAms, syncAmsFromPrinter } from '../src/state/amsSync';
import { useDevices } from '../src/state/devices';
import type { PrinterStatus } from '../src/connect/types';

const resolved = () => {
  const s = useStore.getState();
  return resolveConfig({ printerId: s.printerId, plate: s.plate, filamentId: s.filaments[0].presetId, presetId: s.presetId, overrides: s.overrides, machineOverrides: s.machineOverrides });
};

describe('user process presets', () => {
  beforeEach(() => useStore.setState({ userPresets: [], userPresetId: null, presetId: '0.20', overrides: {} }));

  it('save → change → apply resolves to the same config', () => {
    const s = useStore.getState();
    s.set({ presetId: '0.12' });
    s.setOverride('wall_loops', 4);
    s.setOverride('sparse_infill_density', '35%');
    const before = resolved();
    const p = saveUserPreset('Strong fine')!;
    expect(p).toBeTruthy();
    expect(isActiveUserPresetModified()).toBe(false);
    selectSystemPreset('0.28');
    useStore.getState().setOverride('wall_loops', 2);
    useStore.getState().setOverride('top_shell_layers', 9);
    expect(resolved()).not.toEqual(before);
    applyUserPreset(p.id);
    expect(resolved()).toEqual(before);
    expect(useStore.getState().userPresetId).toBe(p.id);
  });

  it('detects modification, updates, renames, deletes; rejects duplicate names', () => {
    const p = saveUserPreset('A')!;
    expect(saveUserPreset('a')).toBeNull();
    useStore.getState().setOverride('wall_loops', 5);
    expect(isActiveUserPresetModified()).toBe(true);
    updateUserPreset(p.id);
    expect(isActiveUserPresetModified()).toBe(false);
    expect(useStore.getState().userPresets[0].overrides.wall_loops).toBe(5);
    renameUserPreset(p.id, 'B');
    expect(useStore.getState().userPresets[0].name).toBe('B');
    deleteUserPreset(p.id);
    expect(useStore.getState().userPresets).toEqual([]);
    expect(useStore.getState().userPresetId).toBeNull();
  });

  it('stored overrides are copies, not shared with the live settings', () => {
    useStore.getState().setOverride('wall_loops', 3);
    const p = saveUserPreset('C')!;
    useStore.getState().setOverride('wall_loops', 7);
    expect(useStore.getState().userPresets.find((x) => x.id === p.id)!.overrides.wall_loops).toBe(3);
  });
});

const fakeStatus: PrinterStatus = {
  state: 'idle',
  ams: [
    { id: '0', trays: [
      { id: '0', type: 'PLA', color: '#ff0000' },
      { id: '1', type: '', color: '' }, // empty tray
      { id: '2', type: 'PETG HF', color: '#00FF00' },
      { id: '3', type: 'PLA Matte', color: '#112233' },
    ] },
    { id: '1', trays: [{ id: '0', type: 'PA-CF', color: 'zz' }, { id: '1', type: 'TPU', color: '#000000' }] },
  ],
};

describe('AMS sync', () => {
  it('maps tray types to the closest filament preset', () => {
    expect(closestFilament('PLA').id).toBe('generic-pla');
    expect(closestFilament('PLA Matte').id).toBe('generic-pla-matte');
    expect(closestFilament('PETG-HF').id).toBe('generic-petg');
    expect(closestFilament('ABS').id).toBe('generic-abs');
    expect(closestFilament('asa').id).toBe('generic-asa');
    expect(closestFilament('TPU-AMS').id).toBe('generic-tpu');
    expect(closestFilament('PA-CF')).toEqual({ id: 'generic-pla', matched: false });
  });

  it('turns loaded trays into slots in AMS order', () => {
    const slots = amsToSlots(fakeStatus.ams);
    expect(slots.map((s) => [s.tray, s.presetId, s.color])).toEqual([
      ['A1', 'generic-pla', '#FF0000'],
      ['A3', 'generic-petg', '#00FF00'],
      ['A4', 'generic-pla-matte', '#112233'],
      ['B1', 'generic-pla', '#5DBE7A'],
      ['B2', 'generic-tpu', '#000000'],
    ]);
    expect(slots[3].matched).toBe(false);
    const merged = slotsFromAms(slots, [{ presetId: 'generic-pla', color: '#fff', overrides: { nozzle_temperature: 210 } }, { presetId: 'generic-abs', color: '#fff' }]);
    expect(merged[0].overrides).toEqual({ nozzle_temperature: 210 });
    expect(merged[1]).toEqual({ presetId: 'generic-petg', color: '#00FF00' });
  });

  it('syncs the store from a connected device, or explains why not', () => {
    useDevices.setState({ devices: [{ id: 'd1', name: 'P1S', printerId: 'bbl-p1s', config: { kind: 'bbl_lan' } }], status: {}, selected: 'd1' });
    expect(amsUnavailableReason()).toMatch(/Connect a printer/);
    expect(syncAmsFromPrinter()).toBe(false);
    useDevices.setState({ status: { d1: { state: 'idle' } } });
    expect(amsUnavailableReason()).toMatch(/no AMS/);
    useStore.setState({ filaments: [{ presetId: 'generic-pla', color: '#fff' }], slice: { ...useStore.getState().slice, dirty: false } });
    useDevices.setState({ status: { d1: fakeStatus } });
    expect(amsUnavailableReason()).toBeNull();
    expect(syncAmsFromPrinter()).toBe(true);
    const s = useStore.getState();
    expect(s.filaments.length).toBe(5);
    expect(s.slice.dirty).toBe(true);
    expect(s.toast?.text).toMatch(/Synced 5 filament slots from P1S/);
  });
});
