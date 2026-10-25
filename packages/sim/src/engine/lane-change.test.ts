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
