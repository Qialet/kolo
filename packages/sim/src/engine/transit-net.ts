import type { DistrictProfile, DistrictTransit, TransitMode } from '../city/district.js';
import type { BusStop, City, CurbRef, Lane, Segment } from '../city/types.js';
import { dist, poseAlong, type Vec2 } from '../geometry.js';
import { segmentDistance } from '../import/polygons.js';
import { chooseLanes, laneIndexesFor, routeSegments, type SegmentCost } from './routing.js';

/** A stop of a routed pattern. */
export interface NetStop {
  /** Index into city.busStops. */
  stop: number;
  /** Position of the stop in the district pattern: its column in the timetable profiles. */
  timeIdx: number;
  /** Index into NetPattern.segs. */
  segIdx: number;
  /** Where this pattern's vehicles stop: the kerb, or the track for a tram. */
  lane: number;
  s: number;
  /** Metres from the start of the route. */
  at: number;
  /** Lane of the stop's segment the vehicle merges into when it leaves (the stop lane unless it must turn off another one). */
  departLane: number;
}

/** A district pattern laid over the road graph. */
export interface NetPattern {
  /** Index into district transit.patterns. */
  index: number;
  /** Index into city.busLines. */
  line: number;
  headsign: string;
  mode: TransitMode;
  /** Segment chain, drivable through the curb lanes of the stops. */
  segs: number[];
  /** Metres from the route start to the start of each segment's curb lane. */
  segAt: number[];
  stops: NetStop[];
  /** Lane of segs[0] trips enter the frame on; -1 when they start at the first stop. */
  entryLane: number;
  /** Last segment, ending at the frame; -1 when trips end at the last stop. */
  exitSeg: number;
  length: number;
  profiles: DistrictProfile[];
}

export interface TransitNet {
  patterns: NetPattern[];
  /** Line id → its patterns. */
  byLine: Map<string, NetPattern[]>;
}

const ENTRY_REACH = 80;
/** Length of the shape's head and tail searched for the frame crossing. */
const FRAME_STRETCH = 250;
const FRAME_ALIGN = Math.cos(Math.PI / 4);
/** Segments whose middle is farther than this from the shape cost extra. */
const SHAPE_NEAR = 25;
const OFF_SHAPE_PENALTY = 4;
/** Two stops on one lane closer than a bus length are served as one. */
const SAME_SPOT = 12;
const CELL = 50;

const curbOf = (city: City, seg: number): Lane => {
  const s = city.segments[seg]!;
  return city.lanes[s.lanes[s.lanes.length - 1]!]!;
};

/** Point of a pattern's route `at` metres from its start, on the curb lanes (gaps at junctions are bridged straight). */
export function patternPoint(city: City, p: NetPattern, at: number): Vec2 {
  let lo = 0;
  let hi = p.segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.segAt[mid]! <= at) lo = mid;
    else hi = mid - 1;
  }
  const lane = curbOf(city, p.segs[lo]!);
  const s = at - p.segAt[lo]!;
  if (s <= lane.length || lo === p.segs.length - 1) {
    const q = poseAlong(lane.line, Math.min(s, lane.length));
    return { x: q.x, z: q.z };
  }
  const next = curbOf(city, p.segs[lo + 1]!).start;
  const gap = p.segAt[lo + 1]! - p.segAt[lo]! - lane.length || 1;
  const k = (s - lane.length) / gap;
  return { x: lane.end.x + (next.x - lane.end.x) * k, z: lane.end.z + (next.z - lane.end.z) * k };
}

