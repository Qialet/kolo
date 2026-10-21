import {
  ACTIVE_ORDER_STATUSES,
  LIGHT_ASPECTS,
  TAXI_ACTIVITIES,
  VEHICLE_KINDS,
  type Actor,
  type BusDetail,
  type FleetStatus,
  type LightControlInput,
  type LightDetail,
  type LiveEvent,
  type LiveEventSeverity,
  type LightTuple,
  type LiveFrame,
  type LiveKpi,
  type OrderEventType,
  type OrderSource,
  type OrderStatus,
  type OrderSummary,
  type PlaceRef,
  type SimControlInput,
  type TaxiActivity,
  type TaxiDetail,
} from '@kolo/contracts';
import { lanePoint } from '../city/build.js';
import type { BusLine, City, CurbRef, Depot, Slot } from '../city/types.js';
import { dist, type Vec2 } from '../geometry.js';
import { createRng, type Rng } from '../rng.js';
import { CANCEL_REASONS_PASSENGER, DISPUTE_REASONS, passengerName } from './names.js';
import { cycleOf, signalState } from './signals.js';
import { makeVehicle, TrafficSystem, type Vehicle } from './traffic.js';

export interface FleetVehicleSeed {
  id: string;
  plate: string;
  model: string;
  parkId: string;
  parkName: string;
  fleetStatus: FleetStatus;
  driverName: string | null;
  driverRating: number | null;
}

export interface Place extends CurbRef {
  id: string;
  label: string;
  x: number;
  z: number;
}

export interface SimOrderEvent {
  type: OrderEventType;
  actor: Actor;
  note: string | null;
  vehicleId: string | null;
  x: number | null;
  z: number | null;
  at: number;
}

export interface SimHooks {
  onOrderCreated?(order: OrderSummary, source: OrderSource): void;
  onOrderEvent?(order: OrderSummary, event: SimOrderEvent, extra: { cancelReason?: string }): void;
  onFleetStatus?(vehicleId: string, status: FleetStatus, actor: Actor): void;
  onLiveEvent?(event: LiveEvent): void;
  onDisputeOpened?(orderId: string, reason: string): void;
}

export interface SimulationOptions {
  seed?: number;
  /** 0..1 share of the maximum background car count. */
  trafficDensity?: number;
  /** Order rate multiplier. */
  demand?: number;
  /** Last used order number, so codes stay unique across restarts. */
  lastOrderNumber?: number;
  hooks?: SimHooks;
}

interface Taxi {
  v: Vehicle;
  info: FleetVehicleSeed;
  fleetStatus: FleetStatus;
  activity: TaxiActivity;
  depot: Depot;
  slot: number;
  box: number;
  orderId: string | null;
  offerFor: string | null;
  target: Place | null;
  waitUntil: number;
  pending: FleetStatus | null;
  trips: number;
  earnings: number;
  /** Lifecycle automation (repairs, shifts) applies until a dispatcher takes manual control. */
  auto: boolean;
  repairUntil: number;
  idleSince: number;
}

interface Bus {
  v: Vehicle;
  line: BusLine;
  /** Index into line.segments of the last segment appended to the path. */
  cursor: number;
  dwellUntil: number;
  lastStop: string | null;
  passengers: number;
}

interface SimOrder {
  id: string;
  code: string;
  status: OrderStatus;
  source: OrderSource;
  passengerName: string;
  pickup: Place;
  dropoff: Place;
  vehicleId: string | null;
  createdAt: number;
  tried: Set<string>;
  offer: { taxiId: string; decideAt: number; accept: boolean } | null;
  assignedAt: number;
  arrivedAt: number;
  passengerAt: number;
  noShowAt: number;
  cancelAt: number;
  completeAt: number;
  pickedAt: number;
  pickOdo: number;
  estDistance: number;
  fareRsd: number;
  finishedAt: number;
}

/** Web Crypto is global in both Node and browsers; the package targets neither lib explicitly. */
declare const crypto: { randomUUID(): string };

const MAX_CARS = 110;
const BASE_ORDERS_PER_MIN = 3.2;
const FARE = { start: 230, perKm: 95, perMin: 18 };
const SUBSTEP = 0.05;

export class Simulation {
  readonly traffic: TrafficSystem;
  readonly taxis = new Map<string, Taxi>();
  readonly buses = new Map<string, Bus>();
  readonly cars = new Set<Vehicle>();
  readonly orders = new Map<string, SimOrder>();
  private readonly rng: Rng;
  private readonly hooks: SimHooks;
  private readonly places = new Map<string, Place>();
  private readonly hotspots: Place[] = [];
  private readonly slotUse = new Map<string, (string | null)[]>();
  private readonly boxUse = new Map<string, (string | null)[]>();
  private carSeq = 0;
  private orderSeq = 10000;
  private eventSeq = 0;
  private dispatchClock = 0;
  private recentPickupEtas: number[] = [];
  private stats = { completed: 0, cancelled: 0, noShow: 0, expired: 0, openDisputes: 0, revenue: 0 };
  speed = 1;
  paused = false;
  trafficDensity: number;
  demand: number;

  constructor(
    readonly city: City,
    fleet: FleetVehicleSeed[],
    opts: SimulationOptions = {},
  ) {
    this.rng = createRng(opts.seed ?? 7);
    this.hooks = opts.hooks ?? {};
    this.trafficDensity = opts.trafficDensity ?? 0.6;
    this.demand = opts.demand ?? 1;
    this.orderSeq = Math.max(10000, opts.lastOrderNumber ?? 0);
    this.traffic = new TrafficSystem(city);
    for (const a of city.addresses) this.places.set(a.id, { id: a.id, label: a.label, lane: a.lane, s: a.s, x: a.x, z: a.z });
    for (const st of city.busStops) {
      this.places.set(st.id, { id: st.id, label: `Остановка «${st.name}»`, lane: st.lane, s: Math.max(8, st.s - 20), x: st.x, z: st.z });
    }
    for (const poi of city.pois) this.hotspots.push(this.places.get(poi.addressId)!);
    for (const st of city.busStops) this.hotspots.push(this.places.get(st.id)!);
    for (const d of city.depots) {
      this.slotUse.set(d.id, d.slots.map(() => null));
      this.boxUse.set(d.id, d.boxes.map(() => null));
    }
    this.spawnFleet(fleet);
    this.spawnBuses();
    this.adjustCars(true);
  }

