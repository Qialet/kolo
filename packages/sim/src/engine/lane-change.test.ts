import { describe, expect, it } from 'vitest';
import type { RoadEdge } from '../city/district.js';
import { district, segOf } from '../city/district.fixture.js';
import { buildCityFromDistrict } from '../city/district-build.js';
import type { City } from '../city/types.js';
import { dist } from '../geometry.js';
import { createRng } from '../rng.js';
import { makeVehicle, TrafficSystem, type Vehicle } from './traffic.js';

const two: Partial<RoadEdge> = { lanesFwd: 2, lanesBwd: 2 };
const res: Partial<RoadEdge> = { cls: 'residential' };
const W: [number, number] = [-100, 0];
const E: [number, number] = [100, 0];
const N: [number, number] = [0, -100];
const O: [number, number] = [0, 0];

/** A plus whose west–east street has two lanes each way; the north–south arms are one-lane residential streets. */
const boulevard = (): City =>
  buildCityFromDistrict(
    district(
      [[0, 0], [-100, 0, { boundary: true }], [100, 0, { boundary: true }], [0, -100, { boundary: true }], [0, 100, { boundary: true }]],
      [[1, 0, two], [0, 2, two], [3, 0, res], [0, 4, res]],
    ),
  );

/** A car on lane `index` of the west arm, `s` metres from its start, heading for the arm `to`. */
function car(traffic: TrafficSystem, city: City, id: string, index: number, s: number, to: [number, number], speed: number): Vehicle {
  const v = makeVehicle(id, 'CAR', createRng(id.length * 7));
  const lane = segOf(city, W, O).lanes[index]!;
  traffic.add(v);
  traffic.placeOnLane(v, lane, s);
  expect(traffic.planTo(v, { seg: segOf(city, O, to).id })).toBe(true);
  v.speed = speed;
  return v;
}

/** Every connector of the path leaves the lane of the step before it. */
function drivable(city: City, v: Vehicle): boolean {
  for (let i = v.pathIdx + 1; i < v.path.length; i++) {
    if (city.connectors[v.path[i]!.conn]!.from !== v.path[i - 1]!.lane) return false;
  }
  return true;
}

describe('changeLane', () => {
  it('moves a car to the next lane and keeps its path drivable', () => {
    const city = boulevard();
    const traffic = new TrafficSystem(city);
    const v = car(traffic, city, 'a', 1, 30, E, 8);
    const [inner, curb] = segOf(city, W, O).lanes;
    const before = { ...v.pose };
    expect(traffic.changeLane(v, inner!)).toBe(true);
    expect(v.lane).toBe(inner);
    expect(v.changeFrom).toBe(curb);
    expect(v.path[v.pathIdx]!.lane).toBe(inner);
    expect(drivable(city, v)).toBe(true);
    // No jump: the car is still where it was, shifted back towards its old lane.
    expect(dist(before, v.pose)).toBeLessThan(0.3);
    expect(v.lateral).toBeGreaterThan(2.5);
  });

  it('slides across smoothly and ends the manoeuvre on the new lane', () => {
    const city = boulevard();
    const traffic = new TrafficSystem(city);
    const v = car(traffic, city, 'a', 1, 20, E, 8);
    expect(traffic.changeLane(v, segOf(city, W, O).lanes[0]!)).toBe(true);
    let prev = { ...v.pose };
    for (let t = 0; t < 5; t += 0.05) {
      traffic.step(0.05);
      expect(dist(prev, v.pose)).toBeLessThan(v.speed * 0.05 + 0.15);
      prev = { ...v.pose };
    }
    expect(v.changeFrom).toBe(-1);
    expect(Math.abs(v.lateral)).toBeLessThan(0.01);
  });

  it('refuses on a one-lane street and when the rest of the path cannot be driven from the new lane', () => {
    const city = boulevard();
    const traffic = new TrafficSystem(city);
    // Turning left at the junction is only possible from the inner lane.
    const left = car(traffic, city, 'left', 0, 30, N, 8);
    expect(traffic.changeLane(left, segOf(city, W, O).lanes[1]!)).toBe(false);
    expect(left.lane).toBe(segOf(city, W, O).lanes[0]);
    const one = makeVehicle('one', 'CAR', createRng(3));
    const south = city.lanes[segOf(city, [0, 100], O).lanes[0]!]!;
    traffic.add(one);
    traffic.placeOnLane(one, south.id, 20);
    expect(traffic.planTo(one, { seg: segOf(city, O, N).id })).toBe(true);
    expect(traffic.changeLane(one, south.id)).toBe(false);
  });

  it('keeps a car in mid-manoeuvre in the way of followers on its old lane', () => {
    const city = boulevard();
    const traffic = new TrafficSystem(city);
    const ahead = car(traffic, city, 'ahead', 1, 50, E, 4);
    const behind = car(traffic, city, 'behind', 1, 38, E, 12);
    expect(traffic.changeLane(ahead, segOf(city, W, O).lanes[0]!)).toBe(true);
    traffic.step(0.05);
    expect(ahead.changeFrom).toBeGreaterThanOrEqual(0);
    expect(behind.acc).toBeLessThan(-1);
  });
});

