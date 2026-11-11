// Bambu / Orca machine G-code macro substitution, word for word.
import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../src/engine/placeholder';

const ctx = {
  vars: {
    initial_extruder: 1, nozzle_temperature: [215, 240], bed_temperature: [60, 70], layer_num: 3, layer_z: 0.8,
    total_layer_count: 120, filament_preset: ['Generic PLA', 'Generic PETG'], printer_model: 'Bambu Lab X1 Carbon',
  },
  ints: new Set(['initial_extruder', 'layer_num', 'total_layer_count', 'nozzle_temperature', 'bed_temperature']),
};

describe('machine G-code macros', () => {
  it('substitutes braces and brackets', () => {
    expect(renderTemplate('T{initial_extruder}', ctx)).toBe('T1');
    expect(renderTemplate('M104 S[nozzle_temperature]', ctx)).toBe('M104 S215');
    expect(renderTemplate('M140 S[bed_temperature]', ctx)).toBe('M140 S60');
    expect(renderTemplate('M109 S{nozzle_temperature[initial_extruder]}', ctx)).toBe('M109 S240');
    expect(renderTemplate(';L[layer_num]/[total_layer_count] Z[layer_z]', ctx)).toBe(';L3/120 Z0.8');
    expect(renderTemplate('; {filament_preset[0]} on [printer_model]', ctx)).toBe('; Generic PLA on Bambu Lab X1 Carbon');
  });
  it('evaluates {if} … {endif} blocks', () => {
    expect(renderTemplate('{if layer_num == 3}PAUSE{endif}', ctx)).toBe('PAUSE');
    expect(renderTemplate('{if layer_num > 3}A{else}B{endif}', ctx)).toBe('B');
    expect(renderTemplate('{if printer_model == "Bambu Lab X1 Carbon"}X1{endif}', ctx)).toBe('X1');
  });
});
