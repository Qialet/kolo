import { describe, expect, it } from 'vitest';
import type { RoadEdge, RoadNode } from '../city/district.js';
import { district, segOf } from '../city/district.fixture.js';
import { buildCityFromDistrict } from '../city/district-build.js';
import type { City } from '../city/types.js';
import { createRng } from '../rng.js';
import { cycleOf } from './signals.js';
import { makeVehicle, TrafficSystem, type Vehicle } from './traffic.js';

const res: Partial<RoadEdge> = { cls: 'residential' };
const W: [number, number] = [-100, 0];
const E: [number, number] = [100, 0];
const N: [number, number] = [0, -100];
const S: [number, number] = [0, 100];

/** A plus of one-lane residential streets, optionally with a sign node 15 m west of the centre. */
const plusCity = (sign?: Partial<RoadNode>) =>
  buildCityFromDistrict(
    district(
      [[0, 0], [-100, 0, { boundary: true }], [100, 0, { boundary: true }], [0, -100, { boundary: true }], [0, 100, { boundary: true }], ...(sign ? [[-15, 0, sign] as [number, number, Partial<RoadNode>]] : [])],
      sign ? [[1, 5, res], [5, 0, res], [0, 2, res], [3, 0, res], [0, 4, res]] : [[1, 0, res], [0, 2, res], [3, 0, res], [0, 4, res]],
    ),
  );

interface Watch {
  v: Vehicle;
  /** Time the vehicle entered the junction. */
  entered: number;
  /** Lowest speed on the approach lane. */
  minSpeed: number;
  /** Time standing (under 0.3 m/s) within 4 m of the stop line. */
  atLine: number;
}

/** A car `back` metres before the stop line of the approach from `from`, heading for the arm `to`. */
function car(traffic: TrafficSystem, city: City, id: string, from: [number, number], to: [number, number], back: number, speed: number): Watch {
  const v = makeVehicle(id, 'CAR', createRng(7));
  const lane = city.lanes[segOf(city, from, [0, 0]).lanes[0]!]!;
  traffic.add(v);
  traffic.placeOnLane(v, lane.id, lane.length - back);
  expect(traffic.planTo(v, { seg: segOf(city, [0, 0], to).id })).toBe(true);
  v.speed = speed;
  return { v, entered: Infinity, minSpeed: speed, atLine: 0 };
}

function run(traffic: TrafficSystem, city: City, cars: Watch[], seconds: number) {
  const dt = 0.05;
  for (let t = 0; t < seconds; t += dt) {
    traffic.step(dt);
    for (const w of cars) {
      if (w.entered < Infinity) continue;
      if (w.v.mode === 'conn') {
        w.entered = t;
        continue;
      }
      w.minSpeed = Math.min(w.minSpeed, w.v.speed);
      if (w.v.speed < 0.3 && city.lanes[w.v.lane]!.length - w.v.s < 4) w.atLine += dt;
    }
  }
}