/** A long west–east boulevard (lanes each way, 400 m arms) crossing one-lane streets at the origin, optionally under a light. */
const longBoulevard = (lanes = 2, signals = false): City =>
  buildCityFromDistrict(
    district(
      [[0, 0, signals ? { signals: true } : {}], [-400, 0, { boundary: true }], [400, 0, { boundary: true }], [0, -100, { boundary: true }], [0, 100, { boundary: true }]],
      [[1, 0, { lanesFwd: lanes, lanesBwd: lanes }], [0, 2, { lanesFwd: lanes, lanesBwd: lanes }], [3, 0, res], [0, 4, res]],
    ),
  );
const FAR_W: [number, number] = [-400, 0];
const FAR_E: [number, number] = [400, 0];
const S: [number, number] = [0, 100];

/** A vehicle on lane `index` of the segment from `a` to `b`, `s` metres in, heading for the arm `to`. */
function put(traffic: TrafficSystem, city: City, id: string, kind: 'CAR' | 'BUS', a: [number, number], b: [number, number], index: number, s: number, to: [number, number], speed: number): Vehicle {
  const v = makeVehicle(id, kind, createRng(id.length * 13 + id.charCodeAt(0)));
  traffic.add(v);
  traffic.placeOnLane(v, segOf(city, a, b).lanes[index]!, s);
  expect(traffic.planTo(v, { seg: segOf(city, b, to).id })).toBe(true);
  v.speed = speed;
  return v;
}

/** A bus standing in its lane, as at a stop without a bay. */
function standingBus(traffic: TrafficSystem, city: City, a: [number, number], b: [number, number], index: number, s: number): Vehicle {
  const bus = makeVehicle('standing', 'BUS', createRng(5));
  bus.pullOffset = 0;
  traffic.add(bus);
  traffic.placeOnLane(bus, segOf(city, a, b).lanes[index]!, s, true);
  return bus;
}

/** Steps the traffic, calling `each` after every step; returns the times at which `v` started a lane change. */
function drive(traffic: TrafficSystem, seconds: number, v: Vehicle | null, each?: (t: number) => void): number[] {
  const starts: number[] = [];
  let was = v?.changeFrom ?? -1;
  for (let t = 0; t < seconds; t += 0.05) {
    traffic.step(0.05);
    if (v && v.changeFrom >= 0 && was < 0) starts.push(t);
    was = v?.changeFrom ?? -1;
    each?.(t);
  }
  return starts;
}

