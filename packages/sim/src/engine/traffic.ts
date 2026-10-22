import { isTransitKind, type LightMode, type VehicleKind } from '@kolo/contracts';
import { twinPos } from '../city/corridors.js';
import { lanePoint } from '../city/lanes.js';
import type { City, Connector, CurbRef, Lane, Segment } from '../city/types.js';
import { dist, dot, polyline, poseAlong, poseAt, type Polyline, type Pose, type Vec2 } from '../geometry.js';
import type { Rng } from '../rng.js';
import { chooseLanes, laneIndexesFor, routeSegments, turnBetween } from './routing.js';
import { isFlashing, signalState, type SignalRuntime, type SignalState } from './signals.js';

export type VehicleMode = 'lane' | 'conn' | 'pulled' | 'yard' | 'parked';

/** One lane of a planned path and the connector used to enter it (-1 for the starting lane). */
export interface PathStep {
  lane: number;
  conn: number;
}

export interface DriverProfile {
  v0Factor: number;
  aMax: number;
  bComf: number;
  headway: number;
  minGap: number;
}

export interface Vehicle {
  id: string;
  kind: VehicleKind;
  length: number;
  drv: DriverProfile;
  mode: VehicleMode;
  lane: number;
  conn: number;
  /** Front bumper position along the current lane / connector / yard path. */
  s: number;
  speed: number;
  acc: number;
  path: PathStep[];
  pathIdx: number;
  /** Where to pull over (must be a lane of the path). */
  stop: CurbRef | null;
  committed: number;
  lateral: number;
  lateralTarget: number;
  pullOffset: number;
  yard: Polyline | null;
  yardEnd: 'parked' | 'pulled';
  yardEndS: number;
  pose: Pose;
  /** Set by the traffic system, consumed by the owner. */
  arrived: boolean;
  pathEnded: boolean;
  yardDone: boolean;
  wantsDepart: boolean;
  straightPreference: number;
  odometer: number;
  stoppedFor: number;
}

interface OccEntry {
  v: Vehicle;
  pos: number;
}

const YARD_SPEED = 3.2;
/** Vehicles longer than this keep the junction they left busy until their tail is out. */
const LONG_TAIL = 15;
/** Seconds stopped at a stop line after which a driver no longer yields (see gateOpen). */
const IMPATIENCE = 20;

export function makeDriver(rng: Rng, kind: VehicleKind): DriverProfile {
  if (kind === 'TRAM') return { v0Factor: rng.range(0.9, 0.95), aMax: 1.0, bComf: 1.5, headway: 2.0, minGap: 3 };
  if (isTransitKind(kind)) return { v0Factor: rng.range(0.82, 0.9), aMax: 1.1, bComf: 2.2, headway: 1.5, minGap: 2.5 };
  return {
    v0Factor: rng.range(0.88, 1.08),
    aMax: rng.range(1.6, 2.4),
    bComf: rng.range(2.6, 3.4),
    headway: rng.range(1.0, 1.5),
    minGap: rng.range(1.8, 2.6),
  };
}

/** Tram lengths: CAF Urbos 3 (long) and Tatra KT4. */
const TRAM_LONG = 33;
const TRAM_SHORT = 19;

/** `long` picks the long tram (CAF Urbos 3) over the Tatra KT4. */
export function makeVehicle(id: string, kind: VehicleKind, rng: Rng, long = false): Vehicle {
  return {
    id,
    kind,
    length:
      kind === 'TRAM' ? (long ? TRAM_LONG : TRAM_SHORT) : kind === 'BUS' || kind === 'TROLLEY' ? 12 : kind === 'MINIBUS' ? 7.5 : kind === 'TAXI' ? 4.6 : rng.range(4.1, 4.9),
    drv: makeDriver(rng, kind),
    mode: 'parked',
    lane: -1,
    conn: -1,
    s: 0,
    speed: 0,
    acc: 0,
    path: [],
    pathIdx: 0,
    stop: null,
    committed: -1,
    lateral: 0,
    lateralTarget: 0,
    // A tram stops on its track.
    pullOffset: kind === 'TRAM' ? 0 : isTransitKind(kind) ? 3.1 : 2.5,
    yard: null,
    yardEnd: 'parked',
    yardEndS: 0,
    pose: { x: 0, z: 0, heading: 0 },
    arrived: false,
    pathEnded: false,
    yardDone: false,
    wantsDepart: false,
    straightPreference: rng.chance(0.55) ? 1 : 0,
    odometer: 0,
    stoppedFor: 0,
  };
}

