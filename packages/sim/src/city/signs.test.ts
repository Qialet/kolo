import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RoadEdge, RoadNode } from './district.js';
import { district, segOf } from './district.fixture.js';
import { buildCityFromDistrict } from './district-build.js';
import { SIGN_PENALTY } from './signs.js';
import type { City } from './types.js';

const REAL = new URL('../../../../data/districts/belgrade-center.json', import.meta.url);
const res: Partial<RoadEdge> = { cls: 'residential' };

/** A plus of residential streets with a sign node 15 m west of the centre. */
const signedPlus = (sign: Partial<RoadNode>) =>
  buildCityFromDistrict(
    district(
      [[0, 0], [-100, 0, { boundary: true }], [100, 0, { boundary: true }], [0, -100, { boundary: true }], [0, 100, { boundary: true }], [-15, 0, sign]],
      [[1, 5, res], [5, 0, res], [0, 2, res], [3, 0, res], [0, 4, res]],
    ),
  );

const approaches = (city: City) => city.segments.filter((s) => s.to === 0 && !s.rail);

describe('signs on small districts', () => {
  it('gives the approach a give way sign faces a lower priority', () => {
    const city = signedPlus({ giveWay: true, signDir: [1, 0] });
    const west = segOf(city, [-100, 0], [0, 0]);
    expect(west.control).toBe('giveWay');
    expect(west.priority).toBe(west.rank - SIGN_PENALTY);
    for (const s of approaches(city)) if (s !== west) expect(s.priority).toBe(s.rank);
    expect(city.signs.filter((g) => g.osm)).toEqual([{ kind: 'giveWay', seg: west.id, osm: true }]);
    expect(city.signs.filter((g) => !g.osm).map((g) => g.kind)).toEqual(['priority', 'priority', 'priority']);
  });

  it('drops a sign with no junction ahead of it', () => {
    const city = signedPlus({ giveWay: true, signDir: [-1, 0] });
    expect(city.segments.some((s) => s.control)).toBe(false);
    expect(city.signs).toEqual([]);
  });

  it('gives a sign without direction to the nearer junction along the road', () => {
    const city = buildCityFromDistrict(
      district(
        [[0, 0], [-40, 0], [-100, 0, { boundary: true }], [-40, -100, { boundary: true }], [100, 0, { boundary: true }], [0, 100, { boundary: true }], [-10, 0, { giveWay: true }]],
        [[2, 1, res], [1, 6, res], [6, 0, res], [3, 1, res], [0, 4, res], [0, 5, res]],
      ),
    );
    expect(segOf(city, [-40, 0], [0, 0]).control).toBe('giveWay');
    expect(segOf(city, [0, 0], [-40, 0]).control).toBeUndefined();
  });

  it('makes every approach of an all-way stop a stop of equal priority', () => {
    const city = signedPlus({ stop: true, stopAll: true, signDir: [1, 0] });
    const ins = approaches(city);
    expect(ins).toHaveLength(4);
    for (const s of ins) {
      expect(s.control).toBe('stop');
      expect(s.priority).toBe(-SIGN_PENALTY);
    }
    expect(city.signs.filter((g) => g.kind === 'stop')).toHaveLength(4);
    expect(city.signs.filter((g) => g.osm)).toHaveLength(1);
  });

  it('adds give way and priority road signs where the ranks decide', () => {
    const city = buildCityFromDistrict(
      district(
        [[0, 0], [-100, 0, { boundary: true }], [100, 0, { boundary: true }], [0, 100, { boundary: true }]],
        [[1, 0, { cls: 'tertiary' }], [0, 2, { cls: 'tertiary' }], [0, 3, res]],
      ),
    );
    const south = segOf(city, [0, 100], [0, 0]);
    expect(south.control).toBeUndefined();
    expect(city.signs).toContainEqual({ kind: 'giveWay', seg: south.id, osm: false });
    expect(city.signs).toContainEqual({ kind: 'priority', seg: segOf(city, [-100, 0], [0, 0]).id, osm: false });
    expect(city.signs).toContainEqual({ kind: 'priority', seg: segOf(city, [100, 0], [0, 0]).id, osm: false });
    expect(city.signs).toHaveLength(3);
  });

  it('puts no signs on a junction of equal streets', () => {
    const city = buildCityFromDistrict(
      district(
        [[0, 0], [-100, 0, { boundary: true }], [100, 0, { boundary: true }], [0, -100, { boundary: true }], [0, 100, { boundary: true }]],
        [[1, 0, res], [0, 2, res], [3, 0, res], [0, 4, res]],
      ),
    );
    expect(city.signs).toEqual([]);
    for (const s of city.segments) expect(s.priority).toBe(s.rank);
  });
});

describe('signs in Belgrade', () => {
  const city = buildCityFromDistrict(JSON.parse(readFileSync(REAL, 'utf8')));
  const osm = city.signs.filter((g) => g.osm);
  const derived = city.signs.filter((g) => !g.osm);

  it('binds nearly all OSM signs to the approach of a street junction', () => {
    // 30 of 33 bind (measured); the rest have no junction within reach.
    expect(osm.length).toBeGreaterThanOrEqual(30);
    for (const g of osm) {
      const node = city.nodes[city.segments[g.seg]!.to]!;
      expect(node.boundary).toBeFalsy();
      expect(node.in.length + node.out.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps signs off the tracks', () => {
    for (const s of city.segments) if (s.rail) expect(s.control).toBeUndefined();
    for (const g of city.signs) expect(city.segments[g.seg]!.rail).toBeFalsy();
  });

  it('puts give way signs at the entries of the Slavija ring', () => {
    const ring = city.segments.filter((s) => city.streets[s.street]!.name === 'Trg Slavija' && !s.rail);
    const ringNodes = new Set(ring.map((s) => s.to));
    const entries = city.segments.filter((s) => ringNodes.has(s.to) && !s.rail && s.rank < 10 && s.length >= 8);
    expect(entries.length).toBeGreaterThan(3);
    for (const e of entries) expect(city.signs.some((g) => g.seg === e.id && g.kind === 'giveWay')).toBe(true);
  });

  it('adds signs at the junctions the ranks decide', () => {
    // 271 measured: 107 give way, 161 priority road, 3 for the other arms of all-way stops.
    expect(derived.length).toBeGreaterThanOrEqual(260);
  });
});
