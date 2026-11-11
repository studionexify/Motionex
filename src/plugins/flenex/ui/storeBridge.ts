// Thin bridge to the app store so the Flenex UI files stay readable.
import { useStore } from '../../../state/store';
import { PRINTERS } from '../../../profiles/printers';

export { useStore };
export function PRINTERS_VENDORS() {
  const vendors = Array.from(new Set(PRINTERS.map((p) => p.vendor)));
  return { vendors, byVendor: (v: string) => PRINTERS.filter((p) => p.vendor === v) };
}