export class TrafficSystem {
  readonly vehicles: Vehicle[] = [];
  readonly signals: (SignalRuntime | null)[];
  signalStates: (SignalState | null)[];
  private occ: OccEntry[][];
  /** Lanes with entries in occ: only these are cleared and sorted on the next rebuild. */
  private occupied: number[] = [];
  private connBusy: Int16Array;
  t = 0;

  constructor(readonly city: City) {
    this.signals = city.nodes.map((n) => (n.signal ? { plan: { phases: n.signal.phases.map((p) => ({ ...p })), offset: n.signal.offset }, mode: 'AUTO' as LightMode, holdPhase: 0 } : null));
    this.signalStates = this.signals.map((s) => (s ? signalState(s, 0) : null));
    this.occ = city.lanes.map(() => []);
    this.connBusy = new Int16Array(city.connectors.length);
  }

  add(v: Vehicle) {
    this.vehicles.push(v);
  }

  remove(v: Vehicle) {
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
  }

  // ───────────────────────────── planning ─────────────────────────────

  /** Builds a path from the vehicle's current lane to a curb point (or to the end of a target segment). */
  planTo(v: Vehicle, target: CurbRef | { seg: number }, extraCost?: (segId: number) => number): boolean {
    const { city } = this;
    const startLane = this.currentLane(v);
    if (startLane < 0) return false;
    const lane = city.lanes[startLane]!;
    const startS = v.mode === 'lane' || v.mode === 'pulled' ? v.s : 0;
    const targetSeg = 'seg' in target ? target.seg : city.lanes[target.lane]!.seg;
    const targetLane = 'seg' in target ? -1 : target.lane;
    let segs: number[] | null;
    if (lane.seg === targetSeg && (targetLane === startLane || targetLane < 0) && ('seg' in target || target.s > startS + 6)) {
      segs = [lane.seg];
    } else {
      segs = routeSegments(city, lane.seg, lane.index, targetSeg, extraCost ? (seg) => extraCost(seg.id) : undefined, isTransitKind(v.kind), targetLane);
    }
    if (!segs) return false;
    const idx = laneIndexesFor(city, segs, v.straightPreference, targetLane >= 0 ? 'curb' : 'any');
    const rest = chooseLanes(city, segs, startLane, segs.length > 1 ? targetLane : -1, idx);
    if (!rest) return false;
    v.path = [{ lane: startLane, conn: v.mode === 'conn' ? v.conn : -1 }, ...rest];
    v.pathIdx = 0;
    v.stop = targetLane >= 0 && 's' in target ? { lane: targetLane, s: target.s } : null;
    v.pathEnded = false;
    v.arrived = false;
    v.committed = -1;
    return true;
  }

  /**
   * Road distance between two curb points along the route a car would take
   * (rest of the start lane, junction connectors, whole lanes, part of the last lane).
   */
  routeDistance(from: CurbRef, to: CurbRef): number | null {
    const { city } = this;
    const start = city.lanes[from.lane]!;
    const end = city.lanes[to.lane]!;
    if (from.lane === to.lane && to.s > from.s + 6) return to.s - from.s;
    const segs = routeSegments(city, start.seg, start.index, end.seg, undefined, false, to.lane);
    if (!segs) return null;
    const steps = chooseLanes(city, segs, from.lane, to.lane, laneIndexesFor(city, segs, 0, 'curb'));
    if (!steps) return null;
    let meters = start.length - from.s;
    steps.forEach((step, i) => {
      meters += city.connectors[step.conn]!.line.length + (i === steps.length - 1 ? to.s : city.lanes[step.lane]!.length);
    });
    return meters;
  }

