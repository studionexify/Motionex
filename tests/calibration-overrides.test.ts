// Starting a calibration must not carry the previous test's settings (e.g. the MVS vase's spiral mode) into the next one.
import { describe, expect, test } from 'vitest';
import { CALIBRATIONS, startCalibration } from '../src/state/calibration';
import { filamentById } from '../src/profiles/filaments';
import { printerById } from '../src/profiles/printers';
import { useStore } from '../src/state/store';

(globalThis as any).confirm = () => true;
const params = (id: string) => {
  const s = useStore.getState();
  return CALIBRATIONS.find((c) => c.id === id)!.params(filamentById(s.filaments[0].presetId), printerById(s.printerId).flavor);
};

describe('calibration overrides', () => {
  test('MVS then retraction: spiral mode is dropped, user overrides stay', () => {
    useStore.getState().set({ overrides: { ...useStore.getState().overrides, brim_width: 7 } });
    startCalibration('mvs', params('mvs'));
    expect(useStore.getState().overrides.spiral_mode).toBe(true);
    startCalibration('retraction', params('retraction'));
    const ov = useStore.getState().overrides;
    expect(ov.spiral_mode).toBeUndefined();
    expect(ov.brim_width).toBe(7);
    expect(ov.retraction_minimum_travel).toBe(1);
  });
});
