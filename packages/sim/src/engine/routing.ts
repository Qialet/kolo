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
 * Shortest path over the lane graph (lanes joined by junction connectors), returned as the chain of
 * segments it crosses, from `fromSeg` to `toSeg` inclusive. It starts on lane `fromLaneIndex` of
 * `fromSeg` and ends on lane `toLane` (any lane of `toSeg` when -1), so the chain is always drivable
 * lane by lane; a negative `fromLaneIndex` starts from whichever lane of `fromSeg` suits best (a bus
 * merging out of a stop). Bus-only segments are skipped unless `allowPsv` (or they are the destination).
 * When `toSeg === fromSeg` the result is a loop of at least one hop.
 */
export function routeSegments(
  city: City,
  fromSeg: number,
  fromLaneIndex: number,
  toSeg: number,
  extraCost?: SegmentCost,
  allowPsv = false,
  toLane = -1,
): number[] | null {
  const { lanes, connectors, segments } = city;
  const start = segments[fromSeg]!;
  const starts = fromLaneIndex < 0 ? start.lanes : [start.lanes[Math.min(fromLaneIndex, start.lanes.length - 1)]!];
  const isStart = (lane: number) => starts.includes(lane);
  const cost = new Float64Array(lanes.length).fill(Infinity);
  const prev = new Int32Array(lanes.length).fill(-1);
  const heap = new LaneHeap(cost);
  const relax = (from: number, base: number, connId: number) => {
    const c = connectors[connId]!;
    const lane = lanes[c.to]!;
    const seg = segments[lane.seg]!;
    if (seg.psvOnly && !allowPsv && seg.id !== toSeg) return;
    const total = base + c.line.length / c.vmax + lane.length / seg.speed + TURN_PENALTY[c.turn] + (extraCost?.(seg) ?? 0);
    if (total < cost[lane.id]!) {
      cost[lane.id] = total;
      prev[lane.id] = from;
      heap.push(lane.id);
    }
  };
  for (const lane of starts) for (const connId of lanes[lane]!.out) relax(lane, 0, connId);
  let found = -1;
  while (heap.size) {
    const cur = heap.pop();
    const lane = lanes[cur]!;
    if (lane.seg === toSeg && (toLane < 0 || cur === toLane)) {
      found = cur;
      break;
    }
    for (const connId of lane.out) relax(cur, cost[cur]!, connId);
  }
  if (found < 0) return null;
  const chain: number[] = [];
  let cur = found;
  for (let guard = 0; guard <= lanes.length; guard++) {
    chain.push(lanes[cur]!.seg);
    if (isStart(cur) && chain.length > 1) break;
    const p = prev[cur]!;
    if (p < 0) return null;
    if (isStart(p)) {
      chain.push(fromSeg);
      break;
    }
    cur = p;
  }
  return chain.reverse();
}

/** Binary min-heap of lane ids keyed by an external cost array (stale entries are skipped on pop). */
class LaneHeap {
  private items: number[] = [];
  private keys: number[] = [];
  constructor(private readonly cost: Float64Array) {}
  get size() {
    this.dropStale();
    return this.items.length;
  }
  push(id: number) {
    const { items, keys } = this;
    items.push(id);
    keys.push(this.cost[id]!);
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= keys[i]!) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    this.dropStale();
    const top = this.items[0]!;
    this.removeTop();
    return top;
  }
  private dropStale() {
    while (this.items.length && this.keys[0]! > this.cost[this.items[0]!]!) this.removeTop();
  }
  private removeTop() {
    const { items, keys } = this;
    const lastItem = items.pop()!;
    const lastKey = keys.pop()!;
    if (!items.length) return;
    items[0] = lastItem;
    keys[0] = lastKey;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < items.length && keys[l]! < keys[m]!) m = l;
      if (r < items.length && keys[r]! < keys[m]!) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }
  private swap(a: number, b: number) {
    const { items, keys } = this;
    [items[a], items[b]] = [items[b]!, items[a]!];
    [keys[a], keys[b]] = [keys[b]!, keys[a]!];
  }
}

/** Preferred lane index on each segment for the turn that follows it. */
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

/**
 * Lanes and connectors along a segment chain. Starts on `startLane`, ends on `finalLane` (or any
 * lane of the last segment when -1), and on each segment takes the reachable lane closest to the
 * preferred index. Returns one { lane, conn } per segment after the first, or null if impossible.
 */
export function chooseLanes(city: City, segs: number[], startLane: number, finalLane: number, pref: number[]): { lane: number; conn: number }[] | null {
  const last = segs.length - 1;
  // Backward: lanes of each segment from which the rest of the chain is drivable.
  const ok: Set<number>[] = new Array(segs.length);
  ok[last] = new Set(finalLane >= 0 ? [finalLane] : city.segments[segs[last]!]!.lanes);
  for (let k = last - 1; k >= 1; k--) {
    const next = ok[k + 1]!;
    ok[k] = new Set(city.segments[segs[k]!]!.lanes.filter((l) => city.lanes[l]!.out.some((c) => next.has(city.connectors[c]!.to))));
    if (!ok[k]!.size) return null;
  }
  const steps: { lane: number; conn: number }[] = [];
  let cur = startLane;
  for (let k = 1; k <= last; k++) {
    let best: { lane: number; conn: number } | null = null;
    let bestErr = Infinity;
    for (const connId of city.lanes[cur]!.out) {
      const to = city.connectors[connId]!.to;
      if (!ok[k]!.has(to)) continue;
      const err = Math.abs(city.lanes[to]!.index - pref[k]!);
      if (err < bestErr) {
        bestErr = err;
        best = { lane: to, conn: connId };
      }
    }
    if (!best) return null;
    steps.push(best);
    cur = best.lane;
  }
  return steps;
}
