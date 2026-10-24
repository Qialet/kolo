import { describe, expect, it } from 'vitest';
import type { RoadEdge, RoadNode } from '../city/district.js';
import { district, segOf } from '../city/district.fixture.js';
import { buildCityFromDistrict } from '../city/district-build.js';
import type { City } from '../city/types.js';
import { createRng } from '../rng.js';
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
