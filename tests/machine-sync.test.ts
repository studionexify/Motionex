// Machine changes under plugin designs: walls keep their line count, bed overflow is flagged, the user decides.
import { beforeEach, describe, expect, it } from 'vitest';
import { answerMachine, keepLines, machineChanged, registerMachineLink, useMachinePrompt, adaptWall, bedWarning, type MachineInfo } from '../src/state/machineSync';

const m = (nozzle: number, bed = 256): MachineInfo => ({ printerId: 'x', name: 'Test', nozzle, lineWidth: Math.round(nozzle * 105) / 100, bed: { x: bed, y: bed, z: bed } });

describe('machine sync', () => {
  beforeEach(() => useMachinePrompt.setState({ prompt: null }));
  it('keeps the number of wall lines across nozzles', () => {
    expect(keepLines(1.26, m(0.4), m(0.6))).toBeCloseTo(1.89);
    expect(keepLines(0.5, m(0.4), m(0.6))).toBeCloseTo(1.26); // never under two lines
    const ch: string[] = [];
    expect(adaptWall('Wall', 0.84, m(0.4), m(0.4), ch)).toBeNull();
    expect(ch).toEqual([]);
    expect(bedWarning('Lamp', [300, 100, 100], m(0.4, 256))).toMatch(/larger than/);
    expect(bedWarning('Lamp', [100, 250, 100], m(0.4, 256))).toBeNull();
  });
  it('asks when a design would change; adapt applies, both rebuild', () => {
    let wall = 1.26, rebuilt = 0;
    registerMachineLink({ id: 't', label: () => 'Test design', adapt: (a, b) => { const ch: string[] = []; const w = adaptWall('Wall', wall, a, b, ch); return { changes: ch, warnings: [], apply: () => { if (w !== null) wall = w; } }; }, refresh: () => { rebuilt++; } });
    machineChanged(m(0.4), m(0.6));
    expect(useMachinePrompt.getState().prompt?.items[0].changes[0]).toMatch(/Wall 1.26 mm → 1.89 mm/);
    answerMachine(true);
    expect(wall).toBeCloseTo(1.89);
    expect(rebuilt).toBe(1);
    machineChanged(m(0.6), m(0.4));
    answerMachine(false);
    expect(wall).toBeCloseTo(1.89);
    expect(rebuilt).toBe(2);
  });
});
