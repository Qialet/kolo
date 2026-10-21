import { describe, expect, it } from 'vitest';
import { buildCity } from './build.js';
import { routeSegments } from '../engine/routing.js';
import { SPECIAL_BLOCKS } from './layout.js';

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

  it('builds three depots whose yards fit the planned capacity', () => {
    expect(city.depots.map((d) => d.id).sort()).toEqual(['P1', 'P2', 'P3']);
    for (const spec of Object.values(SPECIAL_BLOCKS)) {
      if (spec.kind !== 'depot') continue;
      const d = city.depots.find((x) => x.id === spec.depotId)!;
      // The API stores slots.length as the park capacity, so the yard must not run out of room.
      expect(d.slots, d.id).toHaveLength(spec.capacity);
      expect(d.boxes, d.id).toHaveLength(spec.boxes);
    }
  });

  it('furnishes courtyards without overlapping houses', () => {
    const yardKinds = new Set(['shed', 'outbuilding']);
    const yardBuildings = city.buildings.filter((b) => yardKinds.has(b.kind));
    expect(yardBuildings.length).toBeGreaterThan(30);
    expect(city.playgrounds.length).toBeGreaterThan(20);
    expect(city.lawns.length).toBeGreaterThan(100);
    const rectOf = (o: { x: number; z: number; w: number; d: number }) => ({ x0: o.x - o.w / 2, x1: o.x + o.w / 2, z0: o.z - o.d / 2, z1: o.z + o.d / 2 });
    const overlap = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>) => a.x0 < b.x1 - 0.01 && b.x0 < a.x1 - 0.01 && a.z0 < b.z1 - 0.01 && b.z0 < a.z1 - 0.01;
    const solid = city.buildings.map(rectOf);
    for (const item of [...yardBuildings, ...city.playgrounds]) {
      const r = rectOf(item);
      const hits = city.buildings.filter((b) => b !== item && overlap(r, rectOf(b)));
      expect(hits, `courtyard item at ${item.x},${item.z}`).toHaveLength(0);
    }
    for (const t of city.trees) {
      const inside = solid.some((r) => t.x > r.x0 + 0.3 && t.x < r.x1 - 0.3 && t.z > r.z0 + 0.3 && t.z < r.z1 - 0.3);
      expect(inside, `tree at ${t.x},${t.z}`).toBe(false);
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