/** Lays every district pattern over the road graph: frame entry, legs between bound stops, frame exit. */
export function buildTransitNet(city: City, transit: DistrictTransit): TransitNet {
  const stopIndex = new Map(city.busStops.map((s, i) => [s.id, i]));
  const lineIndex = new Map(city.busLines.map((l, i) => [l.id, i]));
  const mids = segmentMids(city);
  // Trams come and go on the tracks, road vehicles on the streets.
  const entries = (rail: boolean) => city.segments.filter((s) => !!s.rail === rail && city.nodes[s.from]!.boundary);
  const exits = (rail: boolean) => city.segments.filter((s) => !!s.rail === rail && city.nodes[s.to]!.boundary);
  const net: TransitNet = { patterns: [], byLine: new Map() };

  transit.patterns.forEach((raw, index) => {
    const rail = transit.lines[raw.line]!.mode === 'tram';
    const place = (stop: BusStop): CurbRef | null => (rail ? (stop.rail ?? null) : stop);
    const shape: Vec2[] = [];
    for (let i = 0; i < raw.shape.length; i += 2) shape.push({ x: raw.shape[i]!, z: raw.shape[i + 1]! });
    const near = nearShape(mids, shape);
    const cost = (seg: { id: number; length: number; speed: number }) => (near.has(seg.id) ? 0 : (OFF_SHAPE_PENALTY * seg.length) / seg.speed);
    const bound = raw.stops
      .map((i, timeIdx) => ({ timeIdx, stop: stopIndex.get(transit.stops[i]!.id) ?? -1 }))
      .filter((b) => b.stop >= 0 && place(city.busStops[b.stop]!))
      .map((b) => ({ ...b, at: place(city.busStops[b.stop]!)! }));
    if (!bound.length) return;

    const entrySeg = raw.enter && shape.length >= 2 ? frameSeg(city, entries(rail), shape, false) : null;
    const exit = raw.exit && shape.length >= 2 ? frameSeg(city, exits(rail), shape, true) : null;
    let laid = layPattern(city, bound, entrySeg ? curbOf(city, entrySeg.id).id : -1, exit?.id ?? -1, cost);
    if (entrySeg && (laid?.stops.length ?? 0) < bound.length) {
      // An entry road that leads only into a dead end loses to starting at the first stop.
      const plain = layPattern(city, bound, -1, exit?.id ?? -1, cost);
      if (plain && plain.stops.length > (laid?.stops.length ?? 0)) laid = plain;
    }
    if (!laid) return;
    const { segs, stops, entryLane, exitSeg } = laid;
    const segAt = [0];
    for (let i = 1; i < segs.length; i++) {
      const prev = curbOf(city, segs[i - 1]!);
      segAt.push(segAt[i - 1]! + prev.length + dist(prev.end, curbOf(city, segs[i]!).start));
    }
    const length = segAt[segs.length - 1]! + curbOf(city, segs[segs.length - 1]!).length;
    const line = lineIndex.get(transit.lines[raw.line]!.id)!;
    const pattern: NetPattern = {
      index,
      line,
      headsign: raw.headsign,
      mode: city.busLines[line]!.mode,
      segs,
      segAt,
      stops: stops.map((st) => ({ ...st, at: segAt[st.segIdx]! + st.s })),
      entryLane,
      exitSeg,
      length,
      profiles: raw.profiles,
    };
    net.patterns.push(pattern);
    const id = city.busLines[line]!.id;
    net.byLine.set(id, [...(net.byLine.get(id) ?? []), pattern]);
  });
  return net;
}

/**
 * Chains legs from the frame entry (or the first stop) through the bound stops to the frame exit.
 * A stop that cannot be reached is skipped; a stop nothing can be reached from (a ramp, a turning
 * loop) is dropped when the next one is reachable without it. Null when no stop is reached.
 */
function layPattern(city: City, bound: { timeIdx: number; stop: number; at: CurbRef }[], entryCurb: number, exitSeg: number, cost: SegmentCost) {
  const segs: number[] = [];
  const stops: Omit<NetStop, 'at'>[] = [];
  /** Where legs start: the entry (stop -1) or a stop kept, with the length of segs before its own leg. */
  const anchors: { lane: number; s: number; segsBefore: number; stop: number }[] = [];
  let entryLane = -1;
  const leg = (from: { lane: number; s: number }, to: { lane: number; s: number } | { seg: number }): number[] | null => {
    const seg = city.lanes[from.lane]!.seg;
    if ('seg' in to) return to.seg === seg ? [seg] : routeSegments(city, seg, -1, to.seg, cost, true);
    if (to.lane === from.lane && to.s > from.s) return [seg];
    return routeSegments(city, seg, -1, city.lanes[to.lane]!.seg, cost, true, to.lane);
  };
  /** Lane of the chain's first segment, nearest the curb, that drives the whole chain. */
  const departLane = (chain: number[], toLane: number) => {
    const seg = city.segments[chain[0]!]!;
    if (chain.length === 1) return seg.lanes[seg.lanes.length - 1]!;
    const pref = laneIndexesFor(city, chain, 0, toLane >= 0 ? 'curb' : 'any');
    for (let i = seg.lanes.length - 1; i >= 0; i--) if (chooseLanes(city, chain, seg.lanes[i]!, toLane, pref)) return seg.lanes[i]!;
    return seg.lanes[seg.lanes.length - 1]!;
  };
  const follow = (from: (typeof anchors)[number], chain: number[], toLane: number) => {
    if (from.stop < 0) entryLane = departLane(chain, toLane);
    else stops[from.stop]!.departLane = departLane(chain, toLane);
    if (!segs.length) segs.push(chain[0]!);
    segs.push(...chain.slice(1));
  };
  if (entryCurb >= 0) anchors.push({ lane: entryCurb, s: 0, segsBefore: 0, stop: -1 });

  for (const b of bound) {
    const stop = b.at;
    const add = () => {
      stops.push({ stop: b.stop, timeIdx: b.timeIdx, segIdx: segs.length - 1, lane: stop.lane, s: stop.s, departLane: stop.lane });
    };
    if (!anchors.length) {
      segs.push(city.lanes[stop.lane]!.seg);
      add();
      anchors.push({ lane: stop.lane, s: stop.s, segsBefore: 0, stop: 0 });
      continue;
    }
    let at = anchors[anchors.length - 1]!;
    if (stop.lane === at.lane && Math.abs(stop.s - at.s) < SAME_SPOT) continue;
    let chain = leg(at, stop);
    if (!chain && at.stop >= 0) {
      const prev = anchors[anchors.length - 2];
      const retry = prev ? leg(prev, stop) : null;
      if (retry || !prev) {
        // Drop the dead-end stop; with nothing before it the trip starts at this one instead.
        anchors.pop();
        stops.pop();
        segs.length = at.segsBefore;
        if (!prev) {
          segs.push(city.lanes[stop.lane]!.seg);
          add();
          anchors.push({ lane: stop.lane, s: stop.s, segsBefore: 0, stop: 0 });
          continue;
        }
        at = prev;
        chain = retry;
      }
    }
    if (!chain) continue;
    const segsBefore = segs.length;
    follow(at, chain, stop.lane);
    add();
    anchors.push({ lane: stop.lane, s: stop.s, segsBefore, stop: stops.length - 1 });
  }
  if (!stops.length) return null;

  let exitOk = -1;
  if (exitSeg >= 0) {
    const last = anchors[anchors.length - 1]!;
    const chain = leg(last, { seg: exitSeg });
    if (chain) {
      follow(last, chain, -1);
      exitOk = exitSeg;
    }
  }
  return { segs, stops, entryLane, exitSeg: exitOk };
}

