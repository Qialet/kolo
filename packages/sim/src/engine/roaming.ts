import type { City } from '../city/types.js';
import type { Rng } from '../rng.js';
import { makeVehicle, type TrafficSystem, type Vehicle } from './traffic.js';

/** Share of trips that head for an exit of the map rather than somewhere inside it. */
const LEAVE_SHARE = 0.5;
/** A car this close to the end of an exit lane has left the map. */
const EXIT_ROOM = 8;

/**
 * Background traffic on a district map: cars enter at the frame, drive to random places in the core
 * network or to an exit, and disappear when they leave the frame.
 */
export class Roaming {
  readonly cars = new Set<Vehicle>();
  onEnter?: (v: Vehicle) => void;
  onLeave?: (v: Vehicle) => void;
  /** A car removed inside the map (no route on, or density lowered). */
  onVanish?: (v: Vehicle) => void;
  private readonly city: City;
  private readonly entries: number[];
  private readonly exits: number[];
  private readonly core: number[];
  private readonly exitSegs: Set<number>;
  private seq = 0;

  constructor(
    private readonly traffic: TrafficSystem,
    private readonly rng: Rng,
  ) {
    const city = (this.city = traffic.city);
    const drivable = city.segments.filter((s) => !s.psvOnly);
    this.entries = drivable.filter((s) => city.nodes[s.from]!.boundary).flatMap((s) => s.lanes);
    this.exits = drivable.filter((s) => city.nodes[s.to]!.boundary).map((s) => s.id);
    this.core = drivable.filter((s) => s.core).map((s) => s.id);
    this.exitSegs = new Set(this.exits);
  }

  /** Brings the car count towards `target`: anywhere on the map at start-up, then at frame entries. */
  update(target: number, initial = false) {
    let attempts = 0;
    while (this.cars.size < target && attempts++ < (initial ? target * 20 : 6)) {
      const laneId = initial ? this.rng.pick(this.city.lanes).id : this.rng.pick(this.entries);
      const lane = this.city.lanes[laneId]!;
      if (this.city.segments[lane.seg]!.psvOnly) continue;
      const s = initial ? this.rng.range(Math.min(6, lane.length / 2), Math.max(Math.min(6, lane.length / 2), lane.length - 10)) : 1;
      if (initial ? !this.traffic.isLaneFree(laneId, s, 14) : !this.traffic.isLaneStartFree(laneId, 9)) continue;
      const v = makeVehicle(`C${++this.seq}`, 'CAR', this.rng);
      this.traffic.placeOnLane(v, laneId, s);
      v.speed = this.city.segments[lane.seg]!.speed * 0.5;
      if (!this.route(v)) continue;
      this.traffic.add(v);
      this.cars.add(v);
      if (!initial) this.onEnter?.(v);
    }
    // Over target (density lowered): let cars leave when their trip ends instead of vanishing.
  }

  /** Retires cars that drove out of the frame and gives the others a new trip. */
  step(target = Infinity) {
    for (const v of this.cars) {
      if (!v.pathEnded) continue;
      // Inside a junction the vehicle's lane is still the one it came from: use the lane it enters.
      const lane = this.city.lanes[this.traffic.currentLane(v)];
      if (lane && this.exitSegs.has(lane.seg)) {
        if (v.mode === 'lane' && v.s >= lane.length - EXIT_ROOM) this.retire(v, true);
        continue;
      }
      if (this.cars.size > target) {
        if (v.speed < 0.5) this.retire(v, false);
        continue;
      }
      if (!this.route(v)) this.retire(v, false);
    }
  }

  private retire(v: Vehicle, left: boolean) {
    this.cars.delete(v);
    this.traffic.remove(v);
    if (left) this.onLeave?.(v);
    else this.onVanish?.(v);
  }

  /** A new trip from where the car is; outside the core only the exits may be reachable. */
  private route(v: Vehicle) {
    for (let k = 0; k < 4; k++) if (this.traffic.extendTo(v, this.destination())) return true;
    for (let k = 0; k < 8 && this.exits.length; k++) if (this.traffic.extendTo(v, this.rng.pick(this.exits))) return true;
    return false;
  }

  private destination() {
    return this.rng.chance(LEAVE_SHARE) && this.exits.length ? this.rng.pick(this.exits) : this.rng.pick(this.core);
  }
}