  // ───────────────────────────── setup ─────────────────────────────

  private spawnFleet(fleet: FleetVehicleSeed[]) {
    const used = new Set<string>();
    for (const info of fleet) {
      const depot = this.city.depots.find((d) => d.id === info.parkId) ?? this.city.depots[0]!;
      const v = makeVehicle(info.id, 'TAXI', this.rng);
      const taxi: Taxi = {
        v,
        info,
        fleetStatus: info.fleetStatus,
        activity: 'PARKED',
        depot,
        slot: -1,
        box: -1,
        orderId: null,
        offerFor: null,
        target: null,
        waitUntil: 0,
        pending: null,
        trips: 0,
        earnings: 0,
        auto: true,
        repairUntil: 0,
        idleSince: 0,
      };
      this.taxis.set(info.id, taxi);
      this.traffic.add(v);
      if (info.fleetStatus === 'ON_LINE') {
        // Start already on the street, waiting at a random curb.
        let addr = this.rng.pick(this.city.addresses);
        for (let i = 0; i < 20 && used.has(`${addr.lane}:${Math.round(addr.s / 15)}`); i++) addr = this.rng.pick(this.city.addresses);
        used.add(`${addr.lane}:${Math.round(addr.s / 15)}`);
        this.traffic.placeOnLane(v, addr.lane, addr.s, true);
        taxi.activity = 'FREE';
        taxi.waitUntil = this.rng.range(2, 25);
      } else if (info.fleetStatus === 'MAINTENANCE' && this.claim(this.boxUse, depot.id, taxi.info.id) >= 0) {
        taxi.box = this.boxUse.get(depot.id)!.indexOf(info.id);
        const box = depot.boxes[taxi.box]!;
        this.traffic.park(v, { x: box.x, z: box.z, heading: box.heading });
        taxi.activity = 'IN_SERVICE';
      } else {
        taxi.slot = this.claim(this.slotUse, depot.id, info.id);
        const slot = depot.slots[Math.max(0, taxi.slot)]!;
        this.traffic.park(v, { x: slot.x, z: slot.z, heading: slot.heading + Math.PI });
        taxi.activity = info.fleetStatus === 'MAINTENANCE' ? 'IN_SERVICE' : 'PARKED';
      }
      if (taxi.activity === 'IN_SERVICE') taxi.repairUntil = this.rng.range(60, 240);
    }
  }

  private spawnBuses() {
    for (const line of this.city.busLines) {
      for (let k = 0; k < 2; k++) {
        const stopId = line.stops[Math.floor((k * line.stops.length) / 2)]!;
        const stop = this.city.busStops.find((s) => s.id === stopId)!;
        const v = makeVehicle(`BUS-${line.id}-${k + 1}`, 'BUS', this.rng);
        this.traffic.add(v);
        this.traffic.placeOnLane(v, stop.lane, stop.s, true);
        const seg = this.city.lanes[stop.lane]!.seg;
        const bus: Bus = { v, line, cursor: line.segments.indexOf(seg), dwellUntil: this.rng.range(3, 14), lastStop: stop.id, passengers: this.rng.int(8, 30) };
        this.extendBus(bus, 6);
        this.buses.set(v.id, bus);
      }
    }
  }

  private extendBus(bus: Bus, count: number) {
    const segs: number[] = [];
    for (let i = 0; i < count; i++) {
      bus.cursor = (bus.cursor + 1) % bus.line.segments.length;
      segs.push(bus.line.segments[bus.cursor]!);
    }
    this.traffic.appendSegments(bus.v, segs, true);
  }

  private adjustCars(initial = false) {
    const target = Math.round(MAX_CARS * this.trafficDensity);
    let attempts = 0;
    while (this.cars.size < target && attempts++ < (initial ? 2000 : 3)) {
      const lane = this.rng.pick(this.city.lanes);
      const s = initial ? this.rng.range(8, lane.length - 12) : this.rng.range(8, 30);
      const crowded = this.traffic.vehicles.some(
        (o) => (o.mode === 'lane' || o.mode === 'pulled') && o.lane === lane.id && Math.abs(o.s - s) < 14,
      );
      if (crowded) continue;
      const v = makeVehicle(`C${++this.carSeq}`, 'CAR', this.rng);
      this.traffic.placeOnLane(v, lane.id, s);
      v.speed = this.city.segments[lane.seg]!.speed * 0.5;
      if (!this.traffic.extendTo(v, this.randomSegment())) continue;
      this.traffic.add(v);
      this.cars.add(v);
    }
  }

  private randomSegment() {
    return this.rng.int(0, this.city.segments.length - 1);
  }

  private claim(map: Map<string, (string | null)[]>, depotId: string, taxiId: string): number {
    const arr = map.get(depotId)!;
    const i = arr.indexOf(null);
    if (i >= 0) arr[i] = taxiId;
    return i;
  }

  private release(map: Map<string, (string | null)[]>, depotId: string, taxiId: string) {
    const arr = map.get(depotId)!;
    const i = arr.indexOf(taxiId);
    if (i >= 0) arr[i] = null;
  }

  // ───────────────────────────── main loop ─────────────────────────────

  /** Advances by real seconds, honouring speed and pause. */
  tick(realDt: number) {
    if (this.paused) return;
    const simDt = Math.min(realDt, 0.25) * this.speed;
    const n = Math.max(1, Math.ceil(simDt / SUBSTEP));
    for (let i = 0; i < n; i++) this.step(simDt / n);
  }

  get time() {
    return this.traffic.t;
  }

