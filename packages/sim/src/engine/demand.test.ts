import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { District, DistrictTransit } from '../city/district.js';
import { buildCityFromDistrict } from '../city/district-build.js';
import { ringArea } from '../import/polygons.js';
import { addressWeights, cumulative, hourWeights, MIN_ADDRESS_AREA, pickWeighted, stopCalls } from './demand.js';

const REAL = new URL('../../../../data/districts/belgrade-center.json', import.meta.url);
const city = buildCityFromDistrict(JSON.parse(readFileSync(REAL, 'utf8')) as District);

/** Belgrade wall time (CEST, UTC+2 until 25 Oct 2026) as epoch ms. */
const cest = (d: number, h: number, m = 0) => Date.UTC(2026, 9, d, h - 2, m);

/** Three stops, one pattern; trips leave A at 00:58:20, 01:00 and 25:00 (next calendar day) of the RD service. */
const transit: DistrictTransit = {
  feed: null,
  calendar: { week: ['RD', 'RD', 'RD', 'RD', 'RD', 'RD', 'RD'], extra: [['20270101', 'N']] },
  stops: ['A', 'B', 'C'].map((id) => ({ id, code: id, name: id, x: 0, z: 0, dir: [1, 0] as [number, number] })),
  lines: [{ id: 'L', name: '1', longName: '1', mode: 'bus', color: '#000000', text: '#ffffff' }],
  patterns: [
    {
      line: 0,
      dir: 0,
      headsign: 'C',
      stops: [0, 1, 2],
      shape: [],
      enter: false,
      exit: false,
      profiles: [{ t: [0, 0, 120, 180, 300, 300], starts: { RD: [3500, 100, 86_400] } }],
    },
  ],
};

describe('weighted picking', () => {
  it('picks the first index whose running sum passes u × total', () => {
    const cum = cumulative([1, 0, 3]);
    expect(pickWeighted(cum, 0)).toBe(0);
    expect(pickWeighted(cum, 0.2499)).toBe(0);
    expect(pickWeighted(cum, 0.25)).toBe(2);
    expect(pickWeighted(cum, 0.9999)).toBe(2);
    for (let u = 0; u < 1; u += 0.001) expect(pickWeighted(cum, u)).not.toBe(1);
  });

  it('returns -1 when every weight is zero', () => {
    expect(pickWeighted(cumulative([0, 0]), 0.5)).toBe(-1);
  });
});

describe('address weights', () => {
  const w = addressWeights(city);
  const byId = new Map(city.buildings.map((b) => [b.id, b]));

  it('gives every address at least the minimum, and exactly it without a building', () => {
    expect(w.length).toBe(city.addresses.length);
    expect(Math.min(...w)).toBeGreaterThanOrEqual(MIN_ADDRESS_AREA);
    const bare = city.addresses.findIndex((a) => !a.buildingId);
    expect(bare).toBeGreaterThanOrEqual(0);
    expect(w[bare]).toBe(MIN_ADDRESS_AREA);
  });

  it('splits the floor area of a building between its addresses', () => {
    const per = new Map<string, number[]>();
    city.addresses.forEach((a, i) => a.buildingId && per.set(a.buildingId, [...(per.get(a.buildingId) ?? []), i]));
    const floor = (id: string) => {
      const b = byId.get(id)!;
      return (ringArea(b.outline) - b.holes.reduce((s, h) => s + ringArea(h), 0)) * b.levels;
    };
    const [id, pair] = [...per].find(([id, list]) => list.length === 2 && floor(id) / 2 > MIN_ADDRESS_AREA)!;
    expect(w[pair[0]!]).toBe(w[pair[1]!]);
    expect(w[pair[0]!]! + w[pair[1]!]!).toBeCloseTo(floor(id), 0);
  });
});

describe('stop calls by service hour', () => {
  const calls = stopCalls(transit, ['A', 'B']);

  it('counts departures per stop in hour buckets of the service day, skipping other stops', () => {
    const rd = calls.get('RD')!;
    expect(rd.length).toBe(48);
    expect([...rd[0]!]).toEqual([1, 0]);
    expect([...rd[1]!]).toEqual([1, 2]);
    expect([...rd[25]!]).toEqual([1, 1]);
    expect(rd.reduce((s, h) => s + h[0]! + h[1]!, 0)).toBe(6);
  });

  it('adds yesterday’s trips past 24:00 to the current hour', () => {
    expect([...hourWeights(calls, transit.calendar, cest(22, 0, 30))]).toEqual([1, 0]);
    expect([...hourWeights(calls, transit.calendar, cest(22, 1, 30))]).toEqual([2, 3]);
  });

  it('falls back to the whole service day in an hour without trips', () => {
    expect([...hourWeights(calls, transit.calendar, cest(22, 10, 30))]).toEqual([3, 3]);
  });

  it('uses the holiday service', () => {
    expect([...hourWeights(calls, transit.calendar, Date.UTC(2027, 0, 1, 9, 30))]).toEqual([0, 0]);
  });

  it('clamps the hour on the clock-change day', () => {
    // 25 Oct 2026, 00:30 CEST: the service day starts at 01:00 local, an hour later.
    const w = hourWeights(calls, transit.calendar, Date.UTC(2026, 9, 24, 22, 30));
    expect([...w]).toEqual([1, 0]);
  });
});
