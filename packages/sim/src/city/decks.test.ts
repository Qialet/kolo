import { describe, expect, it } from 'vitest';
import { poseAlong } from '../geometry.js';
import { connectorY, DECK_CLEARANCE, inTunnel, laneY, nodeY, RAMP_GRADE, RAMP_GRADE_MAX, segmentY, TUNNEL_HIDE } from './decks.js';
import type { RoadEdge } from './district.js';
import { district } from './district.fixture.js';
import { buildCityFromDistrict } from './district-build.js';
import type { City } from './types.js';

const bridge: Partial<RoadEdge> = { layer: 1, bridge: true };

/** A street from west to east under a bridge from north to south whose decks begin `reach` metres each side of it. */
const overpass = (reach: number) =>
  buildCityFromDistrict(
    district(
      [
        [-250, 0, { boundary: true }],
        [250, 0, { boundary: true }],
        [0, -250, { boundary: true }],
        [0, -reach],
        [0, reach],
        [0, 250, { boundary: true }],
      ],
      [
        [0, 1],
        [2, 3],
        [3, 4, bridge],
        [4, 5],
      ],
    ),
  );

const decks = (city: City) => city.lanes.filter((l) => city.segments[l.seg]!.layer > 0);
const street = (city: City) => city.lanes.filter((l) => city.segments[l.seg]!.layer === 0 && Math.abs(l.start.z) < 3 && Math.abs(l.end.z) < 3);
/** Height of a deck lane where it passes over the street (x = 0 line crossing z = 0). */
const overStreet = (city: City) =>
  decks(city).map((l) => {
    let best = 0;
    let gap = Infinity;
    for (let s = 0; s <= l.length; s += 0.5) {
      const p = poseAlong(l.line, s);
      if (Math.abs(p.z) < gap) [gap, best] = [Math.abs(p.z), laneY(city, l.id, s)];
    }
    return best;
  });
const steepest = (city: City) => {
  let g = 0;
  for (const l of decks(city)) for (let s = 1; s <= l.length; s += 1) g = Math.max(g, Math.abs(laneY(city, l.id, s) - laneY(city, l.id, s - 1)));
  return g;
};

describe('bridge decks', () => {
  it('lifts a deck 6 m over the street, ramping from its ends at 8%', () => {
    const city = overpass(150);
    for (const y of overStreet(city)) expect(y).toBeCloseTo(6, 1);
    expect(steepest(city)).toBeLessThanOrEqual(RAMP_GRADE + 0.005);
    for (const l of street(city)) expect(laneY(city, l.id, l.length / 2)).toBe(0);
    for (const n of city.nodes) if (!n.boundary) expect(nodeY(city, n.id)).toBe(0);
  });

  it('ramps a short deck steeper to clear the street below', () => {
    const city = overpass(40);
    for (const y of overStreet(city)) expect(y).toBeGreaterThanOrEqual(DECK_CLEARANCE - 0.05);
    expect(steepest(city)).toBeLessThanOrEqual(RAMP_GRADE_MAX + 0.005);
  });

  it('keeps a deck at full height where the frame cuts it', () => {
    const city = buildCityFromDistrict(
      district(
        [
          [0, -250, { boundary: true }],
          [0, -150],
          [0, 250, { boundary: true }],
        ],
        [
          [0, 1],
          [1, 2, bridge],
        ],
      ),
    );
    const deck = city.segments.find((s) => s.layer === 1 && city.nodes[s.to]!.boundary)!;
    expect(segmentY(city, deck.id, deck.length)).toBeCloseTo(6, 1);
    expect(segmentY(city, deck.id, 0)).toBeCloseTo(0, 1);
  });

  it('stacks a second level 12 m up', () => {
    const city = buildCityFromDistrict(
      district(
        [
          [-250, 0, { boundary: true }],
          [250, 0, { boundary: true }],
          [0, -250, { boundary: true }],
          [0, 250, { boundary: true }],
        ],
        [
          [0, 1, bridge],
          [2, 3, { layer: 2, bridge: true }],
        ],
      ),
    );
    for (const s of city.segments) expect(segmentY(city, s.id, s.length / 2)).toBeCloseTo(s.layer * 6, 1);
  });

  it('leaves no step where a lane meets its connector', () => {
    const city = overpass(150);
    for (const c of city.connectors) {
      const from = city.lanes[c.from]!;
      expect(Math.abs(connectorY(city, c.id, 0) - laneY(city, c.from, from.length))).toBeLessThan(0.05);
      expect(Math.abs(connectorY(city, c.id, c.line.length) - laneY(city, c.to, 0))).toBeLessThan(0.05);
    }
  });
});

describe('tunnels', () => {
  const city = buildCityFromDistrict(
    district(
      [
        [-250, 0, { boundary: true }],
        [-100, 0],
        [100, 0],
        [250, 0, { boundary: true }],
      ],
      [
        [0, 1],
        [1, 2, { layer: -1, tunnel: true }],
        [2, 3],
      ],
    ),
  );

  it('keeps a tunnel at street height and hides what is inside, not at its portals', () => {
    const lane = city.lanes.find((l) => city.segments[l.seg]!.layer < 0)!;
    expect(laneY(city, lane.id, lane.length / 2)).toBe(0);
    expect(inTunnel(city, lane.id, lane.length / 2)).toBe(true);
    expect(inTunnel(city, lane.id, TUNNEL_HIDE - 0.5)).toBe(false);
    expect(inTunnel(city, lane.id, lane.length - TUNNEL_HIDE + 0.5)).toBe(false);
    const open = city.lanes.find((l) => city.segments[l.seg]!.layer === 0)!;
    expect(inTunnel(city, open.id, open.length / 2)).toBe(false);
  });
});