  step(dt: number) {
    this.traffic.step(dt);
    const t = this.traffic.t;
    for (const taxi of this.taxis.values()) this.updateTaxi(taxi, t);
    for (const bus of this.buses.values()) this.updateBus(bus, t);
    for (const car of this.cars) {
      if (!car.pathEnded) continue;
      if (this.cars.size > Math.round(MAX_CARS * this.trafficDensity)) {
        this.cars.delete(car);
        this.traffic.remove(car);
      } else {
        this.traffic.extendTo(car, this.randomSegment());
      }
    }
    this.dispatchClock += dt;
    if (this.dispatchClock >= 1) {
      this.dispatchClock = 0;
      this.adjustCars();
      this.updateOrders(t);
      this.maybeBreakdown();
      this.lifecycle();
    }
    if (this.rng.chance((BASE_ORDERS_PER_MIN * this.demand * dt) / 60)) this.spawnRandomOrder();
  }

  // ───────────────────────────── taxis ─────────────────────────────

  private setActivity(taxi: Taxi, activity: TaxiActivity) {
    taxi.activity = activity;
  }

  private driveTo(taxi: Taxi, place: Place): boolean {
    const ok = this.traffic.planTo(taxi.v, place, (segId) => this.traffic.vehiclesOnSegment(segId) * 0.8);
    if (!ok) return false;
    taxi.target = place;
    if (taxi.v.mode === 'pulled') taxi.v.wantsDepart = true;
    return true;
  }

  private goCruising(taxi: Taxi) {
    this.setActivity(taxi, 'FREE');
    const busy = new Map<string, number>();
    for (const o of this.taxis.values()) if (o.target && o.activity === 'FREE') busy.set(o.target.id, (busy.get(o.target.id) ?? 0) + 1);
    const candidates = this.hotspots
      .filter((h) => (busy.get(h.id) ?? 0) < 2 && h.id !== taxi.target?.id)
      .sort((a, b) => dist(a, taxi.v.pose) - dist(b, taxi.v.pose) + this.rng.range(-250, 250));
    const choice = candidates[this.rng.int(0, Math.min(3, candidates.length - 1))];
    if (!choice || !this.driveTo(taxi, choice)) taxi.waitUntil = this.traffic.t + 3;
  }

  private updateTaxi(taxi: Taxi, t: number) {
    const v = taxi.v;
    if (v.yardDone) {
      v.yardDone = false;
      if (taxi.activity === 'LEAVING_PARK') {
        if (taxi.fleetStatus === 'ON_LINE') this.goCruising(taxi);
        else this.enterDepot(taxi, taxi.fleetStatus === 'MAINTENANCE' ? 'box' : 'slot');
      } else if (taxi.activity === 'TO_PARK') {
        this.setActivity(taxi, 'PARKED');
        taxi.idleSince = this.traffic.t;
        this.event('info', `${taxi.info.plate} вернулся в парк`, taxi.depot.name, taxi.info.id);
      } else if (taxi.activity === 'TO_SERVICE') {
        this.setActivity(taxi, 'IN_SERVICE');
        taxi.repairUntil = this.traffic.t + this.rng.range(180, 360);
        this.event('warning', `${taxi.info.plate} в сервисном боксе`, taxi.depot.name, taxi.info.id);
      }
    }
    if (v.arrived) {
      v.arrived = false;
      this.onTaxiArrived(taxi, t);
    }
    if (taxi.activity === 'FREE' && v.mode === 'pulled' && !v.wantsDepart && taxi.waitUntil > 0 && t >= taxi.waitUntil && !taxi.offerFor) {
      taxi.waitUntil = 0;
      this.goCruising(taxi);
    } else if (taxi.activity === 'FREE' && v.mode === 'pulled' && taxi.waitUntil === 0 && !v.wantsDepart && !taxi.offerFor) {
      taxi.waitUntil = t + this.rng.range(30, 90);
    }
    if ((taxi.activity === 'TO_PICKUP' || taxi.activity === 'ON_TRIP' || taxi.activity === 'TO_PARK' || taxi.activity === 'TO_SERVICE' || taxi.activity === 'FREE') && v.pathEnded && !v.stop && v.mode === 'lane' && taxi.target) {
      // Lost the stop (e.g. re-planned mid-junction): plan again.
      this.driveTo(taxi, taxi.target);
    }
  }

  private onTaxiArrived(taxi: Taxi, t: number) {
    const order = taxi.orderId ? this.orders.get(taxi.orderId) : undefined;
    switch (taxi.activity) {
      case 'FREE':
        taxi.waitUntil = t + this.rng.range(30, 90);
        break;
      case 'TO_PICKUP':
        if (!order) return this.goCruising(taxi);
        this.setActivity(taxi, 'AT_PICKUP');
        order.arrivedAt = t;
        this.recentPickupEtas.push(t - order.assignedAt);
        if (this.recentPickupEtas.length > 25) this.recentPickupEtas.shift();
        if (this.rng.chance(0.07)) {
          order.noShowAt = t + 75;
        } else {
          order.passengerAt = t + this.rng.range(6, 35);
        }
        this.orderEvent(order, 'ARRIVED', 'DRIVER', 'Водитель на месте', 'ARRIVED');
        break;
      case 'ON_TRIP':
        if (order) order.completeAt = t + 5;
        break;
      case 'TO_PARK':
        this.enterDepot(taxi, 'slot');
        break;
      case 'TO_SERVICE':
        this.enterDepot(taxi, 'box');
        break;
      default:
        break;
    }
  }

  private depotCurb(depot: Depot, v: Vehicle): Vec2 {
    return lanePoint(this.city, depot.curb.lane, depot.curb.s, v.pullOffset);
  }

  private aisleOf(slot: Slot, outward: number): Vec2 {
    return { x: slot.x + Math.sin(slot.heading) * outward, z: slot.z + Math.cos(slot.heading) * outward };
  }

  /** From the curb in front of the gate into a slot or a service box. */
  private enterDepot(taxi: Taxi, kind: 'slot' | 'box') {
    const { depot, v } = taxi;
    let target: Slot | undefined;
    let aisle: Vec2;
    if (kind === 'box' && (taxi.box >= 0 || this.claim(this.boxUse, depot.id, taxi.info.id) >= 0)) {
      taxi.box = this.boxUse.get(depot.id)!.indexOf(taxi.info.id);
      target = depot.boxes[taxi.box]!;
      aisle = this.aisleOf(target, -12);
    } else {
      if (taxi.slot < 0) taxi.slot = this.claim(this.slotUse, depot.id, taxi.info.id);
      target = depot.slots[Math.max(0, taxi.slot)]!;
      aisle = this.aisleOf(target, 6);
    }
    this.setActivity(taxi, kind === 'box' ? 'TO_SERVICE' : 'TO_PARK');
    const curb = v.mode === 'pulled' ? { x: v.pose.x, z: v.pose.z } : this.depotCurb(depot, v);
    this.traffic.startYard(v, [curb, depot.gate, depot.yard, aisle, { x: target.x, z: target.z }], 'parked');
  }

