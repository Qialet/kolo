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
    driveThrough(traffic, tram, [c], 10);
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

  it('holds every junction curve the body of a long tram still covers, not only the last one', () => {
    // Track curve c1 into a short track lane, then c2: a tram stopped just after c2 still reaches back into c1.
    let found: { c1: Conn; c2: Conn; k: Conn } | null = null;
    for (const c1 of city.connectors) {
      if (!isRail(c1.from) || city.lanes[c1.to]!.length > 12) continue;
      for (const c2 of city.connectors) {
        if (c2.from !== c1.to || city.lanes[c2.to]!.length < 20 || city.lanes[c1.to]!.length + c2.line.length > 15) continue;
        const k = c1.conflicts.map((id) => city.connectors[id]!).find((x) => !isRail(x.from) && city.lanes[x.from]!.length >= 30 && !c2.conflicts.includes(x.id));
        if (k) found = { c1, c2, k };
      }
      if (found) break;
    }
    const { c1, c2, k } = found!;
    const traffic = new TrafficSystem(city);
    // Unsignalised for the test: only the hold can keep the car out.
    traffic.signals[c1.node]!.mode = 'FLASHING';
    const tram = vehicle('tram', 33);
    driveThrough(traffic, tram, [c1, c2], 8);
    expect(tram.lane).toBe(c2.to);
    const car = vehicle('car', 4.5);
    driveOn(traffic, car, k.from, city.lanes[k.from]!.length - 20, 0);
    car.path.push({ lane: k.to, conn: k.id });
    for (let i = 0; i < 30 * 20; i++) traffic.step(0.05);
    expect(car.mode).toBe('lane');
    expect(car.lane).toBe(k.from);
  });

  it('makes a car turning across the tracks on the same green wait for an approaching tram', () => {
    // A tram going on and cars from the street alongside turning across its track, in one phase of a signal.
    let found: { c: Conn; k: Conn } | null = null;
    for (const c of city.connectors) {
      if (!isRail(c.from) || !city.nodes[c.node]!.signal || city.lanes[c.from]!.length < 40 || city.lanes[c.to]!.length < 40) continue;
      const along = (l: number) => city.segments[city.lanes[l]!.seg]!.dirOut;
      const same = (x: Conn) => along(x.from).x * along(c.from).x + along(x.from).z * along(c.from).z > 0.8;
      const k = c.conflicts.map((id) => city.connectors[id]!).find((x) => !isRail(x.from) && x.phase === c.phase && same(x) && city.lanes[x.from]!.length >= 20);
      if (k) found = { c, k };
      if (found) break;
    }
    const { c, k } = found!;
    const traffic = new TrafficSystem(city);
    traffic.signals[c.node]!.mode = 'HOLD';
    traffic.signals[c.node]!.holdPhase = c.phase;
    // A steady stream of turning cars, as on Kralja Aleksandra at node 144.
    for (let n = 0; n < 4; n++) {
      const car = vehicle(`car${n}`, 4.5);
      driveOn(traffic, car, k.from, city.lanes[k.from]!.length - 0.5 - n * 6.5, 0);
      car.path.push({ lane: k.to, conn: k.id });
    }
    const tram = vehicle('tram', 33);
    driveOn(traffic, tram, c.from, city.lanes[c.from]!.length - 40, 8);
    tram.path.push({ lane: c.to, conn: c.id });
    let slowest = Infinity;
    for (let i = 0; i < 12 * 20; i++) {
      traffic.step(0.05);
      if (tram.mode === 'lane' && tram.lane === c.from) slowest = Math.min(slowest, tram.speed);
    }
    // The tram keeps going; the car goes after its tail has cleared the curve.
    expect(slowest).toBeGreaterThan(4);
    expect(tram.lane).toBe(c.to);
  });

  it('does not keep a turning car waiting for a tram that stands at the line', () => {
    const along = (l: number) => city.segments[city.lanes[l]!.seg]!.dirOut;
    let found: { c: Conn; k: Conn } | null = null;
    for (const c of city.connectors) {
      if (!isRail(c.from) || !city.nodes[c.node]!.signal || city.lanes[c.from]!.length < 40 || city.lanes[c.to]!.length < 40) continue;
      const same = (x: Conn) => along(x.from).x * along(c.from).x + along(x.from).z * along(c.from).z > 0.8;
      const k = c.conflicts.map((id) => city.connectors[id]!).find((x) => !isRail(x.from) && x.phase === c.phase && same(x) && city.lanes[x.from]!.length >= 20);
      if (k) found = { c, k };
      if (found) break;
    }
    const { c, k } = found!;
    const traffic = new TrafficSystem(city);
    traffic.signals[c.node]!.mode = 'HOLD';
    traffic.signals[c.node]!.holdPhase = c.phase;
    // The tram's exit is blocked: it stands at its line and goes nowhere.
    const blocker = vehicle('blocker', 19);
    standIn(traffic, blocker, c.to, 20);
    const tram = vehicle('tram', 33);
    driveOn(traffic, tram, c.from, city.lanes[c.from]!.length - 0.5, 0);
    tram.path.push({ lane: c.to, conn: c.id });
    const car = vehicle('car', 4.5);
    driveOn(traffic, car, k.from, city.lanes[k.from]!.length - 0.5, 0);
    car.path.push({ lane: k.to, conn: k.id });
    for (let i = 0; i < 10 * 20; i++) traffic.step(0.05);
    expect(tram.lane).toBe(c.from);
    expect(car.mode === 'conn' || car.lane === k.to).toBe(true);
  });

  it('lets only one of two vehicles take crossing curves in the same step', () => {
    const c = city.connectors.find((x) => !isRail(x.from) && !city.nodes[x.node]!.signal && city.lanes[x.from]!.length >= 30 && x.conflicts.some((id) => !isRail(city.connectors[id]!.from) && city.connectors[id]!.from !== x.from && city.lanes[city.connectors[id]!.from]!.length >= 30))!;
    const k = city.connectors[c.conflicts.find((id) => !isRail(city.connectors[id]!.from) && city.connectors[id]!.from !== c.from && city.lanes[city.connectors[id]!.from]!.length >= 30)!]!;
    const traffic = new TrafficSystem(city);
    const a = vehicle('a', 4.5);
    const b = vehicle('b', 4.5);
    // Both at their stop lines and long past yielding (impatient drivers still check crossing paths).
    for (const [v, x] of [[a, c], [b, k]] as const) {
      driveOn(traffic, v, x.from, city.lanes[x.from]!.length - 0.5, 0);
      v.path.push({ lane: x.to, conn: x.id });
      v.stoppedFor = 60;
    }
    let both = 0;
    for (let i = 0; i < 4 * 20; i++) {
      traffic.step(0.05);
      const taking = (v: Vehicle, x: Conn) => (v.mode === 'conn' && v.conn === x.id) || v.committed === x.id;
      if (taking(a, c) && taking(b, k)) both++;
    }
    expect(both).toBe(0);
  });
});

type Conn = (typeof city.connectors)[number];

/** Drives a long vehicle through the given junction curves and stops it `stopAt` metres into the last exit lane. */
function driveThrough(traffic: TrafficSystem, v: Vehicle, conns: Conn[], stopAt: number) {
  v.pullOffset = 0;
  const first = city.lanes[conns[0]!.from]!;
  driveOn(traffic, v, first.id, Math.max(0, first.length - 6), 4);
  v.path.push(...conns.map((c) => ({ lane: c.to, conn: c.id })));
  const last = conns[conns.length - 1]!.to;
  v.stop = { lane: last, s: stopAt };
  for (let i = 0; i < 60 * 20 && v.mode !== 'pulled'; i++) traffic.step(0.05);
}
