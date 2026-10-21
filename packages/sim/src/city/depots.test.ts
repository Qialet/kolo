import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dist, poseAlong, type Vec2 } from '../geometry.js';
import { pointInPolygon } from '../import/polygons.js';
import type { District } from './district.js';
import { buildCityFromDistrict } from './district-build.js';

const REAL = new URL('../../../../data/districts/belgrade-center.json', import.meta.url);
const district = JSON.parse(readFileSync(REAL, 'utf8')) as District;
const city = buildCityFromDistrict(district);
const ring = (flat: number[]): Vec2[] => Array.from({ length: flat.length / 2 }, (_, i) => ({ x: flat[2 * i]!, z: flat[2 * i + 1]! }));

describe('partner depots on real lots', () => {
  it('lays out P1–P3 with enough slots and the agreed service boxes', () => {
    expect(city.depots.map((d) => d.id)).toEqual(['P1', 'P2', 'P3']);
    const [p1, p2, p3] = city.depots;
    expect(p1!.slots.length).toBeGreaterThanOrEqual(24);
    expect(p2!.slots.length).toBeGreaterThanOrEqual(18);
    expect(p3!.slots.length).toBeGreaterThanOrEqual(18);
    expect(city.depots.map((d) => d.boxes.length)).toEqual([4, 3, 2]);
    expect(city.depots.map((d) => d.name)).toEqual(['Avala Fleet', 'Sava Motors', 'Dunav Taxi']);
  });

  it('opens the gate onto a core curb lane within 40 m by a driveway clear of buildings', () => {
    const osmBuildings = district.buildings.map((b) => ring(b.pts));
    for (const d of city.depots) {
      const lane = city.lanes[d.curb.lane]!;
      expect(city.segments[lane.seg]!.core).toBe(true);
      const curb = poseAlong(lane.line, d.curb.s);
      expect(dist(d.gate, curb)).toBeLessThanOrEqual(40);
      for (let i = 0; i <= 20; i++) {
        const q = { x: curb.x + ((d.gate.x - curb.x) * i) / 20, z: curb.z + ((d.gate.z - curb.z) * i) / 20 };
        expect(osmBuildings.some((b) => pointInPolygon(q, b, [])), `${d.id} driveway`).toBe(false);
      }
      expect(city.addressById.has(d.addressId)).toBe(true);
    }
  });

  it('keeps every slot and box inside the lot and outside real buildings', () => {
    const osmBuildings = district.buildings.map((b) => ring(b.pts));
    for (const d of city.depots) {
      for (const s of [...d.slots, ...d.boxes]) {
        expect(pointInPolygon(s, d.lot, []), `${d.id} slot`).toBe(true);
        expect(osmBuildings.some((b) => pointInPolygon(s, b, []))).toBe(false);
      }
      expect(pointInPolygon(d.yard, d.lot, [])).toBe(true);
      const garage = city.buildings.filter((b) => b.kind === 'garage' || b.kind === 'depot-office');
      expect(garage.length).toBe(6);
    }
  });
});
