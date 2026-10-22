import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeVehicle, TrafficSystem, type Vehicle } from '../engine/traffic.js';
import { poseAlong } from '../geometry.js';
import { segmentDistance } from '../import/polygons.js';
import { createRng } from '../rng.js';
import { buildTwins, twinPos } from './corridors.js';
import type { District } from './district.js';
import { buildCityFromDistrict } from './district-build.js';

const REAL = new URL('../../../../data/districts/belgrade-center.json', import.meta.url);
const city = buildCityFromDistrict(JSON.parse(readFileSync(REAL, 'utf8')) as District);
const isRail = (lane: number) => !!city.segments[city.lanes[lane]!.seg]!.rail;
const railTwins = city.lanes.filter((l) => isRail(l.id)).flatMap((l) => (l.twins ?? []).map((t) => ({ lane: l.id, t })));

/** A tram-like vehicle standing in its lane (no pull to the kerb), or a moving one. */
function vehicle(id: string, length: number): Vehicle {
  const v = makeVehicle(id, 'BUS', createRng(id.length));
  v.length = length;
  return v;
}

function standIn(traffic: TrafficSystem, v: Vehicle, lane: number, s: number) {
  v.pullOffset = 0;
  traffic.add(v);
  traffic.placeOnLane(v, lane, s, true);
}

function driveOn(traffic: TrafficSystem, v: Vehicle, lane: number, s: number, speed: number) {
  traffic.add(v);
  traffic.placeOnLane(v, lane, s);
  v.speed = speed;
}

describe('shared tram and street lanes', () => {
  it('pairs track and street lanes over kilometres, closely and the same way round', () => {
    const stats = buildTwins(city);
    expect(stats.sharedM).toBeGreaterThan(2000);
    let checked = 0;
    for (const { lane, t } of railTwins) {
      const rail = city.lanes[lane]!;
      const road = city.lanes[t.lane]!;
      for (let s = t.s0; s <= t.s1; s += 2) {
        const p = poseAlong(rail.line, s);
        const q = poseAlong(road.line, twinPos(t, s));
        let d = Infinity;
        for (let i = 1; i < road.line.points.length; i++) d = Math.min(d, segmentDistance(p, road.line.points[i - 1]!, road.line.points[i]!));
        expect(d).toBeLessThanOrEqual(2.21);
        expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeLessThan(3);
        expect(Math.cos(p.heading - q.heading)).toBeGreaterThan(Math.cos((30 * Math.PI) / 180));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
    // Each pair is stored on both lanes.
    for (const { lane, t } of railTwins) expect(city.lanes[t.lane]!.twins!.some((b) => b.lane === lane)).toBe(true);
  });

  it('has (almost) no stretch where a track runs against the traffic of the lane on it', () => {
    // 52 m on Pjarona de Mondezira by Kalemegdan (line 2): accepted as unmodelled by the user.
    expect(buildTwins(city).oppositeM).toBeLessThan(70);
  });

  const pair = railTwins.find(({ t }) => t.s1 - t.s0 >= 40 && Math.min(t.t0, t.t1) >= 30)!;

  it('stops a car behind a tram standing on the shared lane', () => {
    const traffic = new TrafficSystem(city);
    const { lane, t } = pair;
    const tram = vehicle('tram', 33);
    standIn(traffic, tram, lane, t.s0 + 38);
    const car = vehicle('car', 4.5);
    driveOn(traffic, car, t.lane, twinPos(t, t.s0 + 5) - 25, 8);
    for (let i = 0; i < 20 * 20; i++) traffic.step(0.05);
    expect(car.mode).toBe('lane');
    expect(car.s).toBeLessThanOrEqual(twinPos(t, tram.s - tram.length) + 0.01);
    expect(car.speed).toBeLessThan(0.5);
  });

  it('stops a tram behind a car standing on the shared lane', () => {
    const traffic = new TrafficSystem(city);
    const { lane, t } = pair;
    const back = city.lanes[t.lane]!.twins!.find((b) => b.lane === lane)!;
    const car = vehicle('car', 4.5);
    standIn(traffic, car, t.lane, twinPos(t, t.s0 + 38));
    const tram = vehicle('tram', 33);
    driveOn(traffic, tram, lane, t.s0 + 8, 6);
    for (let i = 0; i < 20 * 20; i++) traffic.step(0.05);
    expect(tram.s).toBeLessThanOrEqual(twinPos(back, car.s - car.length) + 0.01);
    expect(tram.speed).toBeLessThan(0.5);
  });

  it('keeps crossing traffic out while the tail of a long vehicle is still in the junction', () => {
    const railConn = (c: { from: number }) => isRail(c.from);
    let found: { c: (typeof city.connectors)[number]; k: (typeof city.connectors)[number] } | null = null;
    for (const c of city.connectors) {
      if (!railConn(c) || city.nodes[c.node]!.signal || city.lanes[c.to]!.length < 15) continue;
      for (const id of c.conflicts) {
        const k = city.connectors[id]!;
        if (!railConn(k) && city.lanes[k.from]!.length >= 30) found = { c, k };
      }
      if (found) break;
    }
    const { c, k } = found!;
    const traffic = new TrafficSystem(city);
    const tram = vehicle('tram', 33);
    standIn(traffic, tram, c.to, 10);
    tram.path = [
      { lane: c.from, conn: -1 },
      { lane: c.to, conn: c.id },
    ];
    tram.pathIdx = 1;
    const car = vehicle('car', 4.5);
    driveOn(traffic, car, k.from, city.lanes[k.from]!.length - 20, 0);
    car.path.push({ lane: k.to, conn: k.id });
    for (let i = 0; i < 15 * 20; i++) traffic.step(0.05);
    expect(car.lane).toBe(k.from);
    expect(car.mode).toBe('lane');
    traffic.remove(tram);
    for (let i = 0; i < 15 * 20; i++) traffic.step(0.05);
    expect(car.mode === 'conn' || car.lane === k.to).toBe(true);
  });
});
