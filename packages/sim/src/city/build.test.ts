import { describe, expect, it } from 'vitest';
import { buildCity } from './build.js';
import { routeSegments } from '../engine/routing.js';

const city = buildCity();

describe('buildCity', () => {
  it('is deterministic', () => {
    const again = buildCity();
    expect(again.buildings.length).toBe(city.buildings.length);
    expect(again.buildings[10]).toEqual(city.buildings[10]);
  });

  it('has a connected road network without dead-end lanes', () => {
    expect(city.nodes).toHaveLength(64);
    for (const lane of city.lanes) expect(lane.out.length, `lane ${lane.id}`).toBeGreaterThan(0);
    for (const seg of city.segments) {
      const route = routeSegments(city, 0, city.lanes[city.segments[0]!.lanes[0]!]!.index, seg.id);
      expect(route, `segment ${seg.id}`).not.toBeNull();
    }
  });

  it('signals every four-way junction and gives T-junctions a priority road', () => {
    for (const node of city.nodes) {
      if (node.out.length === 4) expect(node.signal).not.toBeNull();
      if (node.out.length === 3) expect(node.priority).not.toBeNull();
    }
  });

  it('places addresses on curb lanes of real streets', () => {
    expect(city.addresses.length).toBeGreaterThan(300);
    for (const a of city.addresses) {
      const lane = city.lanes[a.lane]!;
      expect(lane.index).toBe(lane.lanesInSeg - 1);
      expect(a.s).toBeGreaterThanOrEqual(0);
      expect(a.s).toBeLessThanOrEqual(lane.length);
      expect(a.label).toMatch(/\d/);
    }
  });

  it('builds three depots with slots and service boxes', () => {
    expect(city.depots.map((d) => d.id).sort()).toEqual(['P1', 'P2', 'P3']);
    for (const d of city.depots) {
      expect(d.slots.length).toBeGreaterThanOrEqual(10);
      expect(d.boxes.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('builds bus loops with stops on curb lanes', () => {
    expect(city.busLines).toHaveLength(3);
    for (const line of city.busLines) {
      expect(line.stops.length).toBeGreaterThan(3);
      const first = city.segments[line.segments[0]!]!;
      const last = city.segments[line.segments[line.segments.length - 1]!]!;
      expect(last.to).toBe(first.from);
    }
  });
});
