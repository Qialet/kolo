import { isTransitKind } from '@kolo/contracts';
import { lanePoint } from '../city/lanes.js';
import type { City, Connector } from '../city/types.js';
import { projectOnPolyline } from '../geometry.js';
import { chooseLanes, laneIndexesFor } from './routing.js';
import type { OccEntry, PathStep, TrafficSystem, Vehicle } from './traffic.js';

/** Seconds between two looks at the neighbouring lanes, per vehicle. */
export const LC_INTERVAL = 0.5;
/** Seconds after a lane change before the next one. */
export const LC_COOLDOWN = 6;
/** The new follower must not have to brake harder than this (m/s²). */
export const LC_SAFE_DECEL = 3;
/** No lane changes in the last metres before the stop line (solid line before a junction). */
export const LC_END_ZONE = 20;
/** Advantage (m/s²) for each junction shift saved on the next two junctions of the path. */
export const LC_PREP_BONUS = 0.6;
/** No lane changes in the first metres of a lane, right after the junction. */
const LC_START_ZONE = 6;
/** Advantage over which a car (or a bus, trolleybus, minibus) changes lanes, m/s². */
const THRESHOLD_CAR = 0.2;
const THRESHOLD_TRANSIT = 0.8;
/** Below this speed a lane change starts only round a vehicle standing ahead. */
const MIN_SPEED = 2;
/** Standing this long behind a standing leader, a driver steers round it from a standstill. */
const STANDING_PATIENCE = 3;
/** Room it needs ahead for that (a queued car creeps up to its minimum gap, 1.8–2.6 m). */
const STANDING_ROOM = 1.5;
/** Free road ahead counts as a standing obstacle this far past the stop line, on both lanes alike. */
const LINE_HORIZON = 15;
/** Further than this behind its leader a vehicle has nothing to overtake. */
const FREE_ROAD = 50;

/**
 * A straight connector that leads into another lane than the one straight ahead (laneMoves' middle lane):
 * a lane change squeezed into the junction.
 */
export function isJunctionShift(city: City, c: Connector): boolean {
  if (c.turn !== 'S') return false;
  const from = city.lanes[c.from]!;
  const to = city.lanes[c.to]!;
  const nIn = from.lanesInSeg;
  const nOut = to.lanesInSeg;
  const m = nIn === 1 ? nOut - 1 : Math.round((from.index * (nOut - 1)) / (nIn - 1));
  return to.index !== m;
}

/** Junction shifts among the first two connectors of `steps`. */
function shifts(city: City, steps: PathStep[], from: number): number {
  let n = 0;
  for (let i = from; i < Math.min(steps.length, from + 2); i++) if (isJunctionShift(city, city.connectors[steps[i]!.conn]!)) n++;
  return n;
}

/**
 * MOBIL: the neighbouring lane `v` should move to now, or -1. The gain is the vehicle's own IDM acceleration
 * there minus here, plus politeness times what the followers on both lanes gain or lose, plus a bonus for
 * saving junction shifts; the change must leave the new follower a safe deceleration and the path drivable.
 */