  /** From a slot or box out through the gate to the curb. */
  private leaveDepot(taxi: Taxi) {
    const { depot, v } = taxi;
    let from: Slot;
    let aisle: Vec2;
    if (taxi.box >= 0) {
      from = depot.boxes[taxi.box]!;
      aisle = this.aisleOf(from, -12);
      this.release(this.boxUse, depot.id, taxi.info.id);
      taxi.box = -1;
    } else {
      from = depot.slots[Math.max(0, taxi.slot)]!;
      aisle = this.aisleOf(from, 6);
      this.release(this.slotUse, depot.id, taxi.info.id);
      taxi.slot = -1;
    }
    this.setActivity(taxi, 'LEAVING_PARK');
    this.traffic.startYard(v, [{ x: from.x, z: from.z }, aisle, depot.yard, depot.gate, this.depotCurb(depot, v)], 'pulled', depot.curb.lane, depot.curb.s);
  }

  private returnToDepot(taxi: Taxi, kind: 'slot' | 'box') {
    this.setActivity(taxi, kind === 'box' ? 'TO_SERVICE' : 'TO_PARK');
    const place: Place = { id: taxi.depot.addressId, label: taxi.depot.name, ...taxi.depot.curb, x: taxi.depot.gate.x, z: taxi.depot.gate.z };
    if (!this.driveTo(taxi, place)) this.enterDepot(taxi, kind);
  }

  private moveInsideDepot(taxi: Taxi, to: 'slot' | 'box') {
    const { depot, v } = taxi;
    const fromSlot = taxi.box >= 0 ? depot.boxes[taxi.box]! : depot.slots[Math.max(0, taxi.slot)]!;
    const fromAisle = taxi.box >= 0 ? this.aisleOf(fromSlot, -12) : this.aisleOf(fromSlot, 6);
    if (taxi.box >= 0) this.release(this.boxUse, depot.id, taxi.info.id);
    if (taxi.slot >= 0) this.release(this.slotUse, depot.id, taxi.info.id);
    taxi.box = -1;
    taxi.slot = -1;
    let target: Slot;
    let aisle: Vec2;
    if (to === 'box' && this.claim(this.boxUse, depot.id, taxi.info.id) >= 0) {
      taxi.box = this.boxUse.get(depot.id)!.indexOf(taxi.info.id);
      target = depot.boxes[taxi.box]!;
      aisle = this.aisleOf(target, -12);
    } else {
      taxi.slot = this.claim(this.slotUse, depot.id, taxi.info.id);
      target = depot.slots[Math.max(0, taxi.slot)]!;
      aisle = this.aisleOf(target, 6);
    }
    this.setActivity(taxi, to === 'box' ? 'TO_SERVICE' : 'TO_PARK');
    this.traffic.startYard(v, [{ x: fromSlot.x, z: fromSlot.z }, fromAisle, depot.yard, aisle, { x: target.x, z: target.z }], 'parked');
  }

  // ───────────────────────────── fleet control ─────────────────────────────

  setFleetStatus(vehicleId: string, status: FleetStatus, actor: Actor = 'DISPATCHER'): boolean {
    const taxi = this.taxis.get(vehicleId);
    if (!taxi) return false;
    if (actor === 'DISPATCHER') taxi.auto = status === 'ON_LINE';
    taxi.fleetStatus = status;
    this.hooks.onFleetStatus?.(vehicleId, status, actor);
    const busyWithOrder = taxi.activity === 'TO_PICKUP' || taxi.activity === 'AT_PICKUP' || taxi.activity === 'ON_TRIP';
    if (busyWithOrder && status !== 'ON_LINE') {
      taxi.pending = status;
      this.event('info', `${taxi.info.plate}: смена статуса после заказа`, labelOfStatus(status), vehicleId);
      return true;
    }
    if (taxi.offerFor) this.declineOffer(taxi, 'Водитель ушёл с линии');
    const a = taxi.activity;
    if (status === 'ON_LINE') {
      if (a === 'PARKED' || a === 'IN_SERVICE') this.leaveDepot(taxi);
      else if (a === 'TO_PARK' || a === 'TO_SERVICE') this.goCruising(taxi);
    } else if (status === 'IN_PARK') {
      if (a === 'FREE' || a === 'TO_SERVICE') this.returnToDepot(taxi, 'slot');
      else if (a === 'IN_SERVICE') this.moveInsideDepot(taxi, 'slot');
    } else if (status === 'MAINTENANCE') {
      if (a === 'FREE' || a === 'TO_PARK') this.returnToDepot(taxi, 'box');
      else if (a === 'PARKED') this.moveInsideDepot(taxi, 'box');
    }
    this.event(status === 'MAINTENANCE' ? 'warning' : 'info', `${taxi.info.plate}: ${labelOfStatus(status)}`, taxi.depot.name, vehicleId);
    return true;
  }

  /** Repairs finish, drivers pick up parked cars and end their shifts — once per sim second. */
  private lifecycle() {
    const t = this.traffic.t;
    for (const taxi of this.taxis.values()) {
      if (!taxi.auto) continue;
      if (taxi.activity === 'IN_SERVICE' && taxi.repairUntil && t >= taxi.repairUntil) {
        taxi.repairUntil = 0;
        taxi.idleSince = t;
        this.event('success', `${taxi.info.plate}: ремонт завершён`, 'Ожидает водителя в парке', taxi.info.id);
        this.setFleetStatus(taxi.info.id, 'IN_PARK', 'SYSTEM');
      } else if (taxi.activity === 'PARKED' && taxi.fleetStatus === 'IN_PARK' && t - taxi.idleSince > 90 && this.rng.chance(1 / 120)) {
        this.event('info', `${taxi.info.plate}: водитель принял смену`, taxi.depot.name, taxi.info.id);
        this.setFleetStatus(taxi.info.id, 'ON_LINE', 'SYSTEM');
      } else if (taxi.activity === 'FREE' && taxi.fleetStatus === 'ON_LINE' && !taxi.offerFor && this.rng.chance(1 / 2400)) {
        this.event('info', `${taxi.info.plate}: конец смены`, 'Возвращается в парк', taxi.info.id);
        this.setFleetStatus(taxi.info.id, 'IN_PARK', 'SYSTEM');
      }
    }
  }

