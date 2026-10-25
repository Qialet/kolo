import { add, cross, dist, dot, norm, scale, sub, type Vec2 } from '../geometry.js';
import { pointInPolygon } from '../import/polygons.js';
import { offsetPoints } from './surface.js';

/** Rings whose centre line lies within this radius collapse into one junction that cars drive round. */
export const MINI_RING = 8;

/** One piece of a ring as the graph has it: OSM nodes at its ends and its course in the direction of travel. */
export interface RingPiece {
  a: number;
  b: number;
  pts: Vec2[];
  /** Half the paved width. */
  half: number;
}

/** A closed roundabout: its OSM nodes, its centre line in the direction of travel and its island. */
export interface Ring {
  nodes: Set<number>;
  centre: Vec2;
  /** Mean distance of the centre line from the centre. */
  radius: number;
  /** +1 when travel turns the way atan2(z, x) grows, else -1. */
  turn: 1 | -1;
  /** Widest half width of its pieces. */
  half: number;
  /** Inner kerb: the island's outline. */
  island: Vec2[];
  /** Outer kerb. */
  outer: Vec2[];
  mini: boolean;
}

/** Closed loops of ring pieces (each node with one piece in and one out); open chains are no rings. */
export function findRings(pieces: RingPiece[]): Ring[] {
  const next = new Map<number, RingPiece>();
  const ins = new Map<number, number>();
  for (const p of pieces) {
    next.set(p.a, p);
    ins.set(p.b, (ins.get(p.b) ?? 0) + 1);
  }
  const used = new Set<RingPiece>();
  const rings: Ring[] = [];
  for (const first of pieces) {
    if (used.has(first)) continue;
    const loop: RingPiece[] = [];
    let p: RingPiece | undefined = first;
    while (p && !used.has(p)) {
      used.add(p);
      loop.push(p);
      p = next.get(p.b);
    }
    if (p !== first || loop.some((q) => ins.get(q.a) !== 1)) continue;
    const pts = loop.flatMap((q) => q.pts.slice(0, -1));
    const centre = scale(pts.reduce((s, q) => add(s, q), { x: 0, z: 0 }), 1 / pts.length);
    const radius = pts.reduce((s, q) => s + dist(q, centre), 0) / pts.length;
    let area2 = 0;
    pts.forEach((q, i) => (area2 += cross(q, pts[(i + 1) % pts.length]!)));
    const turn = area2 > 0 ? 1 : -1;
    const half = Math.max(...loop.map((q) => q.half));
    const mini = radius <= MINI_RING;
    let island: Vec2[];
    let outer: Vec2[];
    if (mini) {
      // Cars drive a true circle round a small ring (aroundIsland): its kerbs are circles too.
      island = circle(centre, Math.max(1.5, radius - half));
      outer = circle(centre, radius + half);
    } else {
      // rightOf turns the way atan2 grows: travelling that way the island lies to the right.
      const closed = [...pts, pts[0]!];
      island = offsetPoints(closed, turn * Math.min(half, radius - 1)).slice(0, -1);
      outer = offsetPoints(closed, -turn * half).slice(0, -1);
    }
    rings.push({ nodes: new Set(loop.map((q) => q.a)), centre, radius, turn, half, island, outer, mini });
  }
  return rings;
}

const circle = (c: Vec2, r: number) => Array.from({ length: 32 }, (_, i) => ({ x: c.x + r * Math.cos((i * Math.PI) / 16), z: c.z + r * Math.sin((i * Math.PI) / 16) }));

/** Points of an outline that fall inside a kerb (the island's, or a small ring's outer one) moved out onto it. */
export function pushOutOf(outline: Vec2[], kerb: Vec2[]): Vec2[] {
  return outline.map((q) => {
    if (!pointInPolygon(q, kerb, [])) return q;
    let best = q;
    let gap = Infinity;
    kerb.forEach((a, i) => {
      const b = kerb[(i + 1) % kerb.length]!;
      const ab = sub(b, a);
      const t = Math.max(0, Math.min(1, dot(sub(q, a), ab) / (dot(ab, ab) || 1)));
      const c = add(a, scale(ab, t));
      if (dist(q, c) < gap) [gap, best] = [dist(q, c), c];
    });
    return best;
  });
}

/**
 * Course round a collapsed ring from a lane end p0 (heading d0) to a lane start p1 (heading d1): onto
 * the ring's centre line, along it the way the ring turns, off it again. Null when the two ends lie
 * too close round the ring for an arc between the blends (the plain connector does there).
 */
export function aroundIsland(ring: Ring, p0: Vec2, d0: Vec2, p1: Vec2, d1: Vec2): Vec2[] | null {
  const BLEND = 0.6;
  const STEP = 0.2;
  const angle = (p: Vec2) => Math.atan2(p.z - ring.centre.z, p.x - ring.centre.x);
  let around = ring.turn * (angle(p1) - angle(p0));
  while (around < 0) around += 2 * Math.PI;
  while (around >= 2 * Math.PI) around -= 2 * Math.PI;
  const sweep = around - 2 * BLEND;
  if (sweep < STEP) return null;
  const a0 = angle(p0) + ring.turn * BLEND;
  const on = (a: number) => ({ x: ring.centre.x + ring.radius * Math.cos(a), z: ring.centre.z + ring.radius * Math.sin(a) });
  const tangent = (a: number) => norm({ x: -Math.sin(a) * ring.turn, z: Math.cos(a) * ring.turn });
  const steps = Math.max(2, Math.ceil(sweep / STEP));
  const arc = Array.from({ length: steps + 1 }, (_, i) => on(a0 + (ring.turn * sweep * i) / steps));
  const [s, e] = [arc[0]!, arc[arc.length - 1]!];
  const k0 = dist(p0, s) / 2;
  const k1 = dist(e, p1) / 2;
  const blend = (p: Vec2, c0: Vec2, c1: Vec2, q: Vec2) =>
    Array.from({ length: 7 }, (_, i) => {
      const t = i / 6;
      const u = 1 - t;
      return add(add(scale(p, u * u * u), scale(c0, 3 * u * u * t)), add(scale(c1, 3 * u * t * t), scale(q, t * t * t)));
    });
  const ta0 = tangent(a0);
  const ta1 = tangent(a0 + ring.turn * sweep);
  return [
    ...blend(p0, add(p0, scale(d0, k0)), sub(s, scale(ta0, k0)), s).slice(0, -1),
    ...arc,
    ...blend(e, add(e, scale(ta1, k1)), sub(p1, scale(d1, k1)), p1).slice(1),
  ];
}
