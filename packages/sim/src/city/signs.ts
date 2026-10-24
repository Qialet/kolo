import { dist, dot, norm, sub, type Polyline, type Vec2 } from '../geometry.js';
import type { RoadNode } from './district.js';
import type { City, Segment, TrafficSign } from './types.js';

/** A give way or stop sign drops the approach this far below the rank of the roads it meets. */
export const SIGN_PENALTY = 50;
/** A sign controls the first street junction within this distance ahead of it, metres. */
export const SIGN_REACH = 60;
/** The centre line must pass this close to the sign node. */
const ON_ROAD = 2;
/** Minimum cosine between the sign's direction and the road's. */
const ALIGNED = 0.7;
/** Approaches shorter than this (links inside big junctions) get no sign of their own. */
const MIN_SIGNED = 8;
/** Ring segments carry RING_BONUS on top of the road rank: no priority road sign inside a roundabout. */
const RING_RANK = 10;

interface OnRoad {
  seg: Segment;
  /** Distance from the sign to the end of the segment. */
  ahead: number;
  tangent: Vec2;
}

/**
 * Binds OSM give way and stop signs to the approaches they control, sets every segment's priority and
 * lists the signs to draw: the OSM ones, plus give way and priority road signs where only the ranks decide.
 */
export function applySigns(city: City, nodes: RoadNode[], baseOf: (segId: number) => Polyline, roadJunction: (nodeId: number) => boolean) {
  const roadSegs = city.segments.filter((s) => !s.rail);
  const osmKind = new Map<number, TrafficSign['kind']>();
  const allWay = new Set<number>();

  for (const n of nodes) {
    if (!(n.giveWay || n.stop) || n.signals) continue;
    const dir = n.signDir ? { x: n.signDir[0], z: n.signDir[1] } : null;
    let best: { seg: Segment; dist: number } | null = null;
    for (const seg of roadSegs) {
      const base = baseOf(seg.id);
      // Every point of the line lies within its length of its first point.
      if (dist(base.points[0]!, n) > base.length + ON_ROAD) continue;
      const at = onRoad(seg, base, n);
      if (!at || (dir && dot(at.tangent, dir) < ALIGNED)) continue;
      const found = junctionAhead(city, at, roadJunction);
      if (found && (!best || found.dist < best.dist)) best = found;
    }
    if (!best) continue;
    const kind = n.stop ? 'stop' : 'giveWay';
    if (osmKind.get(best.seg.id) !== 'stop') osmKind.set(best.seg.id, kind);
    if (n.stopAll) allWay.add(best.seg.to);
  }

  for (const [segId, kind] of osmKind) {
    const seg = city.segments[segId]!;
    seg.control = kind === 'stop' ? 'stop' : 'giveWay';
    seg.priority = seg.rank - SIGN_PENALTY;
    city.signs.push({ kind, seg: segId, osm: true });
  }
  for (const nodeId of allWay) {
    for (const segId of city.nodes[nodeId]!.in) {
      const seg = city.segments[segId]!;
      if (seg.rail) continue;
      seg.control = 'stop';
      seg.priority = -SIGN_PENALTY;
      if (!osmKind.has(segId)) city.signs.push({ kind: 'stop', seg: segId, osm: false });
    }
  }

  // Signs the ranks imply at unsignalised junctions.
  for (const node of city.nodes) {
    if (node.signal || node.boundary || !roadJunction(node.id)) continue;
    const ins = node.in.map((id) => city.segments[id]!).filter((s) => !s.rail);
    const top = Math.max(...ins.map((s) => s.priority));
    if (ins.every((s) => s.priority === top)) continue;
    for (const s of ins) {
      if (s.control || s.length < MIN_SIGNED) continue;
      if (s.priority < top) city.signs.push({ kind: 'giveWay', seg: s.id, osm: false });
      else if (s.rank < RING_RANK) city.signs.push({ kind: 'priority', seg: s.id, osm: false });
    }
  }
}

/** Where the sign sits on the segment's centre line, if it does. */
function onRoad(seg: Segment, base: Polyline, p: Vec2): OnRoad | null {
  const { points, cum } = base;
  let best: OnRoad | null = null;
  let bestD = ON_ROAD;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const ab = sub(points[i]!, a);
    const l2 = dot(ab, ab);
    if (l2 === 0) continue;
    const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
    const d = Math.hypot(a.x + ab.x * t - p.x, a.z + ab.z * t - p.z);
    if (d <= bestD) {
      bestD = d;
      best = { seg, ahead: base.length - (cum[i - 1]! + Math.sqrt(l2) * t), tangent: norm(ab) };
    }
  }
  return best;
}

/** Follows the road on through plain nodes to the first street junction within SIGN_REACH. */
function junctionAhead(city: City, at: OnRoad, roadJunction: (nodeId: number) => boolean): { seg: Segment; dist: number } | null {
  let seg = at.seg;
  let dist = at.ahead;
  while (dist <= SIGN_REACH) {
    const node = city.nodes[seg.to]!;
    if (node.boundary) return null;
    if (roadJunction(node.id)) return { seg, dist };
    const on = node.out.map((id) => city.segments[id]!).filter((s) => !s.rail && s.id !== seg.reverse);
    if (on.length !== 1) return null;
    seg = on[0]!;
    dist += seg.length;
  }
  return null;
}