  private maybeBreakdown() {
    if (!this.rng.chance(1 / 420)) return;
    const free = [...this.taxis.values()].filter((t) => t.activity === 'FREE' && t.fleetStatus === 'ON_LINE');
    if (!free.length) return;
    const taxi = this.rng.pick(free);
    this.event('danger', `${taxi.info.plate}: ошибка двигателя`, 'Автомобиль отправлен в сервис', taxi.info.id);
    this.setFleetStatus(taxi.info.id, 'MAINTENANCE', 'SYSTEM');
  }

  // ───────────────────────────── buses ─────────────────────────────

  private updateBus(bus: Bus, t: number) {
    const v = bus.v;
    if (v.path.length - v.pathIdx < 4) this.extendBus(bus, 4);
    if (v.arrived) {
      v.arrived = false;
      bus.dwellUntil = t + this.rng.range(9, 18);
      bus.passengers = Math.max(3, Math.min(70, bus.passengers + this.rng.int(-10, 12)));
    }
    if (v.mode === 'pulled' && !v.wantsDepart && t >= bus.dwellUntil) v.wantsDepart = true;
    if (v.mode === 'lane' && !v.stop) {
      const stop = this.city.busStops.find((s) => s.lane === v.lane && s.lines.includes(bus.line.id) && s.s > v.s + 6);
      if (stop && stop.id !== bus.lastStop) {
        v.stop = { lane: stop.lane, s: stop.s };
        bus.lastStop = stop.id;
      }
    }
  }

  // ───────────────────────────── orders ─────────────────────────────

  place(id: string): Place | undefined {
    return this.places.get(id);
  }

  private pickOrigin(): Place {
    const r = this.rng.next();
    if (r < 0.4) return this.places.get(this.rng.pick(this.city.busStops).id)!;
    if (r < 0.7) {
      const total = this.city.pois.reduce((a, p) => a + p.weight, 0);
      let x = this.rng.range(0, total);
      for (const p of this.city.pois) {
        x -= p.weight;
        if (x <= 0) return this.places.get(p.addressId)!;
      }
    }
    return this.places.get(this.rng.pick(this.city.addresses).id)!;
  }

  private spawnRandomOrder() {
    const pickup = this.pickOrigin();
    let dropoff = this.places.get(this.rng.pick(this.city.addresses).id)!;
    for (let i = 0; i < 10 && dist(pickup, dropoff) < 300; i++) dropoff = this.places.get(this.rng.pick(this.city.addresses).id)!;
    const source: OrderSource = pickup.id.startsWith('S') ? 'BUS_STOP' : this.rng.chance(0.85) ? 'APP' : 'PHONE';
    this.createOrder({ pickupId: pickup.id, dropoffId: dropoff.id, source });
  }

  createOrder(input: { pickupId: string; dropoffId: string; passengerName?: string; source?: OrderSource }): OrderSummary | null {
    const pickup = this.places.get(input.pickupId);
    const dropoff = this.places.get(input.dropoffId);
    if (!pickup || !dropoff || pickup.id === dropoff.id) return null;
    const estDistance = Math.round((Math.abs(pickup.x - dropoff.x) + Math.abs(pickup.z - dropoff.z)) * 1.1);
    const order: SimOrder = {
      id: crypto.randomUUID(),
      code: `KL-${++this.orderSeq}`,
      status: 'SEARCHING',
      source: input.source ?? 'DISPATCHER',
      passengerName: input.passengerName ?? passengerName(this.rng),
      pickup,
      dropoff,
      vehicleId: null,
      createdAt: this.traffic.t,
      tried: new Set(),
      offer: null,
      assignedAt: 0,
      arrivedAt: 0,
      passengerAt: 0,
      noShowAt: 0,
      cancelAt: 0,
      completeAt: 0,
      pickedAt: 0,
      pickOdo: 0,
      estDistance,
      fareRsd: Math.round(FARE.start + (FARE.perKm * estDistance) / 1000 + (FARE.perMin * estDistance) / 1000 / 0.45),
      finishedAt: 0,
    };
    this.orders.set(order.id, order);
    this.hooks.onOrderCreated?.(this.summary(order), order.source);
    this.emitOrderEvent(order, 'CREATED', order.source === 'DISPATCHER' ? 'DISPATCHER' : 'PASSENGER', `Заказ из ${sourceLabel(order.source)}`, pickup);
    this.event('info', `Новый заказ ${order.code}`, pickup.label, undefined, order.id);
    return this.summary(order);
  }

  private updateOrders(t: number) {
    for (const order of this.orders.values()) {
      switch (order.status) {
        case 'SEARCHING':
          this.dispatch(order, t);
          break;
        case 'ASSIGNED':
          if (order.cancelAt && t >= order.cancelAt) {
            this.cancelOrder(order.id, this.rng.pick(CANCEL_REASONS_PASSENGER), 'PASSENGER');
          }
          break;
        case 'ARRIVED':
          if (order.noShowAt && t >= order.noShowAt) this.finishNoShow(order);
          else if (order.passengerAt && t >= order.passengerAt) this.pickUp(order, t);
          break;
        case 'IN_PROGRESS':
          if (order.completeAt && t >= order.completeAt) this.complete(order, t);
          break;
        default:
          // Forget finished orders after a while (the database keeps them).
          if (t - order.finishedAt > 600) this.orders.delete(order.id);
      }
    }
  }

