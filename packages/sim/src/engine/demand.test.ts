import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { District, DistrictTransit } from '../city/district.js';
import { buildCityFromDistrict } from '../city/district-build.js';
import { ringArea } from '../import/polygons.js';
import { stopPickup } from '../city/transit-places.js';
import { createRng } from '../rng.js';
import { addressWeights, cumulative, Demand, DUTY_SPOTS, hourWeights, MIN_ADDRESS_AREA, pickWeighted, stopCalls } from './demand.js';

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

describe('Demand', () => {
  /** Thursday 22 Oct 2026, 15:30 in Belgrade. */
  const AFTERNOON = Date.UTC(2026, 9, 22, 13, 30);
  const stops = city.busStops.filter((st) => stopPickup(city, st));
  const demand = new Demand(city, stops);

  it('draws pick-ups in the agreed shares, each by its weight', () => {
    const rng = createRng(1);
    const N = 200_000;
    const byKind = { stop: 0, poi: 0, address: 0 };
    const stopN = new Float64Array(stops.length);
    const poiN = new Float64Array(city.pois.length);
    const addrN = new Float64Array(city.addresses.length);
    for (let i = 0; i < N; i++) {
      const p = demand.origin(rng, AFTERNOON);
      byKind[p.kind]++;
      (p.kind === 'stop' ? stopN : p.kind === 'poi' ? poiN : addrN)[p.index]!++;
    }
    expect(Math.abs(byKind.stop / N - 0.4)).toBeLessThan(0.01);
    expect(Math.abs(byKind.poi / N - 0.3)).toBeLessThan(0.01);
    expect(Math.abs(byKind.address / N - 0.3)).toBeLessThan(0.01);

    const sw = demand.stopWeights(AFTERNOON);
    expect(pearson(stopN, sw)).toBeGreaterThan(0.95);
    const top10 = [...sw.keys()].sort((a, b) => sw[b]! - sw[a]!).slice(0, 10);
    const top10N = top10.reduce((s, i) => s + stopN[i]!, 0);
    expect(top10N / ((byKind.stop * 10) / stops.length)).toBeGreaterThan(2);

    const mean = (kind: string) => {
      const idx = city.pois.flatMap((p, i) => (p.kind === kind ? [i] : []));
      return idx.reduce((s, i) => s + poiN[i]!, 0) / idx.length;
    };
    expect(mean('mall')).toBeGreaterThan(2 * mean('hotel'));

    const aw = addressWeights(city);
    const order = [...aw.keys()].sort((a, b) => aw[a]! - aw[b]!);
    const total = aw.reduce((s, w) => s + w, 0);
    const shares: number[] = [];
    for (let d = 0; d < 10; d++) {
      const group = order.slice(Math.floor((d * order.length) / 10), Math.floor(((d + 1) * order.length) / 10));
      const expected = group.reduce((s, i) => s + aw[i]!, 0) / total;
      const observed = group.reduce((s, i) => s + addrN[i]!, 0) / byKind.address;
      expect(Math.abs(observed / expected - 1)).toBeLessThan(0.15);
      shares.push(observed);
    }
    expect(shares[9]!).toBeGreaterThan(2 * shares[0]!);
  });

  it('sends passengers to places of interest and addresses, never to stops', () => {
    const rng = createRng(2);
    const N = 100_000;
    let poi = 0;
    for (let i = 0; i < N; i++) {
      const p = demand.destination(rng);
      expect(p.kind).not.toBe('stop');
      if (p.kind === 'poi') poi++;
    }
    expect(Math.abs(poi / N - 0.25)).toBeLessThan(0.01);
  });

  it('keeps taxis on duty at the places with the most daily pick-ups', () => {
    const spots = demand.spots();
    expect(spots.length).toBe(DUTY_SPOTS);
    expect(new Set(spots.map((s) => s.id)).size).toBe(DUTY_SPOTS);
    // Daily pick-up probability of every stop and place of interest, recomputed from the timetable.
    const daily = new Float64Array(stops.length);
    for (const hours of stopCalls(city.transit, stops.map((s) => s.id)).values()) for (const h of hours) h.forEach((n, i) => (daily[i] = daily[i]! + n));
    const dailyTotal = daily.reduce((s, n) => s + n, 0);
    const poiTotal = city.pois.reduce((s, p) => s + p.weight, 0);
    const prob = (kind: string, index: number) => (kind === 'stop' ? (0.4 * daily[index]!) / dailyTotal : (0.3 * city.pois[index]!.weight) / poiTotal);
    const chosen = new Set(spots.map((s) => `${s.kind}:${s.index}`));
    const minChosen = Math.min(...spots.map((s) => prob(s.kind, s.index)));
    const others = [...stops.keys()].filter((i) => !chosen.has(`stop:${i}`)).map((i) => prob('stop', i));
    others.push(...[...city.pois.keys()].filter((i) => !chosen.has(`poi:${i}`)).map((i) => prob('poi', i)));
    expect(minChosen).toBeGreaterThanOrEqual(Math.max(...others));
    const topStop = [...daily.keys()].sort((a, b) => daily[b]! - daily[a]!)[0]!;
    expect(chosen.has(`stop:${topStop}`)).toBe(true);
  });

  it('caches at most two days of hourly stop weights', () => {
    const d = new Demand(city, stops);
    for (let h = 0; h < 72; h++) d.stopWeights(AFTERNOON + h * 3_600_000);
    expect(d.cachedHours).toBeLessThanOrEqual(48);
  });
});

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) (ma += a[i]!), (mb += b[i]!);
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i]! - ma) * (b[i]! - mb);
    va += (a[i]! - ma) ** 2;
    vb += (b[i]! - mb) ** 2;
  }
  return cov / Math.sqrt(va * vb);
}
