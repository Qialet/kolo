import type { City, Segment, Turn } from '../city/types.js';
import { cross, dot } from '../geometry.js';

const STRAIGHT_MAX = (35 * Math.PI) / 180;
const UTURN_MIN = (150 * Math.PI) / 180;

/** Turn from the exit tangent of `a` onto the entry tangent of `b`; null for a U-turn. */
export function turnBetween(a: Segment, b: Segment): Turn | null {
  const angle = Math.atan2(cross(a.dirOut, b.dirIn), dot(a.dirOut, b.dirIn));
  if (Math.abs(angle) > UTURN_MIN) return null;
  if (Math.abs(angle) <= STRAIGHT_MAX) return 'S';
  return angle > 0 ? 'R' : 'L';
}

const TURN_PENALTY: Record<Turn, number> = { S: 0, R: 3, L: 7 };

export type SegmentCost = (seg: Segment) => number;

/**
 * Shortest path over directed segments. The first hop is restricted by the lane the vehicle
 * currently occupies (left turns from the inner lane, right turns from the curb lane).
 * Returns the segment ids from `fromSeg` to `toSeg` inclusive.
 */
export function routeSegments(
  city: City,
  fromSeg: number,
  fromLaneIndex: number,
  toSeg: number,
  extraCost?: SegmentCost,
): number[] | null {
  const n = city.segments.length;
  const distArr = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const start = city.segments[fromSeg]!;
  const lanesInStart = start.lanes.length;
  // Seed with the successors of the starting segment.
  const open: number[] = [];
  for (const nextId of city.nodes[start.to]!.out) {
    const next = city.segments[nextId]!;
    const turn = turnBetween(start, next);
    if (!turn) continue;
    if (turn === 'L' && fromLaneIndex !== 0) continue;
    if (turn === 'R' && fromLaneIndex !== lanesInStart - 1) continue;
    const c = next.length / next.speed + TURN_PENALTY[turn] + (extraCost?.(next) ?? 0);
    if (c < distArr[nextId]!) {
      distArr[nextId] = c;
      prev[nextId] = fromSeg;
      open.push(nextId);
    }
  }
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (distArr[open[i]!]! < distArr[open[bi]!]!) bi = i;
    const cur = open[bi]!;
    open[bi] = open[open.length - 1]!;
    open.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    if (cur === toSeg) break;
    const seg = city.segments[cur]!;
    for (const nextId of city.nodes[seg.to]!.out) {
      if (done[nextId]) continue;
      const next = city.segments[nextId]!;
      const turn = turnBetween(seg, next);
      if (!turn) continue;
      const c = distArr[cur]! + next.length / next.speed + TURN_PENALTY[turn] + (extraCost?.(next) ?? 0);
      if (c < distArr[nextId]!) {
        distArr[nextId] = c;
        prev[nextId] = cur;
        open.push(nextId);
      }
    }
  }
  if (!Number.isFinite(distArr[toSeg]!)) return null;
  // Walk back at least one hop so that toSeg === fromSeg yields a full loop.
  const path = [toSeg];
  let cur = toSeg;
  do {
    cur = prev[cur]!;
    if (cur < 0 || path.length > n + 1) return null;
    path.push(cur);
  } while (cur !== fromSeg);
  return path.reverse();
}

/** Picks a lane index on each segment so that every turn is legal. */
export function laneIndexesFor(city: City, segs: number[], straightPreference: number, finalLane: 'curb' | 'any'): number[] {
  return segs.map((segId, i) => {
    const seg = city.segments[segId]!;
    const last = seg.lanes.length - 1;
    if (i === segs.length - 1) return finalLane === 'curb' ? last : Math.min(straightPreference, last);
    const turn = turnBetween(seg, city.segments[segs[i + 1]!]!);
    if (turn === 'L') return 0;
    if (turn === 'R') return last;
    return Math.min(straightPreference, last);
  });
}