  private dispatch(order: SimOrder, t: number) {
    if (order.offer) {
      if (t < order.offer.decideAt) return;
      const taxi = this.taxis.get(order.offer.taxiId);
      const offer = order.offer;
      order.offer = null;
      if (!taxi || taxi.offerFor !== order.id) return;
      taxi.offerFor = null;
      if (offer.accept && taxi.activity === 'FREE') this.assign(order, taxi, 'DRIVER');
      else {
        this.emitOrderEvent(order, 'OFFER_MISSED', 'DRIVER', `${taxi.info.plate} пропустил предложение`, null, taxi.info.id);
        this.event('warning', `${order.code}: предложение пропущено`, taxi.info.plate, taxi.info.id, order.id);
      }
      return;
    }
    if (t - order.createdAt > 150) {
      this.finish(order, 'EXPIRED');
      this.emitOrderEvent(order, 'EXPIRED', 'SYSTEM', 'Нет свободных машин рядом', null);
      this.stats.expired++;
      this.event('danger', `${order.code}: не найдена машина`, order.pickup.label, undefined, order.id);
      return;
    }
    let best: Taxi | null = null;
    let bestD = Infinity;
    for (const taxi of this.taxis.values()) {
      if (taxi.activity !== 'FREE' || taxi.fleetStatus !== 'ON_LINE' || taxi.offerFor || order.tried.has(taxi.info.id)) continue;
      const d = Math.abs(taxi.v.pose.x - order.pickup.x) + Math.abs(taxi.v.pose.z - order.pickup.z);
      if (d < bestD) {
        bestD = d;
        best = taxi;
      }
    }
    if (!best || bestD > 1400) return;
    order.tried.add(best.info.id);
    best.offerFor = order.id;
    order.offer = { taxiId: best.info.id, decideAt: t + this.rng.range(2, 6), accept: this.rng.chance(0.85) };
    this.emitOrderEvent(order, 'OFFERED', 'SYSTEM', `Предложено ${best.info.plate} (${Math.round(bestD)} м)`, null, best.info.id);
  }

  private declineOffer(taxi: Taxi, note: string) {
    const order = taxi.offerFor ? this.orders.get(taxi.offerFor) : undefined;
    taxi.offerFor = null;
    if (order?.offer?.taxiId === taxi.info.id) {
      order.offer = null;
      this.emitOrderEvent(order, 'OFFER_MISSED', 'DRIVER', note, null, taxi.info.id);
    }
  }

  private assign(order: SimOrder, taxi: Taxi, actor: Actor) {
    order.status = 'ASSIGNED';
    order.vehicleId = taxi.info.id;
    order.assignedAt = this.traffic.t;
    order.cancelAt = this.rng.chance(0.05) ? this.traffic.t + this.rng.range(15, 60) : 0;
    taxi.orderId = order.id;
    taxi.waitUntil = 0;
    this.setActivity(taxi, 'TO_PICKUP');
    this.driveTo(taxi, order.pickup);
    this.emitOrderEvent(order, 'ASSIGNED', actor, `${taxi.info.plate} · ${taxi.info.driverName ?? 'водитель'}`, null, taxi.info.id);
  }

  assignOrder(orderId: string, vehicleId: string): boolean {
    const order = this.orders.get(orderId);
    const taxi = this.taxis.get(vehicleId);
    if (!order || !taxi || order.status !== 'SEARCHING' || taxi.activity !== 'FREE' || taxi.fleetStatus !== 'ON_LINE') return false;
    if (order.offer) {
      const other = this.taxis.get(order.offer.taxiId);
      if (other) other.offerFor = null;
      order.offer = null;
    }
    if (taxi.offerFor) this.declineOffer(taxi, 'Переназначено диспетчером');
    order.tried.add(taxi.info.id);
    this.assign(order, taxi, 'DISPATCHER');
    return true;
  }

  private pickUp(order: SimOrder, t: number) {
    const taxi = order.vehicleId ? this.taxis.get(order.vehicleId) : undefined;
    if (!taxi) return;
    order.status = 'IN_PROGRESS';
    order.pickedAt = t;
    order.pickOdo = taxi.v.odometer;
    this.setActivity(taxi, 'ON_TRIP');
    this.driveTo(taxi, order.dropoff);
    this.emitOrderEvent(order, 'PICKED_UP', 'DRIVER', `Пассажир в машине · ${order.passengerName}`, order.pickup, taxi.info.id);
  }

  private complete(order: SimOrder, t: number) {
    const taxi = order.vehicleId ? this.taxis.get(order.vehicleId) : undefined;
    const meters = taxi ? taxi.v.odometer - order.pickOdo : order.estDistance;
    const minutes = (t - order.pickedAt) / 60;
    order.fareRsd = Math.round(FARE.start + (FARE.perKm * meters) / 1000 + FARE.perMin * minutes);
    order.estDistance = Math.round(meters);
    this.finish(order, 'COMPLETED');
    this.stats.completed++;
    this.stats.revenue += order.fareRsd;
    this.emitOrderEvent(order, 'COMPLETED', 'DRIVER', `${order.fareRsd} RSD · ${(meters / 1000).toFixed(1)} км`, order.dropoff, order.vehicleId);
    this.event('success', `${order.code} выполнен`, `${order.fareRsd} RSD`, order.vehicleId ?? undefined, order.id);
    if (taxi) {
      taxi.trips++;
      taxi.earnings += order.fareRsd;
      this.releaseTaxi(taxi);
    }
    if (this.rng.chance(0.05)) {
      const reason = this.rng.pick(DISPUTE_REASONS);
      this.stats.openDisputes++;
      this.hooks.onDisputeOpened?.(order.id, reason);
      this.emitOrderEvent(order, 'DISPUTE_OPENED', 'PASSENGER', reason, null);
      this.event('danger', `${order.code}: возражение пассажира`, reason, undefined, order.id);
    }
  }

  private finishNoShow(order: SimOrder) {
    this.finish(order, 'NO_SHOW');
    this.stats.noShow++;
    this.emitOrderEvent(order, 'NO_SHOW', 'DRIVER', 'Пассажир не вышел (75 с ожидания)', order.pickup, order.vehicleId);
    this.event('warning', `${order.code}: неявка пассажира`, order.pickup.label, order.vehicleId ?? undefined, order.id);
    const taxi = order.vehicleId ? this.taxis.get(order.vehicleId) : undefined;
    if (taxi) this.releaseTaxi(taxi);
  }