export function decideLaneChange(traffic: TrafficSystem, v: Vehicle): number {
  const { city } = traffic;
  if (v.mode !== 'lane' || v.kind === 'TRAM' || v.changeFrom >= 0 || v.changeCooldown > 0 || v.committed >= 0) return -1;
  const lane = city.lanes[v.lane]!;
  if (lane.lanesInSeg < 2) return -1;
  const seg = city.segments[lane.seg]!;
  const toEnd = lane.length - v.s;
  if (v.s < LC_START_ZONE || toEnd < Math.max(LC_END_ZONE, 3 * v.speed + 8)) return -1;
  // On the street of its stop a vehicle only moves towards the stop's lane.
  const stopHere = v.stop && city.lanes[v.stop.lane]!.seg === lane.seg ? v.stop.lane : -1;
  if (stopHere === v.lane) return -1;

  const here = traffic.neighbours(v.lane, v.s, v);
  // A tram standing at its stop (or anything standing on the tracks over this lane) is waited for, not overtaken.
  if (here.leader && here.leader.v.speed < 0.3 && (here.leader.v.kind === 'TRAM' || city.segments[city.lanes[here.leader.v.lane]!.seg]!.rail)) return -1;
  const gapHere = here.leader ? here.leader.pos - here.leader.v.length - v.s : Infinity;
  if (v.speed < MIN_SPEED && !(here.leader && here.leader.v.speed < 0.3 && v.stoppedFor > STANDING_PATIENCE && gapHere >= STANDING_ROOM)) return -1;

  const shiftsHere = shifts(city, v.path, v.pathIdx + 1);
  // Free road ahead and nothing to prepare for: no lane can be better (most vehicles, most of the time).
  if (gapHere > FREE_ROAD && shiftsHere === 0 && stopHere < 0) return -1;

  const v0 = (who: Vehicle) => seg.speed * who.drv.v0Factor;
  const horizon = toEnd + LINE_HORIZON;
  const accel = (who: Vehicle, ahead: OccEntry | null, at: number, behindOf: Vehicle | null, aheadPos = 0) => {
    // The gap of `who` (front at `at`) to `ahead`, or to `behindOf` standing in for it.
    let gap = Infinity;
    let speed = 0;
    if (behindOf) {
      gap = aheadPos - behindOf.length - at;
      speed = behindOf.speed;
    } else if (ahead) {
      gap = ahead.pos - ahead.v.length - at;
      speed = ahead.v.speed;
    }
    const lineGap = horizon - (at - v.s);
    if (lineGap < gap) {
      gap = lineGap;
      speed = 0;
    }
    return traffic.idmAccel(who, v0(who), gap, speed);
  };
  const politeness = v.drv.politeness;
  const aHere = accel(v, here.leader, v.s, null);
  // The follower here gets my leader once I am gone.
  const oldFollowerGain = here.follower ? accel(here.follower.v, here.leader, here.follower.pos, null) - accel(here.follower.v, null, here.follower.pos, v, v.s) : 0;
  const threshold = isTransitKind(v.kind) ? THRESHOLD_TRANSIT : THRESHOLD_CAR;

  const at = lanePoint(city, v.lane, v.s);
  // Heading for the stop's lane is not optional.
  const stopBonus = stopHere >= 0 ? LC_PREP_BONUS : 0;
  let segs: number[] | null = null;
  let best = -1;
  let bestGain = threshold;
  for (const toLane of seg.lanes) {
    const to = city.lanes[toLane]!;
    if (Math.abs(to.index - lane.index) !== 1) continue;
    if (stopHere >= 0 && to.id !== stopHere) continue;
    const s = projectOnPolyline(to.line, at);
    const there = traffic.neighbours(toLane, s, v);
    if (there.leader && there.leader.pos - there.leader.v.length - s < v.drv.minGap) continue;
    let newFollowerGain = 0;
    if (there.follower) {
      const f = there.follower;
      const gapBack = s - v.length - f.pos;
      if (gapBack < f.v.drv.minGap) continue;
      const aF = accel(f.v, null, f.pos, v, s);
      if (aF < -LC_SAFE_DECEL) continue;
      newFollowerGain = aF - accel(f.v, there.leader, f.pos, null);
    }
    const aThere = accel(v, there.leader, s, null);
    let gain = aThere - aHere + politeness * (newFollowerGain + oldFollowerGain) + stopBonus;
    // Even saving every junction shift ahead would not make it worth it: skip re-planning the path.
    if (gain + LC_PREP_BONUS * shiftsHere <= bestGain) continue;
    // The rest of the path from that lane: it must exist, and fewer junction shifts are worth a bonus.
    segs ??= v.path.slice(v.pathIdx).map((step) => city.lanes[step.lane]!.seg);
    let rest: PathStep[] = [];
    if (segs.length > 1) {
      const found = chooseLanes(city, segs, toLane, v.stop ? v.stop.lane : -1, laneIndexesFor(city, segs, v.straightPreference, v.stop ? 'curb' : 'any'));
      if (!found) continue;
      rest = found;
    } else if (v.stop && v.stop.lane !== toLane) continue;
    gain += LC_PREP_BONUS * (shiftsHere - shifts(city, rest, 0));
    if (gain > bestGain) {
      bestGain = gain;
      best = toLane;
    }
  }
  return best;
}