  /** Appends a route continuing from the last lane of the current path (used for loops and endless trips). */
  extendTo(v: Vehicle, targetSeg: number): boolean {
    const { city } = this;
    const last = v.path[v.path.length - 1];
    if (!last) return false;
    const lane = city.lanes[last.lane]!;
    const segs = routeSegments(city, lane.seg, lane.index, targetSeg, undefined, isTransitKind(v.kind));
    if (!segs) return false;
    const rest = chooseLanes(city, segs, last.lane, -1, laneIndexesFor(city, segs, v.straightPreference, 'any'));
    if (!rest) return false;
    v.path.push(...rest);
    v.pathEnded = false;
    return true;
  }

  /** Lane the vehicle is on, or entering when inside a junction. */
  currentLane(v: Vehicle): number {
    if (v.mode === 'conn') return this.city.connectors[v.conn]!.to;
    if (v.mode === 'lane' || v.mode === 'pulled') return v.lane;
    return -1;
  }

  placeOnLane(v: Vehicle, laneId: number, s: number, pulled = false) {
    v.mode = pulled ? 'pulled' : 'lane';
    v.lane = laneId;
    v.conn = -1;
    v.s = s;
    v.speed = 0;
    v.lateral = pulled ? v.pullOffset : 0;
    v.lateralTarget = v.lateral;
    v.path = [{ lane: laneId, conn: -1 }];
    v.pathIdx = 0;
    v.stop = null;
    v.committed = -1;
    this.updatePose(v);
  }

  park(v: Vehicle, pose: Pose) {
    v.mode = 'parked';
    v.lane = -1;
    v.conn = -1;
    v.speed = 0;
    v.path = [];
    v.stop = null;
    v.pose = { ...pose };
  }

  startYard(v: Vehicle, points: Vec2[], end: 'parked' | 'pulled', endLane = -1, endS = 0) {
    v.mode = 'yard';
    v.yard = polyline(points);
    v.yardEnd = end;
    v.s = 0;
    v.speed = Math.min(v.speed, YARD_SPEED);
    v.yardDone = false;
    v.lane = endLane;
    v.conn = -1;
    v.path = endLane >= 0 ? [{ lane: endLane, conn: -1 }] : [];
    v.pathIdx = 0;
    v.stop = null;
    v.lateral = end === 'pulled' ? v.pullOffset : 0;
    v.lateralTarget = v.lateral;
    v.yardEndS = endS;
  }

  /** Free curb space check before a pulled-over vehicle merges back. */
  private canMerge(v: Vehicle): boolean {
    if (v.pullOffset === 0) return true;
    for (const e of this.occ[v.lane]!) {
      if (e.v === v) continue;
      if (e.pos > v.s - 16 && e.pos - e.v.length < v.s + 4) return false;
    }
    return true;
  }

  /**
   * No vehicle on the lane (driving, pulled over or turning into it) with its body within `room` metres of `s`,
   * nor on a lane lying on top of it there.
   */
  isLaneFree(laneId: number, s: number, room: number, twins = true): boolean {
    for (const o of this.vehicles) {
      let front: number;
      if ((o.mode === 'lane' || o.mode === 'pulled') && o.lane === laneId) front = o.s;
      else if (o.mode === 'conn' && this.city.connectors[o.conn]!.to === laneId) front = o.s - this.city.connectors[o.conn]!.line.length;
      else continue;
      if (front > s - room && front - o.length < s + room) return false;
    }
    if (!twins) return true;
    for (const t of this.city.lanes[laneId]!.twins ?? []) {
      if (s + room >= t.s0 && s - room <= t.s1 && !this.isLaneFree(t.lane, twinPos(t, s), room, false)) return false;
    }
    return true;
  }

  isLaneStartFree(laneId: number, room: number): boolean {
    for (const e of this.occ[laneId]!) if (e.pos - e.v.length < room && e.pos > -2) return false;
    return true;
  }

  // ───────────────────────────── simulation step ─────────────────────────────

