import { describe, expect, it } from 'vitest';
import type { DistrictStop } from '../city/district.js';
import { markBusBays } from './bus-bays.js';
import type { OsmElement } from './osm-roads.js';
import { unproject } from './project.js';

/** A road along x from -100 to 100 m (eastbound in its point order) with the given tags. */
function road(tags: Record<string, string>): OsmElement[] {
  const a = unproject({ x: -100, z: 0 });
  const b = unproject({ x: 100, z: 0 });
  return [
    { type: 'node', id: 1, ...a },
    { type: 'node', id: 2, ...b },
    { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'primary', ...tags } },
  ];
}

const stop = (id: string, z: number, dir: [number, number]): DistrictStop => ({ id, code: id, name: id, x: 0, z, dir });
const eastbound = stop('E', 8, [1, 0]);
const westbound = stop('W', -8, [-1, 0]);

describe('markBusBays', () => {
  it('gives a right-hand bay to stops travelling along the way', () => {
    const stops = [eastbound, westbound].map((s) => ({ ...s }));
    markBusBays(road({ bus_bay: 'right' }), stops);
    expect(stops.map((s) => s.bay)).toEqual([true, undefined]);
  });

  it('gives a left-hand bay of a two-way road to the opposite direction', () => {
    const stops = [eastbound, westbound].map((s) => ({ ...s }));
    markBusBays(road({ bus_bay: 'left' }), stops);
    expect(stops.map((s) => s.bay)).toEqual([undefined, true]);
  });

  it('gives both directions a bay with bus_bay=both', () => {
    const stops = [eastbound, westbound].map((s) => ({ ...s }));
    markBusBays(road({ bus_bay: 'both' }), stops);
    expect(stops.map((s) => s.bay)).toEqual([true, true]);
  });

  it('ignores a left-hand bay of a one-way road: buses stop at the right kerb', () => {
    const stops = [{ ...eastbound }];
    markBusBays(road({ bus_bay: 'left', oneway: 'yes' }), stops);
    expect(stops[0]!.bay).toBeUndefined();
  });

  it('leaves stops further than 20 m from the way alone', () => {
    const stops = [stop('F', 24, [1, 0])];
    markBusBays(road({ bus_bay: 'right' }), stops);
    expect(stops[0]!.bay).toBeUndefined();
  });
});