describe('right of way at unsignalised junctions', () => {
  it('lets the car from the right go first on equal streets', () => {
    const city = plusCity();
    const traffic = new TrafficSystem(city);
    const fromSouth = car(traffic, city, 'a', S, N, 28, 8);
    const fromEast = car(traffic, city, 'b', E, W, 30, 8);
    run(traffic, city, [fromSouth, fromEast], 30);
    expect(fromEast.entered).toBeLessThan(fromSouth.entered);
    expect(fromSouth.entered).toBeLessThan(30);
  });

  it('lets oncoming cars on equal streets pass without stopping', () => {
    const city = plusCity();
    const traffic = new TrafficSystem(city);
    const cars = [car(traffic, city, 'a', W, E, 30, 8), car(traffic, city, 'b', E, W, 30, 8)];
    run(traffic, city, cars, 20);
    for (const w of cars) {
      expect(w.entered).toBeLessThan(20);
      expect(w.minSpeed).toBeGreaterThan(3);
    }
  });

  it('clears four cars arriving at once on equal streets within a minute', () => {
    const city = plusCity();
    const traffic = new TrafficSystem(city);
    const cars = [car(traffic, city, 'a', W, E, 30, 8), car(traffic, city, 'b', E, W, 30, 8), car(traffic, city, 'c', N, S, 30, 8), car(traffic, city, 'd', S, N, 30, 8)];
    run(traffic, city, cars, 60);
    for (const w of cars) expect(w.entered).toBeLessThan(60);
  });

  it('makes a car stop in full at a stop sign even with nobody around', () => {
    const city = plusCity({ stop: true, signDir: [1, 0] });
    const traffic = new TrafficSystem(city);
    const w = car(traffic, city, 'a', W, E, 30, 8);
    run(traffic, city, [w], 30);
    expect(w.entered).toBeLessThan(30);
    expect(w.minSpeed).toBeLessThan(0.3);
    expect(w.atLine).toBeGreaterThanOrEqual(1);
  });

  it('lets a car through a give way sign without stopping when the junction is empty', () => {
    const city = plusCity({ giveWay: true, signDir: [1, 0] });
    const traffic = new TrafficSystem(city);
    const w = car(traffic, city, 'a', W, E, 30, 8);
    run(traffic, city, [w], 20);
    expect(w.entered).toBeLessThan(20);
    expect(w.minSpeed).toBeGreaterThan(1);
  });

  it('makes every car of a queue stop at the stop sign itself', () => {
    const city = plusCity({ stop: true, signDir: [1, 0] });
    const traffic = new TrafficSystem(city);
    const cars = [car(traffic, city, 'a', W, E, 3, 0), car(traffic, city, 'b', W, E, 11, 0), car(traffic, city, 'c', W, E, 19, 0)];
    run(traffic, city, cars, 60);
    for (const w of cars) {
      expect(w.entered).toBeLessThan(60);
      expect(w.atLine).toBeGreaterThanOrEqual(1);
    }
  });

  it('holds a car at a give way sign for a car coming on the main road', () => {
    const city = plusCity({ giveWay: true, signDir: [1, 0] });
    const traffic = new TrafficSystem(city);
    const minor = car(traffic, city, 'a', W, E, 3, 0);
    const main = car(traffic, city, 'b', S, N, 25, 8);
    run(traffic, city, [minor, main], 30);
    expect(main.entered).toBeLessThan(minor.entered);
    expect(minor.entered).toBeLessThan(30);
  });

  it('still lets a tram coming from the left cross first', () => {
    const tram = { cls: 'tram', lanesFwd: 1, lanesBwd: 0, psvOnly: true, name: '', speed: 11.11 } as const;
    const city = buildCityFromDistrict(
      district(
        [[0, 0], [-100, 0, { boundary: true }], [100, 0, { boundary: true }], [0, -100, { boundary: true }], [0, 100, { boundary: true }]],
        [[1, 0, res], [0, 2, res], [3, 0, tram], [0, 4, tram]],
      ),
    );
    const traffic = new TrafficSystem(city);
    const eastbound = car(traffic, city, 'a', W, E, 3, 0);
    const t = makeVehicle('t', 'TRAM', createRng(3));
    const lane = city.lanes[segOf(city, N, [0, 0]).lanes[0]!]!;
    traffic.add(t);
    traffic.placeOnLane(t, lane.id, lane.length - 25);
    expect(traffic.planTo(t, { seg: segOf(city, [0, 0], S).id })).toBe(true);
    t.speed = 8;
    const tramWatch: Watch = { v: t, entered: Infinity, minSpeed: 8, atLine: 0 };
    run(traffic, city, [eastbound, tramWatch], 30);
    expect(tramWatch.entered).toBeLessThan(eastbound.entered);
  });
});

