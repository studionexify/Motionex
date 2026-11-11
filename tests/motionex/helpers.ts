import { MACHINES, FILAMENTS, PROCESSES, type PrintProfiles } from "../../src/plugins/motionex/core/profiles";
export const profiles = (machine = "voron-24-350", process = "std-020"): PrintProfiles => ({
  machine: MACHINES.find((m) => m.id === machine)!, filament: FILAMENTS[0], process: PROCESSES.find((p) => p.id === process)!,
});
