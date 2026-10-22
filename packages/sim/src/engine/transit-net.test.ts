import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { District } from '../city/district.js';
import { buildCityFromDistrict } from '../city/district-build.js';
import { dist, type Vec2 } from '../geometry.js';
import { segmentDistance } from '../import/polygons.js';
import { chooseLanes, laneIndexesFor } from './routing.js';
import { buildTransitNet, patternPoint } from './transit-net.js';

const REAL = new URL('../../../../data/districts/belgrade-center.json', import.meta.url);
const district = JSON.parse(readFileSync(REAL, 'utf8')) as District;
const city = buildCityFromDistrict(district);
const t0 = performance.now();
const net = buildTransitNet(city, district.transit);
const buildMs = performance.now() - t0;
const stopIndex = new Map(city.busStops.map((s, i) => [s.id, i]));

const shapeOf = (flat: number[]): Vec2[] => Array.from({ length: flat.length / 2 }, (_, i) => ({ x: flat[2 * i]!, z: flat[2 * i + 1]! }));
const offShape = (p: Vec2, shape: Vec2[]) => {
  let best = Infinity;
  for (let i = 1; i < shape.length; i++) best = Math.min(best, segmentDistance(p, shape[i - 1]!, shape[i]!));
  return best;
};

describe('GTFS patterns over the road graph', () => {
  it('builds the network in well under two seconds', () => {
    expect(buildMs).toBeLessThan(1500);
  });

  it('routes nearly every pattern through all of its bound stops', () => {
    const candidates = district.transit.patterns
      .map((p, index) => ({ index, tram: district.transit.lines[p.line]!.mode === 'tram', bound: p.stops.filter((i) => stopIndex.has(district.transit.stops[i]!.id)).length }))
      .filter((c) => !c.tram && c.bound >= 2);
    const full = candidates.filter((c) => net.patterns.find((p) => p.index === c.index)?.stops.length === c.bound);
    // Stops on ramps and turning loops the road graph cannot drive through are skipped.
    expect(full.length / candidates.length).toBeGreaterThanOrEqual(0.9);
  });

  it('enters and leaves through the frame where the trips do', () => {
    const enter = net.patterns.filter((p) => district.transit.patterns[p.index]!.enter);
    const exit = net.patterns.filter((p) => district.transit.patterns[p.index]!.exit);
    expect(enter.filter((p) => p.entryLane >= 0).length / enter.length).toBeGreaterThanOrEqual(0.85);
    expect(exit.filter((p) => p.exitSeg >= 0).length / exit.length).toBeGreaterThanOrEqual(0.85);
    for (const p of enter) {
      if (p.entryLane < 0) continue;
      const lane = city.lanes[p.entryLane]!;
      expect(lane.seg).toBe(p.segs[0]);
      expect(city.nodes[city.segments[lane.seg]!.from]!.boundary).toBe(true);
    }
    for (const p of exit) if (p.exitSeg >= 0) expect(city.nodes[city.segments[p.exitSeg]!.to]!.boundary).toBe(true);
  });

  it('follows the GTFS shape', () => {
    let good = 0;
    let fair = 0;
    for (const p of net.patterns) {
      const shape = shapeOf(district.transit.patterns[p.index]!.shape);
      const from = p.entryLane >= 0 ? 0 : p.stops[0]!.at;
      const to = p.exitSeg >= 0 ? p.length : p.stops[p.stops.length - 1]!.at;
      let near = 0;
      let all = 0;
      for (let at = from; at <= to; at += 10) {
        all++;
        if (offShape(patternPoint(city, p, at), shape) < 30) near++;
      }
      if (all === 0 || near / all >= 0.9) good++;
      if (all === 0 || near / all >= 0.7) fair++;
    }
    // Terminal turning loops (Zeleni venac, Mostar, the railway station) are not in the road graph:
    // trips there take the nearest legal way round.
    expect(good / net.patterns.length).toBeGreaterThanOrEqual(0.65);
    expect(fair / net.patterns.length).toBeGreaterThanOrEqual(0.85);
  });

  it('keeps stops in travel order with their own timetable column', () => {
    for (const p of net.patterns) {
      const raw = district.transit.patterns[p.index]!;
      expect(city.busLines[p.line]!.id).toBe(district.transit.lines[raw.line]!.id);
      expect(p.profiles).toBe(raw.profiles);
      let prevAt = -Infinity;
      let prevIdx = -1;
      for (const st of p.stops) {
        expect(st.at, `${p.index}`).toBeGreaterThan(prevAt);
        expect(st.timeIdx).toBeGreaterThan(prevIdx);
        expect(district.transit.stops[raw.stops[st.timeIdx]!]!.id).toBe(city.busStops[st.stop]!.id);
        const stop = city.busStops[st.stop]!;
        expect(city.lanes[stop.lane]!.seg).toBe(p.segs[st.segIdx]);
        expect(st.s).toBe(stop.s);
        expect(dist(patternPoint(city, p, st.at), city.lanes[stop.lane]!.line.points[0]!)).toBeLessThanOrEqual(stop.s + 1);
        prevAt = st.at;
        prevIdx = st.timeIdx;
      }
      expect(p.length).toBeGreaterThanOrEqual(prevAt);
      expect(net.byLine.get(city.busLines[p.line]!.id)).toContain(p);
    }
  });

  it('leaves every stop on a lane that drives on to the next one', () => {
    for (const p of net.patterns) {
      const legs: { from: number; seg0: number; seg1: number; to: number }[] = [];
      if (p.entryLane >= 0) legs.push({ from: p.entryLane, seg0: 0, seg1: p.stops[0]!.segIdx, to: city.busStops[p.stops[0]!.stop]!.lane });
      p.stops.forEach((st, k) => {
        expect(city.lanes[st.departLane]!.seg).toBe(p.segs[st.segIdx]);
        const next = p.stops[k + 1];
        if (next) legs.push({ from: st.departLane, seg0: st.segIdx, seg1: next.segIdx, to: city.busStops[next.stop]!.lane });
        else if (p.exitSeg >= 0) legs.push({ from: st.departLane, seg0: st.segIdx, seg1: p.segs.length - 1, to: -1 });
      });
      for (const leg of legs) {
        if (leg.seg1 === leg.seg0) continue;
        const chain = p.segs.slice(leg.seg0, leg.seg1 + 1);
        expect(chooseLanes(city, chain, leg.from, leg.to, laneIndexesFor(city, chain, 0, 'any')), `${p.index}`).not.toBeNull();
      }
    }
  });

  it('leaves the timetable alone when a stop is skipped', () => {
    const skipped = net.patterns.find((p) => p.stops.some((st, k) => st.timeIdx !== k));
    expect(skipped).toBeDefined();
  });
});