describe('buses at stops', () => {
  /** A bus 10 m into the west arm with its stop 70 m in, and a car right behind it, both heading east. */
  function approach(pullOffset: number) {
    const city = plusCity();
    const traffic = new TrafficSystem(city);
    const lane = segOf(city, W, [0, 0]).lanes[0]!;
    const bus = makeVehicle('bus', 'BUS', createRng(3));
    bus.pullOffset = pullOffset;
    traffic.add(bus);
    traffic.placeOnLane(bus, lane, 22);
    expect(traffic.planTo(bus, { lane, s: 70 })).toBe(true);
    bus.speed = 8;
    const car = makeVehicle('car', 'CAR', createRng(4));
    traffic.add(car);
    traffic.placeOnLane(car, lane, 6);
    expect(traffic.planTo(car, { seg: segOf(city, [0, 0], E).id })).toBe(true);
    car.speed = 8;
    let pulledAt = -1;
    let maxStep = 0;
    let carStood = 0;
    for (let t = 0; t < 40; t += 0.05) {
      const lateral = bus.lateral;
      traffic.step(0.05);
      maxStep = Math.max(maxStep, Math.abs(bus.lateral - lateral));
      if (bus.mode === 'pulled' && pulledAt < 0) pulledAt = bus.lateral;
      // Only behind the bus: at the end of its path the car stops for good.
      if (car.mode === 'lane' && car.lane === lane) carStood = Math.max(carStood, car.stoppedFor);
    }
    return { bus, car, pulledAt, maxStep, carStood };
  }

  it('drift into a bay on the way in and let the car behind go by', () => {
    const { bus, car, pulledAt, maxStep, carStood } = approach(3.1);
    expect(bus.mode).toBe('pulled');
    expect(bus.lateral).toBeCloseTo(3.1, 5);
    // Already well into the bay when it stops: the body slid over the last metres, not in place.
    expect(pulledAt).toBeGreaterThan(1.5);
    expect(maxStep).toBeLessThan(0.3);
    expect(carStood).toBeLessThan(3);
    expect(car.lane === bus.lane ? car.s - car.length > bus.s : true).toBe(true);
  });

  it('stand in the lane without a bay: the car behind waits on a one-lane street', () => {
    const { bus, car, maxStep, carStood } = approach(0);
    expect(bus.mode).toBe('pulled');
    expect(bus.lateral).toBe(0);
    expect(maxStep).toBe(0);
    expect(car.lane).toBe(bus.lane);
    expect(car.s).toBeLessThan(bus.s - bus.length);
    expect(carStood).toBeGreaterThan(10);
  });
});

describe('waitLimit', () => {
  /** West arm into an unsignalised T at (-100, 0), then on to a light at the origin. */
  const chain = () =>
    buildCityFromDistrict(
      district(
        [[0, 0, { signals: true }], [-100, 0], [-200, 0, { boundary: true }], [-100, -100, { boundary: true }], [100, 0, { boundary: true }], [0, -100, { boundary: true }]],
        [[2, 1], [1, 0], [3, 1, res], [0, 4], [5, 0]],
      ),
    );

  it('waits for a light ahead when a queue from it holds the junction', () => {
    const city = chain();
    const traffic = new TrafficSystem(city);
    const light = city.nodes.find((n) => n.signal)!;
    const into = segOf(city, [-100, 0], [0, 0]).lanes[0]!;
    const from = city.lanes[segOf(city, [-200, 0], [-100, 0]).lanes[0]!]!;
    const v = makeVehicle('held', 'CAR', createRng(1));
    traffic.add(v);
    traffic.placeOnLane(v, from.id, from.length - 1);
    expect(traffic.planTo(v, { seg: segOf(city, [0, 0], E).id })).toBe(true);
    traffic.step(0.05);
    expect(traffic.waitLimit(v)).toBe(120);
    const queue = makeVehicle('queue', 'CAR', createRng(2));
    traffic.add(queue);
    traffic.placeOnLane(queue, into, 6);
    traffic.step(0.05);
    expect(v.mode).toBe('lane');
    expect(traffic.waitLimit(v)).toBe(Math.max(120, cycleOf(traffic.signals[light.id]!.plan) + 90));
  });
});
