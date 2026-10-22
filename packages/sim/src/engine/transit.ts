import type { VehicleKind } from '@kolo/contracts';
import type { DistrictProfile, TransitMode } from '../city/district.js';
import type { City } from '../city/types.js';
import type { Rng } from '../rng.js';
import { belgradeTime, serviceFor } from '../transit/calendar.js';
import { chooseLanes, laneIndexesFor } from './routing.js';
import { makeVehicle, type PathStep, type TrafficSystem, type Vehicle } from './traffic.js';
import type { NetPattern, TransitNet } from './transit-net.js';

const KIND: Record<TransitMode, VehicleKind> = { bus: 'BUS', trolley: 'TROLLEY', minibus: 'MINIBUS', tram: 'TRAM' };
/** A trip starting at a terminus inside the frame shows up this long before its departure. */
const TERMINUS_LEAD = 60;
/** A trip that cannot get on the road (entry or terminus occupied) waits this long, then is missed. */
const SPAWN_GRACE = 120;
/** Seconds a vehicle stays at its last stop before it disappears (trips ending inside the frame). */
const LAST_STOP_LINGER = 20;
/** Later than this at a stop: short dwell, no waiting for the timetable. */
const LATE = 60;
const ENTRY_ROOM = 9;
const PLACE_ROOM = 14;
const PLACE_STEP = 15;
/** A vehicle this close to the end of its exit lane has left the map. */
const EXIT_ROOM = 8;
/** Vehicles queuing for a stop stand this far apart. */
const BERTH_GAP = 1.5;
const BERTH_MIN = 2;
const NOON = 43_200;
/** Trips in progress are looked up this far back when the clock jumps. */
const LOOKBACK = 3 * 3600;

const noonCache = new Map<string, number>();

/**
 * Epoch ms of GTFS time `sec` on service day `date` (YYYYMMDD). GTFS counts from noon minus 12 hours,
 * so service seconds run on without gaps or repeats through the clock changes.
 */
export function serviceEpoch(date: string, sec: number): number {
  let noon = noonCache.get(date);
  if (noon === undefined) {
    noon = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), 11);
    for (let i = 0; i < 2; i++) noon += (NOON - belgradeTime(noon).secOfDay) * 1000;
    noonCache.set(date, noon);
  }
  return noon + (sec - NOON) * 1000;
}

function prevDate(date: string): string {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)) - 86_400_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** One departure of the timetable. */
export interface ScheduledTrip {
  /** Service day and index in that service's departures: unique per trip. */
  key: string;
  date: string;
  service: string;
  pattern: NetPattern;
  profile: DistrictProfile;
  /** Epoch ms of the departure from the first stop in the frame (time 0 of the profile). */
  startAt: number;
  /** Epoch ms the vehicle appears: at the frame entry, or at the terminus a minute before leaving. */
  spawnAt: number;
  /** Epoch ms it leaves the frame or disappears from its last stop. */
  endAt: number;
}

export type TripPhase = 'drive' | 'dwell' | 'leave';

export interface Trip extends ScheduledTrip {
  id: string;
  v: Vehicle;
  phase: TripPhase;
  /** Index into pattern.stops of the next stop to serve. */
  next: number;
  /** Index into pattern.segs of the segment the current leg starts on. */
  segIdx: number;
  dwellUntil: number;
  /** Seconds behind the timetable at the last departure (negative: early). */
  delaySec: number;
}

interface Departure {
  spawnS: number;
  startS: number;
  endS: number;
  pattern: NetPattern;
  profile: DistrictProfile;
}

/** Public transport on the timetable: launches trips at the frame or at termini and runs them stop by stop. */
export class Transit {
  readonly trips = new Map<string, Trip>();
  readonly byVehicle = new Map<string, Trip>();
  readonly stats = { spawnedTrips: 0, missedTrips: 0, servedStops: 0, missedStops: 0 };
  private readonly city: City;
  private readonly departures = new Map<string, Departure[]>();
  private queue: ScheduledTrip[] = [];
  private handled = new Set<string>();
  private lastUpdate = -Infinity;
  private seq = 0;

