import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isTransitKind } from '@kolo/contracts';
import { dist, dot, poseAlong } from '../geometry.js';
import { createRng } from '../rng.js';
import { makeVehicle } from '../engine/traffic.js';
import type { District } from './district.js';
import { buildCityFromDistrict } from './district-build.js';

const REAL = new URL('../../../../data/districts/belgrade-center.json', import.meta.url);
const district = JSON.parse(readFileSync(REAL, 'utf8')) as District;
const city = buildCityFromDistrict(district);
const { transit } = district;
const byId = new Map(city.busStops.map((s) => [s.id, s]));

describe('GTFS stops on curb lanes', () => {
  it('binds nearly every stop that a pattern serves', () => {
    const served = new Set(transit.patterns.flatMap((p) => p.stops.map((i) => transit.stops[i]!.id)));
    const bound = [...served].filter((id) => byId.has(id));
    expect(bound.length / served.size).toBeGreaterThanOrEqual(0.9);
  });

  it('puts every stop on a street-level curb lane running its way, within 30 m', () => {
    for (const raw of transit.stops) {
      const stop = byId.get(raw.id);
      if (!stop) continue;
      const lane = city.lanes[stop.lane]!;
      const seg = city.segments[lane.seg]!;
      expect(lane.index, raw.id).toBe(lane.lanesInSeg - 1);
      expect(seg.layer, raw.id).toBe(0);
      expect(stop.s).toBeGreaterThanOrEqual(10);
      expect(stop.s).toBeLessThanOrEqual(lane.length - 4);
      const p = poseAlong(lane.line, stop.s);
      const along = dot({ x: Math.sin(p.heading), z: Math.cos(p.heading) }, { x: raw.dir[0], z: raw.dir[1] }) / Math.hypot(raw.dir[0], raw.dir[1]);
      expect(along, raw.id).toBeGreaterThanOrEqual(Math.cos(Math.PI / 3) - 0.02);
      // Clamping s may slide the point a little along the lane.
      expect(dist(raw, p), raw.id).toBeLessThanOrEqual(30 + 10);
      expect(dist(stop, p)).toBeLessThan(5);
      expect(stop.name).toBe(raw.name);
      expect(stop.code).toBe(raw.code);
    }
  });

  it('keeps the two platforms of one stop on different lanes', () => {
    let pairs = 0;
    for (const a of transit.stops) {
      for (const b of transit.stops) {
        if (a.id >= b.id || a.name !== b.name || dist(a, b) > 120 || a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] > -0.5) continue;
        const sa = byId.get(a.id);
        const sb = byId.get(b.id);
        if (!sa || !sb) continue;
        pairs++;
        expect(sa.lane, `${a.name} ${a.id}/${b.id}`).not.toBe(sb.lane);
      }
    }
    expect(pairs).toBeGreaterThan(10);
  });

  it('lists the lines of every stop and marks trolley wires', () => {
    expect(city.busLines.map((l) => l.id)).toEqual(transit.lines.map((l) => l.id));
    const lineIds = new Set(city.busLines.map((l) => l.id));
    for (const stop of city.busStops) {
      expect(stop.lines.length, stop.id).toBeGreaterThan(0);
      for (const id of stop.lines) expect(lineIds.has(id)).toBe(true);
    }
    expect(city.busLines.find((l) => l.mode === 'trolley')).toBeDefined();
    expect(city.segments.filter((s) => s.trolley).length).toBeGreaterThan(50);
    expect(city.transit).toBe(transit);
  });

  it('sizes trolleybuses and minibuses', () => {
    const rng = createRng(1);
    expect(makeVehicle('a', 'TROLLEY', rng).length).toBe(12);
    expect(makeVehicle('b', 'MINIBUS', rng).length).toBe(7.5);
    expect(['BUS', 'TROLLEY', 'MINIBUS'].every((k) => isTransitKind(k as never))).toBe(true);
    expect(isTransitKind('TAXI')).toBe(false);
  });
});
