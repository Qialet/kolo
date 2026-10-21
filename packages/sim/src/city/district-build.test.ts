import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeVehicle, TrafficSystem } from '../engine/traffic.js';
import { createRng } from '../rng.js';
import type { District, RoadEdge, RoadNode } from './district.js';
import { buildCityFromDistrict } from './district-build.js';
import type { City } from './types.js';

const REAL = new URL('../../../../data/districts/belgrade-center.json', import.meta.url);

function district(nodes: [number, number, Partial<RoadNode>?][], edges: [number, number, Partial<RoadEdge>?, [number, number][]?][], restrictions: District['roads']['restrictions'] = []): District {
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
  };
}

/** A plus-shaped junction at the origin with arms to the frame. */
const plus = (restrictions: District['roads']['restrictions'] = []) =>
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

const segOf = (city: City, fromXZ: [number, number], toXZ: [number, number]) =>
  city.segments.find((s) => {
    const a = city.nodes[s.from]!;
    const b = city.nodes[s.to]!;
    return Math.hypot(a.x - fromXZ[0], a.z - fromXZ[1]) < 1 && Math.hypot(b.x - toXZ[0], b.z - toXZ[1]) < 1;
  })!;

describe('buildCityFromDistrict on small districts', () => {
  it('drives on the right: an eastbound lane lies south of the centre line', () => {
    const city = buildCityFromDistrict(plus());
    const east = segOf(city, [-100, 0], [0, 0]);
    const lane = city.lanes[east.lanes[0]!]!;
    expect(lane.start.z).toBeCloseTo(1.6, 1);
    expect(lane.end.x).toBeLessThan(-3);
    expect(lane.end.x).toBeGreaterThan(-15);
  });

  it('connects every approach to every other arm except a U-turn', () => {
    const city = buildCityFromDistrict(plus());
    const centre = city.nodes.find((n) => n.in.length === 4)!;
    const turns = city.connectors.filter((c) => c.node === centre.id).map((c) => c.turn);
    expect(turns.filter((t) => t === 'S')).toHaveLength(4);
    expect(turns.filter((t) => t === 'L')).toHaveLength(4);
    expect(turns.filter((t) => t === 'R')).toHaveLength(4);
  });

  it('puts opposite approaches of a signalled crossing into one phase', () => {
    const d = plus();
    d.roads.nodes[0]!.signals = true;
    const city = buildCityFromDistrict(d);
    const centre = city.nodes.find((n) => n.in.length === 4)!;
    expect(centre.signal!.phases).toHaveLength(2);
    const phaseOf = (from: [number, number]) => segOf(city, from, [0, 0]).phase;
    expect(phaseOf([-100, 0])).toBe(phaseOf([100, 0]));
    expect(phaseOf([0, -100])).toBe(phaseOf([0, 100]));
    expect(phaseOf([-100, 0])).not.toBe(phaseOf([0, -100]));
  });

  it('honours turn restrictions', () => {
    // Edge 0 runs west→centre, edge 2 runs north→centre (from (0,-100)).
    const city = buildCityFromDistrict(plus([{ from: 0, via: 0, to: 2, only: false }]));
    const fromWest = segOf(city, [-100, 0], [0, 0]);
    const toNorth = segOf(city, [0, 0], [0, -100]);
    const banned = city.connectors.filter((c) => city.lanes[c.from]!.seg === fromWest.id && city.lanes[c.to]!.seg === toNorth.id);
    expect(banned).toHaveLength(0);
    const onlyStraight = buildCityFromDistrict(plus([{ from: 0, via: 0, to: 1, only: true }]));
    const w = segOf(onlyStraight, [-100, 0], [0, 0]);
    const outs = onlyStraight.connectors.filter((c) => onlyStraight.lanes[c.from]!.seg === w.id);
    expect(new Set(outs.map((c) => c.turn))).toEqual(new Set(['S']));
  });

  it('merges the nodes of a dual carriageway crossing into one junction', () => {
    // Two one-way carriageways 12 m apart (x = -6 southbound, x = 6 northbound) crossing a two-way street.
    const city = buildCityFromDistrict(
      district(
        [
          [-6, 0],
          [6, 0],
          [-100, 0, { boundary: true }],
          [100, 0, { boundary: true }],
          [-6, -100, { boundary: true }],
          [-6, 100, { boundary: true }],
          [6, -100, { boundary: true }],
          [6, 100, { boundary: true }],
        ],
        [
          [2, 0],
          [0, 1],
          [1, 3],
          [4, 0, { lanesBwd: 0, lanesFwd: 2 }],
          [0, 5, { lanesBwd: 0, lanesFwd: 2 }],
          [7, 1, { lanesBwd: 0, lanesFwd: 2 }],
          [1, 6, { lanesBwd: 0, lanesFwd: 2 }],
        ],
      ),
    );
    const junctions = city.nodes.filter((n) => n.in.length >= 3);
    expect(junctions).toHaveLength(1);
    expect(junctions[0]!.x).toBeCloseTo(0, 0);
  });

  it('folds pass-through nodes of the same road into one segment', () => {
    const city = buildCityFromDistrict(
      district(
        [
          [-100, 0, { boundary: true }],
          [0, 0],
          [100, 0, { boundary: true }],
        ],
        [
          [0, 1],
          [1, 2],
        ],
      ),
    );
    expect(city.segments).toHaveLength(2);
    expect(city.lanes[city.segments[0]!.lanes[0]!]!.length).toBeGreaterThan(190);
  });
});