  constructor(
    private readonly traffic: TrafficSystem,
    readonly net: TransitNet,
    private readonly rng: Rng,
  ) {
    this.city = traffic.city;
  }

  // ───────────────────────────── timetable ─────────────────────────────

  /** Departures of a service, sorted by the time their vehicle appears. */
  private departuresOf(service: string): Departure[] {
    let list = this.departures.get(service);
    if (list) return list;
    list = [];
    for (const pattern of this.net.patterns) {
      // Trams join the timetable in plan 4, task 5.
      if (pattern.mode === 'tram') continue;
      const first = pattern.stops[0]!.timeIdx;
      const last = pattern.stops[pattern.stops.length - 1]!.timeIdx;
      for (const profile of pattern.profiles) {
        const deltas = profile.starts[service];
        if (!deltas) continue;
        const spawn = pattern.entryLane >= 0 && profile.enter !== undefined ? profile.enter : profile.t[2 * first + 1]! - TERMINUS_LEAD;
        const end = pattern.exitSeg >= 0 && profile.exit !== undefined ? profile.exit : profile.t[2 * last]! + LAST_STOP_LINGER;
        let startS = 0;
        for (const d of deltas) {
          startS += d;
          list.push({ spawnS: startS + spawn, startS, endS: startS + Math.max(end, spawn + 1), pattern, profile });
        }
      }
    }
    list.sort((a, b) => a.spawnS - b.spawnS);
    this.departures.set(service, list);
    return list;
  }

  /** Trips whose vehicle appears in [fromMs, toMs), from every service day that can reach that window. */
  tripsBetween(fromMs: number, toMs: number): ScheduledTrip[] {
    const out: ScheduledTrip[] = [];
    const today = belgradeTime(toMs).date;
    const first = belgradeTime(fromMs).date;
    const dates = new Set([today, prevDate(today), first, prevDate(first)]);
    for (const date of dates) {
      const service = serviceFor(date, this.city.transit.calendar);
      const list = this.departuresOf(service);
      const lo = (fromMs - serviceEpoch(date, 0)) / 1000;
      const hi = (toMs - serviceEpoch(date, 0)) / 1000;
      for (let i = lowerBound(list, lo); i < list.length && list[i]!.spawnS < hi; i++) {
        const d = list[i]!;
        out.push({
          key: `${date}:${i}`,
          date,
          service,
          pattern: d.pattern,
          profile: d.profile,
          startAt: serviceEpoch(date, d.startS),
          spawnAt: serviceEpoch(date, d.spawnS),
          endAt: serviceEpoch(date, d.endS),
        });
      }
    }
    return out.sort((a, b) => a.spawnAt - b.spawnAt);
  }

  arrivalAt(trip: ScheduledTrip, k: number) {
    return trip.startAt + trip.profile.t[2 * trip.pattern.stops[k]!.timeIdx]! * 1000;
  }

  departureAt(trip: ScheduledTrip, k: number) {
    return trip.startAt + trip.profile.t[2 * trip.pattern.stops[k]!.timeIdx + 1]! * 1000;
  }

  // ───────────────────────────── launching ─────────────────────────────

  /** Once a second: queue the trips due since the last call, launch what fits, give up on the stale. */
  update(clockMs: number) {
    if (clockMs > this.lastUpdate) {
      const from = Number.isFinite(this.lastUpdate) ? this.lastUpdate : clockMs;
      for (const t of this.tripsBetween(from, clockMs + 1)) {
        if (this.handled.has(t.key)) continue;
        this.handled.add(t.key);
        this.queue.push(t);
      }
      this.lastUpdate = clockMs;
    }
    this.queue = this.queue.filter((t) => {
      if (t.spawnAt > clockMs) return true;
      if (this.launch(t)) return false;
      if (clockMs - t.spawnAt > SPAWN_GRACE * 1000) {
        this.stats.missedTrips++;
        return false;
      }
      return true;
    });
    if (this.handled.size > 20_000) this.pruneHandled(clockMs);
  }

