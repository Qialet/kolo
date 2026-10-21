import { describe, expect, it } from 'vitest';
import type { Segment } from '../city/types.js';
import { turnBetween } from './routing.js';

const seg = (dirIn: { x: number; z: number }, dirOut = dirIn) => ({ dirIn, dirOut }) as Segment;
const deg = (a: number) => ({ x: Math.sin((a * Math.PI) / 180), z: Math.cos((a * Math.PI) / 180) });

describe('turnBetween', () => {
  // Heading 0° points south (+z); turning right while driving south means heading west (-x).
  const south = seg(deg(0));

  it('treats gentle bends as straight', () => {
    expect(turnBetween(south, seg(deg(30)))).toBe('S');
    expect(turnBetween(south, seg(deg(-30)))).toBe('S');
  });

  it('classifies sharp bends by side', () => {
    expect(turnBetween(south, seg(deg(-80)))).toBe('R');
    expect(turnBetween(south, seg(deg(80)))).toBe('L');
  });

  it('rejects U-turns', () => {
    expect(turnBetween(south, seg(deg(170)))).toBeNull();
  });

  it('compares the exit tangent of the first segment with the entry tangent of the second', () => {
    const curvesWest = seg(deg(0), deg(-90));
    expect(turnBetween(curvesWest, seg(deg(-90)))).toBe('S');
  });
});