  step(dt: number) {
    this.t += dt;
    for (let i = 0; i < this.signals.length; i++) {
      const sig = this.signals[i];
      if (sig) this.signalStates[i] = signalState(sig, this.t);
    }
    this.rebuildOccupancy();
    const accs = new Float64Array(this.vehicles.length);
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i]!;
      if (v.mode === 'lane' || v.mode === 'conn') accs[i] = this.accelerationOf(v);
    }
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i]!;
      if (v.mode === 'lane' || v.mode === 'conn') this.integrate(v, accs[i]!, dt);
      else if (v.mode === 'yard') this.integrateYard(v, dt);
      else if (v.mode === 'pulled' && v.wantsDepart && Math.abs(v.lateral - v.lateralTarget) < 0.05) {
        if (this.canMerge(v)) {
          v.mode = 'lane';
          v.wantsDepart = false;
          v.lateralTarget = 0;
        }
      }
      if (v.lateral !== v.lateralTarget) {
        const d = v.lateralTarget - v.lateral;
        const stepL = Math.sign(d) * Math.min(Math.abs(d), 1.7 * dt);
        v.lateral += stepL;
      }
      v.stoppedFor = v.speed < 0.3 && (v.mode === 'lane' || v.mode === 'conn') ? v.stoppedFor + dt : 0;
      this.updatePose(v);
    }
  }

  private rebuildOccupancy() {
    const { city } = this;
    for (const lane of this.occupied) this.occ[lane]!.length = 0;
    this.occupied.length = 0;
    this.connBusy.fill(0);
    for (const v of this.vehicles) {
      // A tram at its stop stands in the lane (no pull to the kerb): it still blocks the lane.
      if (v.mode === 'lane' || (v.mode === 'pulled' && v.pullOffset === 0)) {
        this.occupy(v.lane, v, v.s);
        if (v.mode === 'lane' && v.committed >= 0) this.connBusy[v.committed]!++;
        // The tail of a tram is still in the junction it came through. Shorter vehicles do not hold it:
        // on chains of 2–3 m lanes (Slavija) every car would, and the holds lock into cycles.
        const step = v.path[v.pathIdx];
        if (v.length > LONG_TAIL && v.s < v.length && step && step.lane === v.lane && step.conn >= 0) this.connBusy[step.conn]!++;
      } else if (v.mode === 'conn') {
        const c = city.connectors[v.conn]!;
        this.occupy(c.to, v, v.s - c.line.length);
        this.occupy(c.from, v, city.lanes[c.from]!.length + v.s);
        this.connBusy[v.conn]!++;
      }
    }
    for (const lane of this.occupied) {
      const list = this.occ[lane]!;
      if (list.length > 1) list.sort((a, b) => a.pos - b.pos);
    }
  }

  /** Puts a vehicle on a lane's occupancy list, and a ghost of it on every twin lane its body overlaps. */
  private occupy(laneId: number, v: Vehicle, pos: number, ghosts = true) {
    const list = this.occ[laneId]!;
    if (!list.length) this.occupied.push(laneId);
    list.push({ v, pos });
    if (!ghosts) return;
    for (const t of this.city.lanes[laneId]!.twins ?? []) {
      if (pos >= t.s0 && pos - v.length <= t.s1) this.occupy(t.lane, v, twinPos(t, pos), false);
    }
  }

  /** Nearest vehicle ahead of `pos` on a lane's occupancy list. */
  private leaderOn(laneId: number, pos: number, self: Vehicle): OccEntry | null {
    const list = this.occ[laneId]!;
    for (const e of list) if (e.v !== self && e.pos > pos + 0.01) return e;
    return null;
  }

  private accelerationOf(v: Vehicle): number {
    const { city } = this;
    const step = v.path[v.pathIdx]!;
    const lane = city.lanes[step.lane]!;
    const next = v.path[v.pathIdx + 1];
    const seg = city.segments[lane.seg]!;
    let gap = Infinity;
    let leaderSpeed = 0;
    const consider = (g: number, ls: number) => {
      if (g < gap) {
        gap = g;
        leaderSpeed = ls;
      }
    };

    let pos: number;
    let v0: number;
    if (v.mode === 'conn') {
      const c = city.connectors[v.conn]!;
      pos = v.s - c.line.length;
      v0 = c.vmax * v.drv.v0Factor;
      const fromPos = city.lanes[c.from]!.length + v.s;
      const lf = this.leaderOn(c.from, fromPos, v);
      if (lf) consider(lf.pos - lf.v.length - fromPos, lf.v.speed);
    } else {
      pos = v.s;
      v0 = seg.speed * v.drv.v0Factor;
    }
    const leader = this.leaderOn(step.lane, pos, v);
    if (leader) consider(leader.pos - leader.v.length - pos, leader.v.speed);

    const toEnd = lane.length - pos;
    if (!next) v.pathEnded = true;
    if (next && (!leader || leader.pos > lane.length)) {
      const c = city.connectors[next.conn]!;
      const nl = this.occ[next.lane]![0];
      if (nl && nl.v !== v) consider(toEnd + c.line.length + nl.pos - nl.v.length, nl.v.speed);
      // Slow down for the turn ahead.
      v0 = Math.min(v0, Math.sqrt(c.vmax * c.vmax + 2 * v.drv.bComf * Math.max(0, toEnd)));
      if (v.mode === 'lane' && v.committed !== next.conn && toEnd < Math.max(45, (v.speed * v.speed) / (2 * v.drv.bComf) + 15)) {
        const open = this.gateOpen(v, c, toEnd);
        if (open) {
          if (toEnd < Math.max(2.5, v.speed * 1.3 + 1.5)) v.committed = c.id;
        } else {
          consider(toEnd - 0.6 + v.drv.minGap, 0);
        }
      }
    }
    if (v.mode === 'lane' && v.stop && v.stop.lane === step.lane && v.stop.s >= pos - 1) {
      consider(v.stop.s - pos + v.drv.minGap, 0);
    }
    if (v.mode === 'lane' && !next && !(v.stop && v.stop.lane === step.lane)) {
      consider(toEnd - 1 + v.drv.minGap, 0);
    }
    return idm(v, v0, gap, leaderSpeed);
  }

  /** May the vehicle enter junction connector `c` now? */
  private gateOpen(v: Vehicle, c: Connector, toLine: number): boolean {
    const { city } = this;
    const node = city.nodes[c.node]!;
    const state = this.signalStates[node.id];
    const flashing = isFlashing(state);
    if (state && !flashing) {
      const aspect = state.aspects[c.phase];
      if (aspect === 'AMBER') {
        const stopDist = (v.speed * v.speed) / (2 * v.drv.bComf);
        if (stopDist < toLine - 1) return false;
      } else if (aspect !== 'GREEN') return false;
    }
    // Something already in (or committed to) a crossing path.
    for (const k of c.conflicts) if (this.connBusy[k]! > 0) return false;
    // Do not block the box: a queue reaching back to the exit.
    for (const e of this.occ[c.to]!) {
      if (e.pos - e.v.length < v.length + 2 && e.pos > -1 && e.v.speed < 2) return false;
    }
    // After a long wait at the line a driver stops yielding to traffic that is not actually moving
    // in (crossing paths are still checked above): breaks mutual-yield deadlocks.
    if (v.stoppedFor > IMPATIENCE) return true;
    if (flashing) {
      const myRank = city.segments[city.lanes[c.from]!.seg]!.rank;
      if (this.approachingConflict(v, node.in, c, (seg) => seg.rank > myRank, 32)) return false;
      if (c.turn === 'L' && this.approachingOpposite(v, node.in, c, 30)) return false;
    } else if (c.turn === 'L' && this.approachingOpposite(v, node.in, c, 40)) {
      return false;
    }
    return true;
  }

  /** Vehicles close to the stop line on matching approaches whose next connector crosses `c`. */
  private approachingConflict(self: Vehicle, inSegs: number[], c: Connector, filter: (seg: Segment) => boolean, range: number) {
    const { city } = this;
    for (const segId of inSegs) {
      const seg = city.segments[segId]!;
      if (!filter(seg)) continue;
      if (this.anyApproaching(self, seg.lanes, c, range, false)) return true;
    }
    return false;
  }

  private approachingOpposite(self: Vehicle, inSegs: number[], c: Connector, range: number) {
    const { city } = this;
    const myDir = city.segments[city.lanes[c.from]!.seg]!.dirOut;
    for (const segId of inSegs) {
      const seg = city.segments[segId]!;
      if (dot(seg.dirOut, myDir) > -0.8) continue;
      // Opposing left turners do not yield to each other (they turn simultaneously).
      if (this.anyApproaching(self, seg.lanes, c, range, true)) return true;
    }
    return false;
  }

  /** Another vehicle (`self` may show up as a ghost on a twin lane) about to take a move that crosses `c`. */
  private anyApproaching(self: Vehicle, lanes: number[], c: Connector, range: number, ignoreLeftTurners: boolean) {
    const { city } = this;
    for (const laneId of lanes) {
      const lane = city.lanes[laneId]!;
      for (const e of this.occ[laneId]!) {
        if (e.v === self || e.pos > lane.length || e.v.mode !== 'lane') continue;
        const d = lane.length - e.pos;
        if (d > range) continue;
        if (e.v.speed < 1.2 && d > 6) continue;
        const theirNext = e.v.path[e.v.pathIdx + 1];
        if (!theirNext) continue;
        const theirs = city.connectors[theirNext.conn]!;
        if (ignoreLeftTurners && theirs.turn === 'L') continue;
        if (theirs.to === c.to || c.conflicts.includes(theirs.id)) {
          // Opposing traffic held by a red light does not count.
          const st = this.signalStates[theirs.node];
          if (st && !isFlashing(st)) {
            const asp = st.aspects[theirs.phase];
            if (asp !== 'GREEN' && asp !== 'AMBER') continue;
          }
          return true;
        }
      }
    }
    return false;
  }

  private integrate(v: Vehicle, a: number, dt: number) {
    const { city } = this;
    v.acc = a;
    const nv = Math.max(0, v.speed + a * dt);
    const ds = ((v.speed + nv) / 2) * dt;
    v.speed = nv;
    v.s += ds;
    v.odometer += ds;
    if (v.mode === 'lane') {
      const lane = city.lanes[v.lane]!;
      if (v.stop && v.stop.lane === v.lane && v.s >= v.stop.s - 1.2 && v.speed < 0.8) {
        v.mode = 'pulled';
        v.speed = 0;
        v.lateralTarget = v.pullOffset;
        v.arrived = true;
        v.stop = null;
        return;
      }
      if (v.s >= lane.length) {
        const next = v.path[v.pathIdx + 1];
        if (next && (v.committed === next.conn || this.gateOpen(v, city.connectors[next.conn]!, 0))) {
          v.mode = 'conn';
          v.conn = next.conn;
          v.s -= lane.length;
          v.pathIdx++;
          v.committed = -1;
        } else {
          v.s = lane.length - 0.01;
          v.speed = 0;
          if (!next) v.pathEnded = true;
        }
      }
    } else if (v.mode === 'conn') {
      const c = city.connectors[v.conn]!;
      if (v.s >= c.line.length) {
        v.mode = 'lane';
        v.s -= c.line.length;
        v.lane = c.to;
        v.conn = -1;
        // Keep the consumed prefix short.
        if (v.pathIdx > 8) {
          v.path.splice(0, v.pathIdx);
          v.pathIdx = 0;
        }
      }
    }
  }

  private integrateYard(v: Vehicle, dt: number) {
    const line = v.yard!;
    const remaining = line.length - v.s;
    const target = remaining < 6 ? Math.max(0.8, remaining * 0.5) : YARD_SPEED;
    v.speed += Math.sign(target - v.speed) * Math.min(Math.abs(target - v.speed), 1.5 * dt);
    v.s += v.speed * dt;
    v.odometer += v.speed * dt;
    if (v.s >= line.length) {
      const end = poseAt(line, line.length);
      v.yard = null;
      v.speed = 0;
      v.yardDone = true;
      if (v.yardEnd === 'parked') {
        v.mode = 'parked';
        v.pose = { x: end.x, z: end.z, heading: v.pose.heading };
      } else {
        v.mode = 'pulled';
        v.s = v.yardEndS;
      }
    }
  }

  private updatePose(v: Vehicle) {
    const { city } = this;
    if (v.mode === 'parked') return;
    if (v.mode === 'yard') {
      const p = poseAt(v.yard!, Math.max(0, v.s - v.length / 2));
      v.pose = p;
      return;
    }
    const half = v.length / 2;
    if (v.mode === 'conn') {
      const c = city.connectors[v.conn]!;
      const sc = v.s - half;
      if (sc >= 0) {
        v.pose = poseAt(c.line, sc);
        return;
      }
      v.pose = lanePose(city.lanes[c.from]!, city.lanes[c.from]!.length + sc, 0);
      return;
    }
    const lane = city.lanes[v.lane]!;
    const p = lanePose(lane, v.s - half, v.lateral);
    // Slight yaw while pulling over / merging.
    const dLat = v.lateralTarget - v.lateral;
    if (Math.abs(dLat) > 0.05) p.heading += Math.sign(dLat) * -0.18 * Math.min(1, Math.abs(dLat));
    v.pose = p;
  }

  // ───────────────────────────── queries ─────────────────────────────

  /** Remaining route as a polyline from the vehicle to its stop (or path end). */
  routeOf(v: Vehicle): { points: Vec2[]; meters: number } {
    const { city } = this;
    const pts: Vec2[] = [{ x: v.pose.x, z: v.pose.z }];
    let meters = 0;
    if (v.mode !== 'lane' && v.mode !== 'conn' && v.mode !== 'pulled') return { points: pts, meters };
    const push = (p: Vec2) => {
      const last = pts[pts.length - 1]!;
      meters += Math.hypot(p.x - last.x, p.z - last.z);
      pts.push(p);
    };
    for (let i = v.pathIdx; i < v.path.length; i++) {
      const step = v.path[i]!;
      if (i > v.pathIdx || v.mode === 'conn') {
        const c = city.connectors[step.conn]!;
        const startAt = i === v.pathIdx && v.mode === 'conn' ? v.s : 0;
        for (let k = 0; k < c.line.points.length; k++) if ((c.line.cum[k] ?? 0) >= startAt) push(c.line.points[k]!);
      }
      if (v.stop && v.stop.lane === step.lane && i >= v.pathIdx) {
        push(lanePoint(city, step.lane, v.stop.s, v.pullOffset * 0.6));
        break;
      }
      push(city.lanes[step.lane]!.end);
    }
    return { points: pts, meters };
  }

  queueOn(segIds: number[]): number {
    let n = 0;
    for (const segId of segIds) {
      for (const laneId of this.city.segments[segId]!.lanes) {
        const lane = this.city.lanes[laneId]!;
        for (const e of this.occ[laneId]!) if (e.v.speed < 0.6 && lane.length - e.pos < 80 && e.v.mode === 'lane') n++;
      }
    }
    return n;
  }

  vehiclesOnSegment(segId: number): number {
    let n = 0;
    for (const laneId of this.city.segments[segId]!.lanes) n += this.occ[laneId]!.length;
    return n;
  }

  turnAhead(v: Vehicle) {
    const next = v.path[v.pathIdx + 1];
    if (!next) return null;
    const a = this.city.segments[this.city.lanes[v.path[v.pathIdx]!.lane]!.seg]!;
    const b = this.city.segments[this.city.lanes[next.lane]!.seg]!;
    return turnBetween(a, b);
  }
}

function lanePose(lane: Lane, s: number, lateral: number): Pose {
  return poseAlong(lane.line, s, lateral);
}

/** Intelligent Driver Model. */
function idm(v: Vehicle, v0: number, gap: number, leaderSpeed: number): number {
  const { aMax, bComf, headway, minGap } = v.drv;
  const speed = v.speed;
  const free = 1 - Math.pow(speed / Math.max(0.1, v0), 4);
  if (!Number.isFinite(gap)) return Math.max(-9, Math.min(aMax, aMax * free));
  const dv = speed - leaderSpeed;
  const sStar = minGap + Math.max(0, speed * headway + (speed * dv) / (2 * Math.sqrt(aMax * bComf)));
  const g = Math.max(0.1, gap);
  const a = aMax * (free - (sStar / g) * (sStar / g));
  return Math.max(-9, Math.min(aMax, a));
}