  private pruneHandled(clockMs: number) {
    const keep = new Set(this.tripsBetween(clockMs - LOOKBACK * 1000, clockMs + 1).map((t) => t.key));
    for (const k of this.handled) if (!keep.has(k)) this.handled.delete(k);
  }

  private launch(t: ScheduledTrip): boolean {
    const p = t.pattern;
    if (p.entryLane >= 0) {
      if (!this.traffic.isLaneFree(p.entryLane, 0, ENTRY_ROOM)) return false;
      const trip = this.create(t, 0, 'drive', 0);
      this.traffic.placeOnLane(trip.v, p.entryLane, 1);
      trip.v.speed = this.city.segments[this.city.lanes[p.entryLane]!.seg]!.speed * 0.5;
      this.planLeg(trip);
      return true;
    }
    const stop = p.stops[0]!;
    if (!this.traffic.isLaneFree(stop.lane, stop.s, PLACE_ROOM)) return false;
    const trip = this.create(t, 1, 'dwell', p.stops[0]!.segIdx);
    trip.dwellUntil = this.departureAt(t, 0);
    this.traffic.placeOnLane(trip.v, stop.lane, stop.s, true);
    return true;
  }

  private create(t: ScheduledTrip, next: number, phase: TripPhase, segIdx: number): Trip {
    const v = makeVehicle(`B${++this.seq}`, KIND[t.pattern.mode], this.rng);
    const trip: Trip = { ...t, id: v.id, v, phase, next, segIdx, dwellUntil: 0, delaySec: 0 };
    this.traffic.add(v);
    this.trips.set(t.key, trip);
    this.byVehicle.set(v.id, trip);
    this.handled.add(t.key);
    this.stats.spawnedTrips++;
    return trip;
  }

  private finish(trip: Trip) {
    this.traffic.remove(trip.v);
    this.trips.delete(trip.key);
    this.byVehicle.delete(trip.id);
  }

  // ───────────────────────────── running ─────────────────────────────

  /** Lane steps of the leg from the current segment to the next stop (or out of the frame). */
  private legSteps(p: NetPattern, next: number, segIdx: number, fromLane: number): { toLane: number; steps: PathStep[] } | null {
    const target = p.stops[next];
    const end = target ? target.segIdx : p.segs.length - 1;
    const chain = p.segs.slice(segIdx, end + 1);
    const toLane = target ? target.lane : -1;
    if (chain.length === 1) return { toLane, steps: [] };
    const steps = chooseLanes(this.city, chain, fromLane, toLane, laneIndexesFor(this.city, chain, 0, target ? 'curb' : 'any'));
    return steps ? { toLane, steps } : null;
  }

  /** Sets the vehicle's path for the leg ahead and its stop. */
  private planLeg(trip: Trip): boolean {
    const v = trip.v;
    const leg = this.legSteps(trip.pattern, trip.next, trip.segIdx, v.lane);
    if (!leg) return false;
    const target = trip.pattern.stops[trip.next];
    v.path = [{ lane: v.lane, conn: -1 }, ...leg.steps];
    v.pathIdx = 0;
    v.committed = -1;
    v.pathEnded = false;
    v.arrived = false;
    v.stop = target ? { lane: leg.toLane, s: target.s } : null;
    trip.phase = target ? 'drive' : 'leave';
    return true;
  }