  cancelOrder(orderId: string, reason: string, actor: Actor): boolean {
    const order = this.orders.get(orderId);
    if (!order || !ACTIVE_ORDER_STATUSES.includes(order.status)) return false;
    if (order.offer) {
      const t = this.taxis.get(order.offer.taxiId);
      if (t) t.offerFor = null;
      order.offer = null;
    }
    this.finish(order, 'CANCELLED');
    this.stats.cancelled++;
    this.emitOrderEvent(order, 'CANCELLED', actor, reason, null, order.vehicleId, { cancelReason: reason });
    this.event('warning', `${order.code} отменён`, reason, order.vehicleId ?? undefined, order.id);
    const taxi = order.vehicleId ? this.taxis.get(order.vehicleId) : undefined;
    if (taxi && taxi.orderId === order.id) this.releaseTaxi(taxi);
    return true;
  }

  resolveDispute() {
    this.stats.openDisputes = Math.max(0, this.stats.openDisputes - 1);
  }

  setOpenDisputes(n: number) {
    this.stats.openDisputes = n;
  }

  private finish(order: SimOrder, status: OrderStatus) {
    order.status = status;
    order.finishedAt = this.traffic.t;
  }

  private releaseTaxi(taxi: Taxi) {
    taxi.orderId = null;
    if (taxi.pending) {
      const next = taxi.pending;
      taxi.pending = null;
      this.setActivity(taxi, 'FREE');
      this.setFleetStatus(taxi.info.id, next, 'SYSTEM');
      return;
    }
    taxi.waitUntil = this.traffic.t + this.rng.range(4, 12);
    this.setActivity(taxi, 'FREE');
    taxi.target = null;
  }

  private emitOrderEvent(
    order: SimOrder,
    type: OrderEventType,
    actor: Actor,
    note: string | null,
    at: Vec2 | null,
    vehicleId: string | null = order.vehicleId,
    extra: { cancelReason?: string } = {},
  ) {
    const taxi = vehicleId ? this.taxis.get(vehicleId) : undefined;
    const pos = at ?? (taxi ? taxi.v.pose : null);
    this.hooks.onOrderEvent?.(
      this.summary(order),
      { type, actor, note, vehicleId, x: pos ? round(pos.x) : null, z: pos ? round(pos.z) : null, at: this.traffic.t },
      extra,
    );
  }

  private orderEvent(order: SimOrder, type: OrderEventType, actor: Actor, note: string, status: OrderStatus) {
    order.status = status;
    this.emitOrderEvent(order, type, actor, note, null);
    this.event('info', `${order.code}: ${note.toLowerCase()}`, order.pickup.label, order.vehicleId ?? undefined, order.id);
  }

  private event(severity: LiveEventSeverity, title: string, detail?: string, vehicleId?: string, orderId?: string) {
    const e: LiveEvent = { id: `E${++this.eventSeq}`, at: Date.now(), severity, title };
    if (detail !== undefined) e.detail = detail;
    if (vehicleId !== undefined) e.vehicleId = vehicleId;
    if (orderId !== undefined) e.orderId = orderId;
    this.hooks.onLiveEvent?.(e);
  }

  // ───────────────────────────── control ─────────────────────────────

  control(input: SimControlInput) {
    if (input.speed !== undefined) this.speed = input.speed;
    if (input.paused !== undefined) this.paused = input.paused;
    if (input.trafficDensity !== undefined) this.trafficDensity = input.trafficDensity;
    if (input.demand !== undefined) this.demand = input.demand;
  }

  setLight(nodeId: number, input: LightControlInput): boolean {
    const sig = this.traffic.signals[nodeId];
    if (!sig) return false;
    if (input.mode) sig.mode = input.mode;
    if (input.greenNs) sig.plan.greenNs = input.greenNs;
    if (input.greenEw) sig.plan.greenEw = input.greenEw;
    return true;
  }

  // ───────────────────────────── views ─────────────────────────────

  summary(order: SimOrder): OrderSummary {
    return {
      id: order.id,
      code: order.code,
      status: order.status,
      pickup: placeRef(order.pickup),
      dropoff: placeRef(order.dropoff),
      passengerName: order.passengerName,
      vehicleId: order.vehicleId,
      fareRsd: order.fareRsd,
      distanceMeters: order.estDistance,
      createdAt: order.createdAt,
    };
  }

  activeOrders(): OrderSummary[] {
    return [...this.orders.values()].filter((o) => ACTIVE_ORDER_STATUSES.includes(o.status)).map((o) => this.summary(o));
  }

  frame(): LiveFrame {
    const vehicles: LiveFrame['vehicles'] = [];
    for (const v of this.traffic.vehicles) {
      const taxi = v.kind === 'TAXI' ? this.taxis.get(v.id) : undefined;
      const flags = (v.acc < -1.2 ? 1 : 0) | (v.mode === 'pulled' ? 2 : 0) | (taxi?.activity === 'ON_TRIP' ? 4 : 0);
      vehicles.push([
        v.id,
        VEHICLE_KINDS.indexOf(v.kind),
        round(v.pose.x),
        round(v.pose.z),
        Math.round(v.pose.heading * 1000) / 1000,
        Math.round(v.speed * 10) / 10,
        taxi ? TAXI_ACTIVITIES.indexOf(taxi.activity) : -1,
        flags,
      ]);
    }
    const lights = this.traffic.signalStates.map((st) =>
      st
        ? ([
            LIGHT_ASPECTS.indexOf(st.ns),
            LIGHT_ASPECTS.indexOf(st.ew),
            Number.isFinite(st.nsLeft) ? Math.round(st.nsLeft * 10) / 10 : -1,
            Number.isFinite(st.ewLeft) ? Math.round(st.ewLeft * 10) / 10 : -1,
          ] as LightTuple)
        : null,
    );
    return { t: Math.round(this.traffic.t * 100) / 100, wall: Date.now(), vehicles, lights };
  }

