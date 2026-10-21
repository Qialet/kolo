import { describe, expect, it } from 'vitest';
import { clipRing, joinRings, pointInPolygon, polygonCentroid, ringArea, simplifyRing } from './polygons.js';

const square = (x0: number, z0: number, s: number) => [
  { x: x0, z: z0 },
  { x: x0 + s, z: z0 },
  { x: x0 + s, z: z0 + s },
  { x: x0, z: z0 + s },
];

describe('polygons', () => {
  it('joins open way chains into closed rings, reversing pieces as needed', () => {
    const rings = joinRings([
      [1, 2, 3],
      [5, 4, 3],
      [5, 6, 1],
      [10, 11, 12, 10],
    ]);
    expect(rings).toHaveLength(2);
    const big = rings.find((r) => r.includes(1))!;
    expect(big).toHaveLength(6);
    expect(new Set(big)).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(rings.find((r) => r.includes(10))).toEqual([10, 11, 12]);
  });

  it('drops chains that never close', () => {
    expect(joinRings([[1, 2, 3], [3, 4]])).toEqual([]);
  });

  it('clips a ring to a rectangle', () => {
    const half = clipRing(square(0, 0, 100), { x0: -10, z0: -10, x1: 50, z1: 200 });
    expect(ringArea(half)).toBeCloseTo(5000, 6);
    expect(clipRing(square(0, 0, 10), { x0: 20, z0: 20, x1: 30, z1: 30 })).toEqual([]);
    expect(ringArea(clipRing(square(0, 0, 10), { x0: -5, z0: -5, x1: 50, z1: 50 }))).toBeCloseTo(100, 6);
  });

  it('simplifies collinear and near-collinear points away', () => {
    const ring = [{ x: 0, z: 0 }, { x: 5, z: 0.1 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }];
    expect(simplifyRing(ring, 0.3)).toHaveLength(4);
    expect(simplifyRing(ring, 0.05)).toHaveLength(5);
  });

  it('tests points against a polygon with a hole and finds the area centroid', () => {
    const outer = square(0, 0, 100);
    const hole = square(40, 40, 20);
    expect(pointInPolygon({ x: 10, z: 10 }, outer, [hole])).toBe(true);
    expect(pointInPolygon({ x: 50, z: 50 }, outer, [hole])).toBe(false);
    expect(pointInPolygon({ x: 150, z: 50 }, outer, [])).toBe(false);
    const c = polygonCentroid([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 1 }, { x: 1, z: 1 }, { x: 1, z: 10 }, { x: 0, z: 10 }]);
    expect(c.x).toBeCloseTo(c.z, 6);
    expect(c.x).toBeLessThan(5);
  });
});
