import { poseAlong, type Vec2 } from '../geometry.js';
import { segmentDistance } from '../import/polygons.js';
import type { DistrictStop, DistrictTransit } from './district.js';
import { lanePoint } from './lanes.js';
import { buildingIndex, roadSurface, SegmentGrid } from './places.js';
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
/** Platform of a tram-only stop: centre this far from the track axis, its width and the length back from the stop. */
const PLATFORM_OFFSET = 2.6;
const PLATFORM_HALF_WIDTH = 1.1;
const PLATFORM_LENGTH = 30;

/**
 * A bus bay cut into the sidewalk at a stop: from BAY_BACK metres short of the stop point (the bus's front)
 * to BAY_FWD past it, BAY_WIDTH wide beyond the kerb; the entry tapers over BAY_TAPER_IN, the exit over BAY_FWD.
 */
export const BAY_BACK = 22;
export const BAY_FWD = 7;
export const BAY_WIDTH = 3;
export const BAY_TAPER_IN = 8;
/** Sidewalk kept clear behind a bay: the shelter stands there. */
const BAY_WALK = 1.6;

/**
 * Whether a bay fits at a curb stop: inside its lane, with no building on the bay or the sidewalk behind it
 * and no other road on the bay.
 */
function bayFits(city: City, lane: Lane, s: number, inBuilding: (p: Vec2) => string | undefined, onRoad: RoadSurface): boolean {
  if (s - BAY_BACK < 0 || s + BAY_FWD > lane.length) return false;
  const seg = city.segments[lane.seg]!;
  const kerb = city.streets[seg.street]!.laneWidth / 2;
  // The kerb returns of the street's own junctions may meet a bay at its ends.
  const own = (node: number) => node === seg.from || node === seg.to;
  for (let at = s - BAY_BACK; at <= s + BAY_FWD; at += 2) {
    for (const off of [0.5, BAY_WIDTH / 2, BAY_WIDTH, BAY_WIDTH + BAY_WALK]) {
      const p = lanePoint(city, lane.id, at, kerb + off);
      if (inBuilding(p) || (off <= BAY_WIDTH && onRoad(p, 0, own))) return false;
    }
  }
  return true;
}

type RoadSurface = ReturnType<typeof roadSurface>;

/** Every street lane above ground, for keeping tram platforms off them. */
function streetLanes(city: City): SegmentGrid<number> {
  const grid = new SegmentGrid<number>();
  for (const lane of city.lanes) {
    const seg = city.segments[lane.seg]!;
    if (seg.rail || seg.layer < 0) continue;
    const half = city.streets[seg.street]!.laneWidth / 2;
    const { points } = lane.line;
    for (let i = 1; i < points.length; i++) grid.add(points[i - 1]!, points[i]!, half);
  }
  return grid;
}

/**
 * Side of the track for a tram-only platform running back from the stop: right if no car lane
 * reaches into it, else left, else none (the track runs between car lanes).
 */
function platformSide(streets: SegmentGrid<number>, track: Lane, s: number): number | undefined {
  const mid = Math.max(PLATFORM_LENGTH / 2, s - PLATFORM_LENGTH / 2);
  const clear = (lateral: number) => {
    for (let at = mid - PLATFORM_LENGTH / 2; at <= mid + PLATFORM_LENGTH / 2; at += 3) {
      for (const off of [-PLATFORM_HALF_WIDTH, 0, PLATFORM_HALF_WIDTH]) {
        const p = poseAlong(track.line, at, lateral + off);
        for (const { a, b, item } of streets.near(p, 4)) if (segmentDistance(p, a, b) < item) return false;
      }
    }
    return true;
  };
  return [PLATFORM_OFFSET, -PLATFORM_OFFSET].find(clear);
}

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

/** Taxis wait this far short of the shelter, or of the bay where there is one. */
const PICKUP_SHORT = 20;
const PICKUP_SHORT_OF_BAY = 6;
const PICKUP_MIN_S = 8;

/**
 * Where taxis pull up at a stop (s on its lane), or null when they cannot: the curb lane must be a long enough
 * lane of the core network that cars may use, and a taxi never stands in a bay.
 */
export function stopPickupS(city: City, stop: BusStop): number | null {
  const lane = city.lanes[stop.lane]!;
  const seg = city.segments[lane.seg]!;
  if (!seg.core || seg.psvOnly || lane.length < PICKUP_LANE) return null;
  if (!stop.bay) return Math.max(PICKUP_MIN_S, stop.s - PICKUP_SHORT);
  const s = stop.s - BAY_BACK - PICKUP_SHORT_OF_BAY;
  return s >= PICKUP_MIN_S ? s : null;
}

/** Whether taxis can pull up at a stop (see stopPickupS). */
export function stopPickup(city: City, stop: BusStop): boolean {
  return stopPickupS(city, stop) !== null;
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
  const streets = streetLanes(city);
  const inBuilding = buildingIndex(city.buildings);
  const onRoad = roadSurface(city);
  transit.stops.forEach((raw, i) => {
    const curb = byRoad.has(i) ? bindStop(curbs, raw) : null;
    const rail = byTram.has(i) ? bindStop(tracks, raw, TRAM_STOP_REACH) : null;
    const hit = curb ?? rail;
    if (!hit) return;
    const pose = poseAlong(hit.lane.line, hit.s);
    const platform = curb ? undefined : platformSide(streets, hit.lane, hit.s);
    let bay = false;
    if (curb) {
      const seg = city.segments[curb.lane.seg]!;
      // OSM bays everywhere; guessed ones only on boulevards, never over a track or on a bus-only road.
      const guess = city.streets[seg.street]!.cls === 'boulevard' && !curb.lane.twins && !seg.psvOnly;
      bay = !!raw.bay || (guess && bayFits(city, curb.lane, curb.s, inBuilding, onRoad));
    }
    const kerb = curb ? city.streets[city.segments[hit.lane.seg]!.street]!.laneWidth / 2 : 0;
    const behind = curb ? kerb + (bay ? BAY_WIDTH : 0) + SHELTER_BEHIND_KERB : (platform ?? PLATFORM_OFFSET);
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
    if (bay) stop.bay = true;
    if (rail) stop.rail = { lane: rail.lane.id, s: rail.s };
    if (platform !== undefined) stop.platform = platform;
    city.busStops.push(stop);
  });
}
