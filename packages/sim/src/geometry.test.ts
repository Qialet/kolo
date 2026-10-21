import { describe, expect, it } from 'vitest';
import { polyline, poseAlong } from './geometry.js';

describe('poseAlong', () => {
  const bend = polyline([
    { x: 0, z: 0 },
    { x: 10, z: 0 },
    { x: 10, z: 10 },
  ]);

  it('follows each piece of a bent polyline with the heading of that piece', () => {
    expect(poseAlong(bend, 5)).toMatchObject({ x: 5, z: 0 });
    expect(poseAlong(bend, 5).heading).toBeCloseTo(Math.PI / 2);
    expect(poseAlong(bend, 15)).toMatchObject({ x: 10, z: 5 });
    expect(poseAlong(bend, 15).heading).toBeCloseTo(0);
  });

  it('shifts to the right of the local direction', () => {
    const a = poseAlong(bend, 5, 1);
    expect(a.x).toBeCloseTo(5);
    expect(a.z).toBeCloseTo(1);
    const b = poseAlong(bend, 15, 1);
    expect(b.x).toBeCloseTo(9);
    expect(b.z).toBeCloseTo(5);
  });

  it('extrapolates straight past both ends', () => {
    const before = poseAlong(bend, -2);
    expect(before.x).toBeCloseTo(-2);
    expect(before.z).toBeCloseTo(0);
    const after = poseAlong(bend, 22);
    expect(after.x).toBeCloseTo(10);
    expect(after.z).toBeCloseTo(12);
  });
});
