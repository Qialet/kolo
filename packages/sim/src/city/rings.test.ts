import { describe, expect, it } from 'vitest';
import { dist, type Vec2 } from '../geometry.js';
import { aroundIsland, findRings, pushOutOf, type RingPiece } from './rings.js';

/** A ring of `n` pieces round (0, 0), travelled the way atan2(z, x) grows (`turn` 1) or against it. */
function ring(radius: number, n: number, turn: 1 | -1, half = 3.2): RingPiece[] {
  const at = (i: number): Vec2 => {
    const a = (turn * 2 * Math.PI * i) / n;
    return { x: radius * Math.cos(a), z: radius * Math.sin(a) };
  };
  return Array.from({ length: n }, (_, i) => ({ a: i, b: (i + 1) % n, pts: [at(i), at(i + 0.5), at(i + 1)], half }));
}

describe('rings', () => {
  it('finds a closed ring with its centre, radius, turn and island inside the centre line', () => {
    for (const turn of [1, -1] as const) {
      const [r] = findRings(ring(30, 10, turn));
      expect(r!.turn).toBe(turn);
      expect(dist(r!.centre, { x: 0, z: 0 })).toBeLessThan(0.5);
      expect(r!.radius).toBeCloseTo(29.6, 0);
      expect(r!.mini).toBe(false);
      for (const q of r!.island) expect(Math.hypot(q.x, q.z)).toBeLessThan(28);
      for (const q of r!.outer) expect(Math.hypot(q.x, q.z)).toBeGreaterThan(31);
    }
  });

  it('ignores an open chain of ring pieces and marks a small ring as mini', () => {
    expect(findRings(ring(30, 10, 1).slice(0, 9))).toHaveLength(0);
    expect(findRings(ring(7, 5, 1))[0]!.mini).toBe(true);
  });

  it('moves outline points inside a kerb onto it and leaves the rest', () => {
    const [r] = findRings(ring(30, 10, 1));
    const out = pushOutOf([{ x: 0, z: 0 }, { x: 40, z: 0 }], r!.island);
    expect(Math.hypot(out[0]!.x, out[0]!.z)).toBeGreaterThan(25);
    expect(out[1]).toEqual({ x: 40, z: 0 });
  });

  it('leads a car round a small ring the way it turns, clear of the island', () => {
    const [r] = findRings(ring(7, 5, 1, 1.6));
    // In from the east heading west, out to the west heading west: half way round.
    const pts = aroundIsland(r!, { x: 12, z: 0 }, { x: -1, z: 0 }, { x: -12, z: 0 }, { x: -1, z: 0 })!;
    for (const q of pts) expect(Math.hypot(q.x, q.z)).toBeGreaterThan(5);
    // Turning the way atan2 grows from the east passes the south (z > 0) side.
    const mid = pts[Math.floor(pts.length / 2)]!;
    expect(mid.z).toBeGreaterThan(5);
  });

  it('leaves two ends close round the ring to the plain connector', () => {
    const [r] = findRings(ring(7, 5, 1, 1.6));
    expect(aroundIsland(r!, { x: 12, z: 0 }, { x: -1, z: 0 }, { x: 11, z: 3 }, { x: 1, z: 0.3 })).toBeNull();
  });
});
