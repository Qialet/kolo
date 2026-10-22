import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cross, dist, endTangent, poseAlong } from '../geometry.js';
import type { District } from './district.js';
import { buildCityFromDistrict } from './district-build.js';

const REAL = new URL('../../../../data/districts/belgrade-center.json', import.meta.url);
const district = JSON.parse(readFileSync(REAL, 'utf8')) as District;
const city = buildCityFromDistrict(district);

describe('places on the real city', () => {
  it('binds addresses to curb lanes of the core network', () => {
    expect(city.addresses.length).toBeGreaterThan(4000);
    for (const a of city.addresses) {
      const lane = city.lanes[a.lane]!;
      const seg = city.segments[lane.seg]!;
      expect(seg.core, a.id).toBe(true);
      expect(seg.psvOnly).toBeFalsy();
      expect(lane.index).toBe(lane.lanesInSeg - 1);
      expect(a.s).toBeGreaterThanOrEqual(8 - 1e-9);
      expect(a.s).toBeLessThanOrEqual(lane.length - 8 + 1e-9);
      expect(Number.isFinite(a.x) && Number.isFinite(a.z)).toBe(true);
      const curb = poseAlong(lane.line, a.s);
      expect(dist(curb, a)).toBeLessThan(6);
      expect(city.addressById.get(a.id)).toBe(a);
    }
  });

  it('never puts a pick-up point in a tunnel or on a bridge deck', () => {
    for (const a of city.addresses) expect(city.segments[city.lanes[a.lane]!.seg]!.layer, a.label).toBe(0);
    for (const d of city.depots) expect(city.segments[city.lanes[d.curb.lane]!.seg]!.layer).toBe(0);
    const tunnels = city.segments.filter((s) => s.layer < 0);
    expect(tunnels.length).toBeGreaterThan(0);
    // Parked cars stay off the lanes of tunnels too.
    for (const car of city.parkedCars) {
      for (const s of tunnels) for (const l of s.lanes) for (const p of city.lanes[l]!.line.points) expect(dist(car, p)).toBeGreaterThan(4);
    }
  });

  it('keeps most addresses on their own street and on the house side', () => {
    const plain = city.addresses.filter((a) => !a.poi);
    const sameStreet = plain.filter((a) => a.label.startsWith(`${city.streets[a.street]!.name} `));
    expect(sameStreet.length / plain.length).toBeGreaterThan(0.85);
    // The entrance is to the right of the curb lane (right-hand traffic pulls over to the right).
    const right = city.addresses.filter((a) => {
      const lane = city.lanes[a.lane]!;
      const p = poseAlong(lane.line, a.s);
      return cross({ x: Math.sin(p.heading), z: Math.cos(p.heading) }, { x: a.x - p.x, z: a.z - p.z }) > 0;
    });
    expect(right.length).toBe(city.addresses.length);
  });

  it('turns real buildings and land cover into city objects', () => {
    expect(city.buildings.length).toBe(district.buildings.length + 6);
    for (const b of city.buildings) {
      expect(b.outline.length).toBeGreaterThanOrEqual(3);
      expect(b.h).toBeGreaterThan(0);
      if (b.addressId) expect(city.addressById.has(b.addressId)).toBe(true);
    }
    expect(city.buildings.filter((b) => b.addressId).length).toBeGreaterThan(3500);
    expect(city.areas.length).toBe(district.areas.length);
    expect(city.roads.length).toBeGreaterThan(500);
    expect(city.trees.length).toBeGreaterThan(district.trees.length / 2);
    expect(city.trees.length).toBeLessThanOrEqual(12_000);
    expect(city.playgrounds.length).toBe(district.areas.filter((a) => a.kind === 'playground').length);
    expect(city.parkedCars.length).toBeGreaterThan(300);
  });

  it('gives every place of interest a curb address of its own', () => {
    expect(city.pois.length).toBeGreaterThan(100);
    for (const p of city.pois) {
      const a = city.addressById.get(p.addressId)!;
      expect(a.poi).toBe(p.id);
      expect(a.label.startsWith(`${p.name}, `)).toBe(true);
    }
    expect(city.pois.map((p) => p.name)).toContain('Kalemegdan');
  });

  // Every parked car against every entrance: slow when the whole suite runs in parallel.
  it('keeps parked cars off buildings and away from entrances', { timeout: 180_000 }, () => {
    for (const car of city.parkedCars) {
      for (const a of city.addresses) expect(dist(car, a)).toBeGreaterThan(1.5);
    }
    // Lanes still end in the junction circles: a parked car never stands in a junction.
    for (const car of city.parkedCars.slice(0, 200)) {
      for (const n of city.nodes) if (!n.boundary && n.radius > 0) expect(dist(car, n)).toBeGreaterThan(n.radius * 0.5);
    }
    void endTangent;
  });
});