describe('MOBIL lane changes', () => {
  it('overtakes a slow bus and does not swing back before the cool-down', () => {
    const city = longBoulevard();
    const traffic = new TrafficSystem(city);
    const bus = put(traffic, city, 'bus', 'BUS', FAR_W, O, 1, 60, FAR_E, 4);
    bus.drv.v0Factor = 0.3;
    const v = put(traffic, city, 'car', 'CAR', FAR_W, O, 1, 20, FAR_E, 12);
    const starts = drive(traffic, 15, v);
    expect(starts.length).toBeGreaterThan(0);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(6);
    // Past the bus: the car is further along the street than the front of the bus.
    expect(20 + v.odometer).toBeGreaterThan(60 + bus.odometer + 5);
  });

  it('drives round a bus standing in its lane', () => {
    const city = longBoulevard();
    const traffic = new TrafficSystem(city);
    standingBus(traffic, city, FAR_W, O, 1, 150);
    const v = put(traffic, city, 'car', 'CAR', FAR_W, O, 1, 20, FAR_E, 10);
    drive(traffic, 25, v);
    expect(20 + v.odometer).toBeGreaterThan(170);
  });

  it('steers round a standing bus from a standstill', () => {
    const city = longBoulevard();
    const traffic = new TrafficSystem(city);
    const bus = standingBus(traffic, city, FAR_W, O, 1, 150);
    const v = put(traffic, city, 'car', 'CAR', FAR_W, O, 1, 150 - bus.length - 2, FAR_E, 0);
    v.stoppedFor = 5;
    const starts = drive(traffic, 2, v);
    expect(starts.length).toBe(1);
  });

  it('waits behind a bus standing in the only lane', () => {
    const city = longBoulevard();
    const traffic = new TrafficSystem(city);
    const bus = standingBus(traffic, city, S, O, 0, 70);
    const v = put(traffic, city, 'car', 'CAR', S, O, 0, 10, N, 8);
    drive(traffic, 15, v);
    expect(v.lane).toBe(bus.lane);
    expect(v.s).toBeLessThan(bus.s - bus.length);
    expect(v.speed).toBeLessThan(0.5);
  });

  it('does not change lanes close to the stop line', () => {
    const city = longBoulevard();
    const traffic = new TrafficSystem(city);
    const len = city.lanes[segOf(city, FAR_W, O).lanes[1]!]!.length;
    standingBus(traffic, city, FAR_W, O, 1, len - 4);
    // 18 m before the line, its front 2 m behind the tail of the bus, standing long enough to steer round it.
    const v = put(traffic, city, 'car', 'CAR', FAR_W, O, 1, len - 18, FAR_E, 0);
    v.stoppedFor = 5;
    expect(drive(traffic, 3, v)).toEqual([]);
  });

  it('does not cut in front of a fast car on the next lane', () => {
    const city = longBoulevard();
    const traffic = new TrafficSystem(city);
    const bus = put(traffic, city, 'bus', 'BUS', FAR_W, O, 1, 70, FAR_E, 3);
    bus.drv.v0Factor = 0.2;
    const v = put(traffic, city, 'car', 'CAR', FAR_W, O, 1, 50, FAR_E, 4);
    // Selfish: only the safety rule keeps it from cutting in.
    v.drv.politeness = 0;
    const fast = put(traffic, city, 'fast', 'CAR', FAR_W, O, 0, 38, FAR_E, 14);
    let hardest = 0;
    drive(traffic, 4, v, () => {
      hardest = Math.min(hardest, fast.acc);
    });
    expect(hardest).toBeGreaterThan(-3);
  });

  it('keeps a taxi in the lane of its stop on that street', () => {
    const city = longBoulevard();
    const traffic = new TrafficSystem(city);
    const bus = put(traffic, city, 'bus', 'BUS', FAR_W, O, 1, 60, FAR_E, 3);
    bus.drv.v0Factor = 0.2;
    const curb = segOf(city, FAR_W, O).lanes[1]!;
    const taxi = makeVehicle('taxi', 'TAXI', createRng(9));
    traffic.add(taxi);
    traffic.placeOnLane(taxi, curb, 20);
    expect(traffic.planTo(taxi, { lane: curb, s: 300 })).toBe(true);
    taxi.speed = 12;
    expect(drive(traffic, 12, taxi)).toEqual([]);
  });

  it('never lets two cars take the same gap', () => {
    const city = longBoulevard(3);
    const traffic = new TrafficSystem(city);
    const middle = segOf(city, FAR_W, O).lanes[1]!;
    for (const i of [0, 2]) put(traffic, city, `slow${i}`, 'BUS', FAR_W, O, i, 70, FAR_E, 3).drv.v0Factor = 0.2;
    const a = put(traffic, city, 'a', 'CAR', FAR_W, O, 0, 30, FAR_E, 10);
    const b = put(traffic, city, 'b', 'CAR', FAR_W, O, 2, 30, FAR_E, 10);
    let together = 0;
    drive(traffic, 12, null, () => {
      if (a.lane === middle && b.lane === middle && Math.abs(a.s - b.s) < 5) together++;
    });
    expect(together).toBe(0);
    expect([a.lane, b.lane]).toContain(middle);
  });

  it('spreads a queue at a red light over both lanes', () => {
    const city = longBoulevard(2, true);
    const traffic = new TrafficSystem(city);
    const node = city.nodes.find((n) => n.signal)!;
    const sig = traffic.signals[node.id]!;
    sig.mode = 'HOLD';
    sig.holdPhase = segOf(city, N, O).phase;
    const cars = Array.from({ length: 8 }, (_, i) => put(traffic, city, `q${i}`, 'CAR', FAR_W, O, 1, 200 - i * 15, FAR_E, 10));
    drive(traffic, 45, null);
    const [inner, curb] = segOf(city, FAR_W, O).lanes;
    const onInner = cars.filter((c) => c.lane === inner).length;
    const onCurb = cars.filter((c) => c.lane === curb).length;
    expect(onInner + onCurb).toBe(8);
    expect(Math.abs(onInner - onCurb)).toBeLessThanOrEqual(2);
  });

  it('gets into the left-turn lane before the junction instead of shifting inside it', () => {
    // Two junctions on a two-lane boulevard; the car turns left at the second one.
    const A: [number, number] = [-60, 0];
    const B: [number, number] = [60, 0];
    const city = buildCityFromDistrict(
      district(
        [[-60, 0], [60, 0], [-400, 0, { boundary: true }], [400, 0, { boundary: true }], [-60, -100, { boundary: true }], [60, -100, { boundary: true }]],
        [[2, 0, two], [0, 1, two], [1, 3, two], [4, 0, res], [5, 1, res]],
      ),
    );
    const traffic = new TrafficSystem(city);
    const v = makeVehicle('turn', 'CAR', createRng(4));
    v.straightPreference = 1;
    traffic.add(v);
    traffic.placeOnLane(v, segOf(city, FAR_W, A).lanes[1]!, 60);
    expect(traffic.planTo(v, { seg: segOf(city, B, [60, -100]).id })).toBe(true);
    v.speed = 10;
    const nodeA = segOf(city, FAR_W, A).to;
    let used = -1;
    drive(traffic, 40, v, () => {
      if (used < 0 && v.mode === 'conn' && city.connectors[v.conn]!.node === nodeA) used = v.conn;
    });
    expect(used).toBeGreaterThanOrEqual(0);
    const c = city.connectors[used]!;
    expect(city.lanes[c.from]!.index).toBe(city.lanes[c.to]!.index);
  });
});