/** Curb-lane midpoints of all segments on a coarse grid. */
function segmentMids(city: City): Map<string, { seg: number; p: Vec2 }[]> {
  const grid = new Map<string, { seg: number; p: Vec2 }[]>();
  for (const seg of city.segments) {
    const lane = curbOf(city, seg.id);
    const q = poseAlong(lane.line, lane.length / 2);
    const k = `${Math.floor(q.x / CELL)},${Math.floor(q.z / CELL)}`;
    grid.set(k, [...(grid.get(k) ?? []), { seg: seg.id, p: { x: q.x, z: q.z } }]);
  }
  return grid;
}

/** Segments whose middle lies within SHAPE_NEAR of the shape. */
function nearShape(mids: Map<string, { seg: number; p: Vec2 }[]>, shape: Vec2[]): Set<number> {
  const out = new Set<number>();
  for (let i = 1; i < shape.length; i++) {
    const a = shape[i - 1]!;
    const b = shape[i]!;
    for (let cx = Math.floor((Math.min(a.x, b.x) - SHAPE_NEAR) / CELL); cx <= Math.floor((Math.max(a.x, b.x) + SHAPE_NEAR) / CELL); cx++) {
      for (let cz = Math.floor((Math.min(a.z, b.z) - SHAPE_NEAR) / CELL); cz <= Math.floor((Math.max(a.z, b.z) + SHAPE_NEAR) / CELL); cz++) {
        for (const m of mids.get(`${cx},${cz}`) ?? []) if (!out.has(m.seg) && segmentDistance(m.p, a, b) <= SHAPE_NEAR) out.add(m.seg);
      }
    }
  }
  return out;
}

/** Pieces of the shape within FRAME_STRETCH metres of its start (or end), in travel order. */
function stretch(shape: Vec2[], fromEnd: boolean): [Vec2, Vec2][] {
  const pts = fromEnd ? [...shape].reverse() : shape;
  const out: [Vec2, Vec2][] = [];
  let run = 0;
  for (let i = 1; i < pts.length && run < FRAME_STRETCH; i++) {
    out.push(fromEnd ? [pts[i]!, pts[i - 1]!] : [pts[i - 1]!, pts[i]!]);
    run += dist(pts[i - 1]!, pts[i]!);
  }
  return out;
}

/**
 * Road crossing the frame where the shape does: the frame node closest to the shape's first (or last)
 * stretch, on a segment running the shape's way there.
 */
function frameSeg(city: City, candidates: Segment[], shape: Vec2[], atEnd: boolean): Segment | null {
  const pieces = stretch(shape, atEnd);
  let best: Segment | null = null;
  let bestD = ENTRY_REACH;
  for (const seg of candidates) {
    const node = city.nodes[atEnd ? seg.to : seg.from]!;
    const dir = atEnd ? seg.dirOut : seg.dirIn;
    for (const [a, b] of pieces) {
      const d = segmentDistance(node, a, b);
      const len = dist(a, b) || 1;
      if (d >= bestD || ((b.x - a.x) * dir.x + (b.z - a.z) * dir.z) / len < FRAME_ALIGN) continue;
      best = seg;
      bestD = d;
    }
  }
  return best;
}