describe('buildCityFromDistrict on Belgrade', () => {
  const real = JSON.parse(readFileSync(REAL, 'utf8')) as District;
  const city = buildCityFromDistrict(real);

  it('has finite geometry and usable lanes', () => {
    expect(city.lanes.length).toBeGreaterThan(1500);
    for (const lane of city.lanes) {
      expect(lane.length).toBeGreaterThan(2);
      for (const p of lane.line.points) expect(Number.isFinite(p.x) && Number.isFinite(p.z)).toBe(true);
    }
    for (const c of city.connectors) expect(c.line.length).toBeLessThan(120);
  });

  it('gives every approach a way on unless it is a dead end or leaves the map', () => {
    let missing = 0;
    for (const lane of city.lanes) {
      const end = city.nodes[city.segments[lane.seg]!.to]!;
      if (end.out.length === 0 || lane.out.length > 0) continue;
      const onlyBack = end.out.every((s) => city.segments[s]!.reverse === lane.seg);
      if (!onlyBack) missing++;
    }
    expect(missing).toBe(0);
  });

  it('keeps nearly all segments mutually reachable', () => {
    expect(largestSegmentScc(city) / city.segments.length).toBeGreaterThan(0.95);
  });

  it('gives the Slavija ring right of way over its entries', () => {
    const ring = city.segments.filter((s) => city.streets[s.street]!.name === 'Trg Slavija');
    expect(ring.length).toBeGreaterThan(3);
    for (const s of ring) {
      const node = city.nodes[s.to]!;
      for (const other of node.in) {
        const o = city.segments[other]!;
        if (city.streets[o.street]!.name !== 'Trg Slavija') expect(o.rank).toBeLessThan(s.rank);
      }
    }
  });

  it('signals the junctions OSM marks with traffic lights, with a phase for every approach', () => {
    const signalled = city.nodes.filter((n) => n.signal);
    expect(signalled.length).toBeGreaterThanOrEqual(100);
    expect(signalled.length).toBeLessThanOrEqual(220);
    for (const node of signalled) {
      const phases = node.signal!.phases.length;
      expect(phases).toBeGreaterThanOrEqual(2);
      for (const s of node.in) expect(city.segments[s]!.phase).toBeLessThan(phases);
      for (const p of node.signal!.phases) expect([30, 45]).toContain(p.green);
      // Every phase has at least one approach.
      for (let i = 0; i < phases; i++) expect(node.in.some((s) => city.segments[s]!.phase === i)).toBe(true);
    }
    for (const c of city.connectors) expect(c.phase).toBe(city.segments[city.lanes[c.from]!.seg]!.phase);
  });

  it('keeps most of the network in the core that never needs the outside world', () => {
    const core = city.segments.filter((s) => s.core);
    expect(core.length / city.segments.length).toBeGreaterThan(0.75);
    expect(core.some((s) => city.nodes[s.from]!.boundary || city.nodes[s.to]!.boundary)).toBe(false);
  });

  it('plans curb-to-curb routes between core lanes', () => {
    const traffic = new TrafficSystem(city);
    const rng = createRng(7);
    const curbs = city.segments.filter((s) => s.core && !s.psvOnly).map((s) => city.lanes[s.lanes[s.lanes.length - 1]!]!);
    let ok = 0;
    for (let i = 0; i < 100; i++) {
      const v = makeVehicle(`C${i}`, 'CAR', rng);
      const from = curbs[rng.int(0, curbs.length - 1)]!;
      const to = curbs[rng.int(0, curbs.length - 1)]!;
      traffic.placeOnLane(v, from.id, Math.min(1, from.length / 2));
      if (traffic.planTo(v, { lane: to.id, s: to.length / 2 })) ok++;
    }
    expect(ok).toBeGreaterThanOrEqual(98);
  });
});

/**
 * Size of the largest strongly connected set of segments, where connectors are the arcs and the
 * world outside the frame is one extra vertex (segments leaving / entering at boundary nodes).
 */
function largestSegmentScc(city: City): number {
  const outside = city.segments.length;
  const n = outside + 1;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const c of city.connectors) adj[city.lanes[c.from]!.seg]!.push(city.lanes[c.to]!.seg);
  for (const s of city.segments) {
    if (city.nodes[s.to]!.boundary) adj[s.id]!.push(outside);
    if (city.nodes[s.from]!.boundary) adj[outside]!.push(s.id);
  }
  const rev: number[][] = Array.from({ length: n }, () => []);
  adj.forEach((outs, a) => outs.forEach((b) => rev[b]!.push(a)));
  // Kosaraju.
  const order: number[] = [];
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    const stack: [number, number][] = [[s, 0]];
    seen[s] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const outs = adj[top[0]]!;
      if (top[1] < outs.length) {
        const w = outs[top[1]++]!;
        if (!seen[w]) {
          seen[w] = 1;
          stack.push([w, 0]);
        }
      } else {
        order.push(top[0]);
        stack.pop();
      }
    }
  }
  const comp = new Int32Array(n).fill(-1);
  let best = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const s = order[i]!;
    if (comp[s] !== -1) continue;
    let size = 0;
    const stack = [s];
    comp[s] = s;
    while (stack.length) {
      const v = stack.pop()!;
      size++;
      for (const w of rev[v]!) if (comp[w] === -1) {
        comp[w] = s;
        stack.push(w);
      }
    }
    best = Math.max(best, comp[outside] === s ? size - 1 : size);
  }
  return best;
}
