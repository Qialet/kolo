import { describe, expect, it } from 'vitest';
import type { Segment } from '../city/types.js';
import { yieldsTo } from './priority.js';

/** An approach heading (dx, dz) into the junction: x east, z south. */
const approach = (id: number, dx: number, dz: number, priority = 2): Segment =>
  ({ id, priority, rank: priority, dirOut: { x: dx, z: dz } }) as Segment;

describe('yieldsTo', () => {
  const north = approach(1, 0, -1); // from the south, heading north
  const west = approach(2, -1, 0); // from the east, heading west
  const east = approach(3, 1, 0); // from the west, heading east
  const south = approach(4, 0, 1); // from the north, heading south

  it('yields to an equal approach coming from the right', () => {
    expect(yieldsTo(north, west)).toBe(true);
    expect(yieldsTo(west, north)).toBe(false);
    expect(yieldsTo(north, east)).toBe(false);
    expect(yieldsTo(east, north)).toBe(true);
  });

  it('does not make equal oncoming approaches yield to each other', () => {
    expect(yieldsTo(north, south)).toBe(false);
    expect(yieldsTo(south, north)).toBe(false);
  });

  it('yields to a higher priority from any side and never to a lower one', () => {
    const main = approach(5, 1, 0, 5);
    const side = approach(6, 0, -1, 2 - 50);
    expect(yieldsTo(side, main)).toBe(true);
    expect(yieldsTo(main, side)).toBe(false);
    expect(yieldsTo(north, approach(7, 0, 1, 3))).toBe(true);
    expect(yieldsTo(approach(8, -1, 0, 3), north)).toBe(false);
  });
});
