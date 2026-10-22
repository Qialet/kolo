import { poseAlong, type Vec2 } from '../geometry.js';
import { segmentDistance } from '../import/polygons.js';
import type { DistrictStop, DistrictTransit } from './district.js';
import { lanePoint } from './lanes.js';
import { SegmentGrid } from './places.js';
import type { BusStop, City, Lane } from './types.js';

const STOP_REACH = 30;
/** A tram stop's platform lies along its track: the pole is closer than to a kerb. */
const TRAM_STOP_REACH = 25;
/** Lane direction may differ from the stop's direction of travel by at most 60°. */
const STOP_ALIGN = Math.cos(Math.PI / 3);
const STOP_START = 10;
const STOP_END = 4;
/** Shelter centre measured from the kerb into the sidewalk. */
const SHELTER_BEHIND_KERB = 1.6;
/** Shelter on the platform of a tram-only stop, right of the track axis. */
const PLATFORM_OFFSET = 2.6;

/**
 * Street-level curb lanes (bus-only roads included; tunnels and bridge decks not) indexed for stop binding,
 * or with `rail` the tram tracks outside tunnels.
 */
function curbLanes(city: City, rail = false): SegmentGrid<{ lane: Lane; s0: number }> {
  const grid = new SegmentGrid<{ lane: Lane; s0: number }>();
  for (const seg of city.segments) {
    // Tram stops may stand on a viaduct (Mostar); bus stops only at street level.
    if (!!seg.rail !== rail || seg.layer < 0 || (!rail && seg.layer !== 0)) continue;
    const lane = city.lanes[seg.lanes[seg.lanes.length - 1]!]!;
    if (lane.length < STOP_START + STOP_END) continue;
    const { points, cum } = lane.line;
    for (let i = 1; i < points.length; i++) grid.add(points[i - 1]!, points[i]!, { lane, s0: cum[i - 1]! });
  }
  return grid;
}

/** Nearest lane of the grid within `reach` (30 m) running the stop's way, or null. */
export function bindStop(grid: SegmentGrid<{ lane: Lane; s0: number }>, stop: DistrictStop, reach = STOP_REACH): { lane: Lane; s: number } | null {
  const p = { x: stop.x, z: stop.z };
  const dir = { x: stop.dir[0], z: stop.dir[1] };
  const dirLen = Math.hypot(dir.x, dir.z) || 1;
  let best: { lane: Lane; s: number; d: number } | null = null;
  for (const { a, b, item } of grid.near(p, reach)) {
    const d = segmentDistance(p, a, b);
    if (d > reach || (best && d >= best.d)) continue;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const u: Vec2 = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
    if ((u.x * dir.x + u.z * dir.z) / dirLen < STOP_ALIGN) continue;
    const t = Math.max(0, Math.min(len, (p.x - a.x) * u.x + (p.z - a.z) * u.z));
    best = { lane: item.lane, s: item.s0 + t, d };
  }
  if (!best) return null;
  return { lane: best.lane, s: Math.max(STOP_START, Math.min(best.lane.length - STOP_END, best.s)) };
}

/** Shortest curb lane a stop pick-up point fits on (8 m clear at both ends, 20 m short of the shelter). */
const PICKUP_LANE = 32;

/** Whether taxis can pull up at a stop: a long enough curb lane of the core network that cars may use. */
export function stopPickup(city: City, stop: BusStop): boolean {
  const lane = city.lanes[stop.lane]!;
  const seg = city.segments[lane.seg]!;
  return !!seg.core && !seg.psvOnly && lane.length >= PICKUP_LANE;
}

/**
 * Lines of the district and their stops: bus stops bound to curb lanes, tram stops to their tracks
 * (a stop served by both gets both); stops without a fitting lane are left out.
 */
export function addTransit(city: City, transit: DistrictTransit) {
  city.transit = transit;
  for (const l of transit.lines) city.busLines.push({ id: l.id, name: l.name, longName: l.longName, mode: l.mode, color: l.color, textColor: l.text });
  const linesAt = transit.stops.map(() => new Set<string>());
  const byRoad = new Set<number>();
  const byTram = new Set<number>();
  for (const p of transit.patterns) {
    const line = transit.lines[p.line]!;
    for (const i of p.stops) {
      linesAt[i]!.add(line.id);
      (line.mode === 'tram' ? byTram : byRoad).add(i);
    }
  }
  const curbs = curbLanes(city);
  const tracks = curbLanes(city, true);
  transit.stops.forEach((raw, i) => {
    const curb = byRoad.has(i) ? bindStop(curbs, raw) : null;
    const rail = byTram.has(i) ? bindStop(tracks, raw, TRAM_STOP_REACH) : null;
    const hit = curb ?? rail;
    if (!hit) return;
    const pose = poseAlong(hit.lane.line, hit.s);
    const behind = curb ? city.streets[city.segments[hit.lane.seg]!.street]!.laneWidth / 2 + SHELTER_BEHIND_KERB : PLATFORM_OFFSET;
    const at = lanePoint(city, hit.lane.id, hit.s, behind);
    const stop: BusStop = {
      id: raw.id,
      code: raw.code,
      name: raw.name,
      lane: hit.lane.id,
      s: hit.s,
      x: at.x,
      z: at.z,
      heading: pose.heading,
      lines: [...linesAt[i]!],
    };
    if (rail) stop.rail = { lane: rail.lane.id, s: rail.s };
    city.busStops.push(stop);
  });
}