  kpi(): LiveKpi {
    const taxis = [...this.taxis.values()];
    const moving = this.traffic.vehicles.filter((v) => v.mode === 'lane' || v.mode === 'conn');
    const active = [...this.orders.values()].filter((o) => ACTIVE_ORDER_STATUSES.includes(o.status));
    const etas = this.recentPickupEtas;
    return {
      taxis: {
        total: taxis.length,
        free: taxis.filter((t) => t.activity === 'FREE' && t.fleetStatus === 'ON_LINE').length,
        busy: taxis.filter((t) => t.activity === 'TO_PICKUP' || t.activity === 'AT_PICKUP' || t.activity === 'ON_TRIP').length,
        inPark: taxis.filter((t) => t.fleetStatus === 'IN_PARK').length,
        maintenance: taxis.filter((t) => t.fleetStatus === 'MAINTENANCE').length,
      },
      orders: {
        searching: active.filter((o) => o.status === 'SEARCHING').length,
        active: active.length,
        completed: this.stats.completed,
        cancelled: this.stats.cancelled,
        noShow: this.stats.noShow,
        expired: this.stats.expired,
        openDisputes: this.stats.openDisputes,
      },
      avgPickupEtaSec: etas.length ? Math.round(etas.reduce((a, b) => a + b, 0) / etas.length) : 0,
      avgSpeedKmh: moving.length ? Math.round((moving.reduce((a, v) => a + v.speed, 0) / moving.length) * 36) / 10 : 0,
      congestion: moving.length ? Math.round((moving.filter((v) => v.stoppedFor > 4).length / moving.length) * 100) / 100 : 0,
      revenueRsd: this.stats.revenue,
      speed: this.speed,
      paused: this.paused,
    };
  }

  taxiDetail(id: string): TaxiDetail | null {
    const taxi = this.taxis.get(id);
    if (!taxi) return null;
    const route = this.traffic.routeOf(taxi.v);
    const order = taxi.orderId ? this.orders.get(taxi.orderId) : undefined;
    const showRoute = taxi.activity !== 'PARKED' && taxi.activity !== 'IN_SERVICE' && (taxi.v.mode === 'lane' || taxi.v.mode === 'conn' || (taxi.v.mode === 'pulled' && taxi.v.wantsDepart));
    const meters = showRoute ? Math.round(route.meters) : 0;
    return {
      id,
      plate: taxi.info.plate,
      model: taxi.info.model,
      driverName: taxi.info.driverName,
      driverRating: taxi.info.driverRating,
      parkId: taxi.depot.id,
      parkName: taxi.info.parkName,
      fleetStatus: taxi.fleetStatus,
      activity: taxi.activity,
      speedKmh: Math.round(taxi.v.speed * 36) / 10,
      x: round(taxi.v.pose.x),
      z: round(taxi.v.pose.z),
      route: showRoute ? route.points.map((p) => ({ x: round(p.x), z: round(p.z) })) : [],
      routeTarget: taxi.target && showRoute ? placeRef(taxi.target) : null,
      remainingMeters: meters,
      etaSec: Math.round(meters / 8.3),
      order: order ? this.summary(order) : null,
      tripsToday: taxi.trips,
      earningsRsd: taxi.earnings,
    };
  }

  lightDetail(nodeId: number): LightDetail | null {
    const node = this.city.nodes[nodeId];
    const sig = this.traffic.signals[nodeId];
    if (!node || !sig) return null;
    const st = signalState(sig, this.traffic.t);
    const nsIn = node.in.filter((s) => this.city.segments[s]!.axis === 'NS');
    const ewIn = node.in.filter((s) => this.city.segments[s]!.axis === 'EW');
    const left = Math.min(st.nsLeft, st.ewLeft);
    return {
      intersectionId: String(nodeId),
      name: node.name,
      mode: sig.mode,
      ns: st.ns,
      ew: st.ew,
      secondsLeft: Number.isFinite(left) ? Math.round(left * 10) / 10 : -1,
      greenNs: sig.plan.greenNs,
      greenEw: sig.plan.greenEw,
      cycleSec: cycleOf(sig.plan),
      queueNs: this.traffic.queueOn(nsIn),
      queueEw: this.traffic.queueOn(ewIn),
    };
  }

  busDetail(id: string): BusDetail | null {
    const bus = this.buses.get(id);
    if (!bus) return null;
    const v = bus.v;
    const route = this.traffic.routeOf(v);
    // Next stop ahead on the path.
    let nextStop = '';
    let meters = 0;
    let acc = v.mode === 'lane' || v.mode === 'pulled' ? -v.s : 0;
    for (let i = v.pathIdx; i < v.path.length && !nextStop; i++) {
      const step = v.path[i]!;
      const lane = this.city.lanes[step.lane]!;
      const stop = this.city.busStops.find(
        (s) => s.lane === step.lane && s.lines.includes(bus.line.id) && (i > v.pathIdx || s.s > v.s + 1),
      );
      if (stop) {
        nextStop = stop.name;
        meters = acc + stop.s;
      } else acc += lane.length + (v.path[i + 1] ? this.city.connectors[v.path[i + 1]!.conn]!.line.length : 0);
    }
    return {
      id,
      line: bus.line.id,
      lineName: bus.line.name,
      speedKmh: Math.round(v.speed * 36) / 10,
      nextStop: nextStop || '—',
      etaSec: Math.round(Math.max(0, meters) / 7),
      dwellLeftSec: v.mode === 'pulled' ? Math.max(0, Math.round(bus.dwellUntil - this.traffic.t)) : 0,
      passengers: bus.passengers,
      route: route.points.slice(0, 40).map((p) => ({ x: round(p.x), z: round(p.z) })),
    };
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

const placeRef = (p: Place): PlaceRef => ({ addressId: p.id, label: p.label, x: round(p.x), z: round(p.z) });

const sourceLabel = (s: OrderSource) => ({ APP: 'приложения', PHONE: 'колл-центра', BUS_STOP: 'точки у остановки', DISPATCHER: 'диспетчерской' })[s];

export const labelOfStatus = (s: FleetStatus) => ({ ON_LINE: 'на линии', IN_PARK: 'в парке', MAINTENANCE: 'на обслуживании' })[s];

