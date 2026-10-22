import type { FleetStatus, LightAspect, LightMode, OrderStatus, TaxiActivity, VehicleKind } from './enums.js';

/**
 * Compact per-vehicle tuple sent at 10 Hz:
 * [id, kindIndex, x, z, heading, speed m/s, activityIndex (taxi) | -1, flags]
 * flags bit 0 = braking, bit 1 = pulled over, bit 2 = has passenger.
 */
export type VehicleTuple = [string, number, number, number, number, number, number, number];

/**
 * Per signalised intersection with n phases: n aspect indexes, then n "seconds until change" (-1 = held).
 * Phases are indexed like the intersection's signal plan.
 */
export type LightTuple = number[];

export interface LiveFrame {
  /** Simulation clock in seconds. */
  t: number;
  /** Belgrade clock of the simulation (ms since epoch): the timetable runs on it; ahead of wall time after running fast. */
  clock: number;
  /** Wall clock (ms since epoch) at which the frame was produced. */
  wall: number;
  vehicles: VehicleTuple[];
  /** Indexed like City.intersections; null for unsignalised intersections. */
  lights: (LightTuple | null)[];
}

export interface LiveKpi {
  taxis: { total: number; free: number; busy: number; inPark: number; maintenance: number };
  orders: {
    searching: number;
    active: number;
    completed: number;
    cancelled: number;
    noShow: number;
    expired: number;
    openDisputes: number;
  };
  avgPickupEtaSec: number;
  avgSpeedKmh: number;
  /** 0 = free flow, 1 = gridlock. */
  congestion: number;
  revenueRsd: number;
  speed: number;
  paused: boolean;
}

export type LiveEventSeverity = 'info' | 'success' | 'warning' | 'danger';

export interface LiveEvent {
  id: string;
  at: number;
  severity: LiveEventSeverity;
  title: string;
  detail?: string;
  vehicleId?: string;
  orderId?: string;
}

export interface RoutePoint {
  x: number;
  z: number;
}

export interface PlaceRef {
  addressId: string;
  label: string;
  x: number;
  z: number;
}

export interface TaxiDetail {
  id: string;
  plate: string;
  model: string;
  driverName: string | null;
  driverRating: number | null;
  parkId: string;
  parkName: string;
  fleetStatus: FleetStatus;
  activity: TaxiActivity;
  speedKmh: number;
  x: number;
  z: number;
  route: RoutePoint[];
  routeTarget: PlaceRef | null;
  remainingMeters: number;
  etaSec: number;
  /** Share of the current leg already driven (0..1): odometer since the leg began vs. the remaining route. */
  progress: number;
  order: OrderSummary | null;
  tripsToday: number;
  earningsRsd: number;
}

export interface OrderSummary {
  id: string;
  code: string;
  status: OrderStatus;
  pickup: PlaceRef;
  dropoff: PlaceRef;
  passengerName: string;
  vehicleId: string | null;
  fareRsd: number;
  distanceMeters: number;
  createdAt: number;
}

export interface LightDetail {
  intersectionId: string;
  name: string;
  mode: LightMode;
  holdPhase: number;
  phases: LightPhaseDetail[];
  cycleSec: number;
}

export interface LightPhaseDetail {
  /** Streets whose approaches move in this phase, e.g. «Kralja Milana». */
  label: string;
  aspect: LightAspect;
  secondsLeft: number;
  green: number;
  queue: number;
}

export type TransitMode = 'bus' | 'trolley' | 'minibus' | 'tram';

export interface BusDetail {
  id: string;
  kind: VehicleKind;
  /** GTFS route_id. */
  lineId: string;
  /** Number on the vehicle. */
  lineName: string;
  color: string;
  textColor: string;
  headsign: string;
  speedKmh: number;
  nextStop: string;
  /** Expected arrival at the next stop (ms since epoch, simulation clock); null after the last one. */
  nextStopAt: number | null;
  etaSec: number;
  /** Seconds behind the timetable at the last departure; negative when early. */
  delaySec: number;
  dwellLeftSec: number;
  passengers: number;
  route: RoutePoint[];
}

export interface StopDeparture {
  lineId: string;
  name: string;
  color: string;
  textColor: string;
  headsign: string;
  /** Timetable departure and the expected one (with the vehicle's delay), ms since epoch. */
  scheduledAt: number;
  expectedAt: number;
  /** Vehicle already on its way, or null for a trip not yet started. */
  vehicleId: string | null;
}

export interface StopDetail {
  id: string;
  /** Number on the pole. */
  code: string;
  name: string;
  x: number;
  z: number;
  lines: { id: string; name: string; color: string; textColor: string; mode: TransitMode }[];
  /** Taxis can pull up here (the stop is on a curb lane of the core network). */
  pickup: boolean;
  /** Up to 8 departures within the next hour. */
  departures: StopDeparture[];
}

export interface LineDirection {
  headsign: string;
  stops: { id: string; name: string }[];
  /** Median minutes between departures from the first stop within the next hour; null if fewer than two. */
  headwayMin: number | null;
  nextDepartureAt: number | null;
  route: RoutePoint[];
}

export interface LineDetail {
  id: string;
  name: string;
  longName: string;
  mode: TransitMode;
  color: string;
  textColor: string;
  directions: LineDirection[];
  vehicles: { id: string; kind: VehicleKind; headsign: string; delaySec: number }[];
}

export interface VehicleBrief {
  id: string;
  kind: VehicleKind;
}

export const SOCKET_NAMESPACE = '/live';
/** Sent once on connect: which district file the server simulates. */
export interface LiveHello {
  districtId: string;
  version: string;
}

export const SocketEvent = {
  HELLO: 'hello',
  FRAME: 'frame',
  KPI: 'kpi',
  EVENT: 'event',
  ORDER: 'order',
} as const;
