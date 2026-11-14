import { describe, it } from 'vitest';
import { checkStand, STAND_IDS } from './stand-check';

describe('stands, ballast build', () => {
  it.each(STAND_IDS.map((id) => [id]))('%s: fits the shade, holds the holder, prints without support', (id) => checkStand(id, 'ballast'));
});
