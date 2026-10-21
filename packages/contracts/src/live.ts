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

export interface BusDetail {
  id: string;
  line: string;
  lineName: string;
  speedKmh: number;
  nextStop: string;
  etaSec: number;
  dwellLeftSec: number;
  passengers: number;
  route: RoutePoint[];
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
