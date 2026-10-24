// Test-only helpers: small hand-made districts (excluded from the build).
import type { District, RoadEdge, RoadNode } from './district.js';
import type { City } from './types.js';

export function district(nodes: [number, number, Partial<RoadNode>?][], edges: [number, number, Partial<RoadEdge>?, [number, number][]?][], restrictions: District['roads']['restrictions'] = []): District {
  return {
    meta: {
      id: 't',
      name: 't',
      anchor: { lat: 0, lon: 0 },
      bboxDeg: { s: 0, w: 0, n: 0, e: 0 },
      bounds: { x0: -100, z0: -100, x1: 100, z1: 100 },
      osmTimestamp: '',
      gtfsVersion: null,
      version: 'x',
    },
    roads: {
      nodes: nodes.map(([x, z, extra], id) => ({ id, x, z, osm: id + 1, ...extra })),
      edges: edges.map(([a, b, extra, mid], id) => {
        const pa = nodes[a]!;
        const pb = nodes[b]!;
        const pts = [pa[0], pa[1], ...(mid ?? []).flat(), pb[0], pb[1]];
        return { id, a, b, pts, name: `E${id}`, cls: 'secondary', lanesFwd: 1, lanesBwd: 1, speed: 13.89, layer: 0, osm: 100 + id, ...extra };
      }),
      restrictions,
    },
    buildings: [],
    areas: [],
    trees: [],
    addresses: [],
    pois: [],
    depotSites: [],
    transit: { feed: null, calendar: { week: [], extra: [] }, stops: [], lines: [], patterns: [] },
  };
}

/** A plus-shaped junction at the origin with arms to the frame. */
export const plus = (restrictions: District['roads']['restrictions'] = []) =>
  district(
    [
      [0, 0],
      [-100, 0, { boundary: true }],
      [100, 0, { boundary: true }],
      [0, -100, { boundary: true }],
      [0, 100, { boundary: true }],
    ],
    [
      [1, 0],
      [0, 2],
      [3, 0],
      [0, 4],
    ],
    restrictions,
  );

export const segOf = (city: City, fromXZ: [number, number], toXZ: [number, number]) =>
  city.segments.find((s) => {
    const a = city.nodes[s.from]!;
    const b = city.nodes[s.to]!;
    return Math.hypot(a.x - fromXZ[0], a.z - fromXZ[1]) < 1 && Math.hypot(b.x - toXZ[0], b.z - toXZ[1]) < 1;
  })!;