  /** Every simulation step: arrivals, departures, vehicles that left. */
  step(clockMs: number) {
    const pulled = new Map<number, Vehicle[]>();
    for (const o of this.traffic.vehicles) if (o.mode === 'pulled') pulled.set(o.lane, [...(pulled.get(o.lane) ?? []), o]);
    for (const trip of this.trips.values()) {
      const v = trip.v;
      const p = trip.pattern;
      if (trip.phase === 'drive') {
        const berth = v.stop && !v.arrived ? this.berth(trip, v.stop.lane, pulled) : 0;
        if (v.stop && berth !== null) v.stop.s = berth;
        if (v.arrived) {
          v.arrived = false;
          this.arrive(trip, clockMs);
        } else if (berth === null || (v.stop && v.mode === 'lane' && v.lane === v.stop.lane && v.pathIdx === v.path.length - 1 && v.s > v.stop.s + 1)) {
          // Rolled past the stop, or it is full: skip it and go on to the next one.
          this.stats.missedStops++;
          trip.segIdx = p.stops[trip.next]!.segIdx;
          trip.next++;
          if (trip.next >= p.stops.length && p.exitSeg < 0) this.finish(trip);
          else if (!this.planLeg(trip)) this.finish(trip);
        }
      } else if (trip.phase === 'dwell') {
        if (clockMs < trip.dwellUntil) continue;
        const k = trip.next - 1;
        if (trip.next >= p.stops.length && p.exitSeg < 0) {
          this.finish(trip);
          continue;
        }
        trip.delaySec = Math.round((clockMs - this.departureAt(trip, k)) / 1000);
        this.depart(trip, p.stops[k]!.departLane);
      } else if (v.mode === 'lane' && v.pathIdx === v.path.length - 1 && v.s >= this.city.lanes[v.lane]!.length - EXIT_ROOM) {
        this.finish(trip);
      }
    }
  }

  /**
   * Where to pull in at the next stop: at the pole, or queued behind whoever already stands there.
   * Null when the vehicle is already alongside a full stop: it drives on.
   */
  private berth(trip: Trip, lane: number, pulled: Map<number, Vehicle[]>): number | null {
    const v = trip.v;
    const pole = trip.pattern.stops[trip.next]!.s;
    const others = (pulled.get(lane) ?? []).filter((o) => o !== v && o.s - o.length < pole + BERTH_GAP).sort((a, b) => b.s - a.s);
    let s = pole;
    // Walk the queue back from the pole: each vehicle standing in the spot pushes it behind itself.
    for (const o of others) if (o.s > s - v.length - BERTH_GAP) s = Math.min(s, o.s - o.length - BERTH_GAP);
    if (v.lane !== lane || v.mode !== 'lane' || s >= v.s + 0.5) return Math.max(s, BERTH_MIN);
    const here = Math.min(pole, v.s + 0.5);
    return others.some((o) => o.s > here - v.length - BERTH_GAP && o.s - o.length < here + BERTH_GAP) ? null : here;
  }

  private arrive(trip: Trip, clockMs: number) {
    const k = trip.next;
    const last = k === trip.pattern.stops.length - 1;
    this.stats.servedStops++;
    trip.segIdx = trip.pattern.stops[k]!.segIdx;
    trip.next++;
    trip.phase = 'dwell';
    if (last && trip.pattern.exitSeg < 0) {
      trip.dwellUntil = clockMs + LAST_STOP_LINGER * 1000;
      return;
    }
    const late = (clockMs - this.departureAt(trip, k)) / 1000;
    trip.dwellUntil = late > LATE ? clockMs + this.rng.range(8, 12) * 1000 : Math.max(clockMs + this.rng.range(15, 30) * 1000, this.departureAt(trip, k));
  }

  /** Leaves the stop, merging into the lane the next turn needs. */
  private depart(trip: Trip, departLane: number) {
    const v = trip.v;
    if (departLane !== v.lane && this.city.lanes[departLane]!.seg === this.city.lanes[v.lane]!.seg) {
      const street = this.city.streets[this.city.segments[this.city.lanes[v.lane]!.seg]!.street]!;
      v.lateral += (this.city.lanes[v.lane]!.index - this.city.lanes[departLane]!.index) * street.laneWidth;
      v.lateralTarget = v.lateral;
      v.lane = departLane;
    }
    if (!this.planLeg(trip)) {
      this.finish(trip);
      return;
    }
    v.wantsDepart = true;
  }

  // ───────────────────────────── clock jumps ─────────────────────────────

