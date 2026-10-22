import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { District } from '../city/district.js';
import { buildCityFromDistrict } from '../city/district-build.js';
import type { Segment } from '../city/types.js';
import { routeSegments, turnBetween } from './routing.js';

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

describe('routeSegments from any lane', () => {
  const REAL = new URL('../../../../data/districts/belgrade-center.json', import.meta.url);
  const city = buildCityFromDistrict(JSON.parse(readFileSync(REAL, 'utf8')) as District);

  it('turns off an inner lane when the curb lane cannot make the turn', () => {
    let checked = 0;
    for (const seg of city.segments) {
      if (seg.lanes.length < 2) continue;
      const curb = city.lanes[seg.lanes[seg.lanes.length - 1]!]!;
      const turn = city.lanes[seg.lanes[0]!]!.out.map((c) => city.connectors[c]!).find((c) => c.turn === 'L');
      if (!turn) continue;
      const target = city.lanes[turn.to]!.seg;
      if (curb.out.some((c) => city.lanes[city.connectors[c]!.to]!.seg === target)) continue;
      expect(routeSegments(city, seg.id, -1, target, undefined, true)).toEqual([seg.id, target]);
      expect(routeSegments(city, seg.id, curb.index, target, undefined, true)).not.toEqual([seg.id, target]);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});