  /** Drops every transit vehicle and puts the trips under way back where the timetable has them. */
  rebuild(clockMs: number) {
    for (const trip of [...this.trips.values()]) this.finish(trip);
    this.queue = [];
    this.handled.clear();
    this.lastUpdate = clockMs;
    for (const t of this.tripsBetween(clockMs - LOOKBACK * 1000, clockMs + 1)) {
      this.handled.add(t.key);
      if (t.spawnAt > clockMs || t.endAt <= clockMs) continue;
      this.place(t, clockMs);
    }
  }

  /** Puts a trip under way where its timetable has it at `clockMs`, or as close after as there is room. */
  private place(t: ScheduledTrip, clockMs: number) {
    const p = t.pattern;
    const n = p.stops.length;
    // Leg k runs from stop k - 1 (the frame entry when k = 0) to stop k; leg n leads out of the frame.
    let leg = -1;
    let fromAt = 0;
    let toAt = 0;
    let fromMs = t.spawnAt;
    let toMs = 0;
    for (let k = 0; k < n; k++) {
      const arr = this.arrivalAt(t, k);
      const dep = this.departureAt(t, k);
      if (k === 0 && p.entryLane < 0) {
        if (clockMs < dep) return this.placeAtStop(t, 0, dep);
      } else if (clockMs < arr) {
        leg = k;
        toAt = p.stops[k]!.at;
        toMs = arr;
        break;
      } else if (clockMs < dep) return this.placeAtStop(t, k, dep);
      fromAt = p.stops[k]!.at;
      fromMs = dep;
    }
    if (leg < 0) {
      if (p.exitSeg < 0) return this.placeAtStop(t, n - 1, this.arrivalAt(t, n - 1) + LAST_STOP_LINGER * 1000);
      leg = n;
      toAt = p.length;
      toMs = t.endAt;
    }
    const share = toMs > fromMs ? (clockMs - fromMs) / (toMs - fromMs) : 0;
    const want = fromAt + (toAt - fromAt) * Math.max(0, Math.min(1, share));
    const startSeg = leg === 0 ? 0 : p.stops[leg - 1]!.segIdx;
    const fromLane = leg === 0 ? p.entryLane : p.stops[leg - 1]!.departLane;
    const steps = this.legSteps(p, leg, startSeg, fromLane);
    if (!steps) return;
    const lanes = [fromLane, ...steps.steps.map((s) => s.lane)];
    const limit = leg < n ? toAt - PLACE_STEP : p.length - EXIT_ROOM;
    for (let at = want; at <= Math.max(want, limit); at += PLACE_STEP) {
      let i = lanes.length - 1;
      while (i > 0 && p.segAt[startSeg + i]! > at) i--;
      const lane = this.city.lanes[lanes[i]!]!;
      const s = Math.max(1, Math.min(lane.length - 1, at - p.segAt[startSeg + i]!));
      if (leg < n && i === lanes.length - 1 && s > p.stops[leg]!.s - 6) break;
      if (!this.traffic.isLaneFree(lane.id, s, PLACE_ROOM)) continue;
      const trip = this.create(t, leg, leg < n ? 'drive' : 'leave', startSeg);
      this.traffic.placeOnLane(trip.v, lane.id, s);
      trip.v.speed = this.city.segments[lane.seg]!.speed * 0.5;
      trip.v.path = [{ lane: lane.id, conn: -1 }, ...steps.steps.slice(i)];
      trip.v.stop = leg < n ? { lane: steps.toLane, s: p.stops[leg]!.s } : null;
      return;
    }
  }

  private placeAtStop(t: ScheduledTrip, k: number, until: number) {
    const stop = t.pattern.stops[k]!;
    if (!this.traffic.isLaneFree(stop.lane, stop.s, PLACE_ROOM)) return;
    const trip = this.create(t, k + 1, 'dwell', t.pattern.stops[k]!.segIdx);
    trip.dwellUntil = until;
    this.traffic.placeOnLane(trip.v, stop.lane, stop.s, true);
  }
}

function lowerBound(list: Departure[], spawnS: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.spawnS < spawnS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
