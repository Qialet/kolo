import { z } from 'zod';
import { Actor, DisputeStatus, FleetStatus, LightMode, OrderSource } from './enums.js';
import type { OrderEventType, OrderStatus } from './enums.js';
import type { PlaceRef } from './live.js';

const values = <T extends Record<string, string>>(o: T) => Object.values(o) as [T[keyof T], ...T[keyof T][]];

export const CreateOrderInput = z.object({
  pickupAddressId: z.string().min(1),
  dropoffAddressId: z.string().min(1),
  passengerName: z.string().min(1).max(80).optional(),
  source: z.enum(values(OrderSource)).default('DISPATCHER'),
});
export type CreateOrderInput = z.infer<typeof CreateOrderInput>;

export const CancelOrderInput = z.object({
  reason: z.string().min(2).max(200),
  actor: z.enum(values(Actor)).default('DISPATCHER'),
});
export type CancelOrderInput = z.infer<typeof CancelOrderInput>;

export const AssignOrderInput = z.object({ vehicleId: z.string().min(1) });
export type AssignOrderInput = z.infer<typeof AssignOrderInput>;

export const OpenDisputeInput = z.object({ reason: z.string().min(2).max(200) });
export type OpenDisputeInput = z.infer<typeof OpenDisputeInput>;

export const ResolveDisputeInput = z.object({
  resolution: z.enum([DisputeStatus.REFUNDED, DisputeStatus.REJECTED]),
  note: z.string().max(200).optional(),
});
export type ResolveDisputeInput = z.infer<typeof ResolveDisputeInput>;

export const SetFleetStatusInput = z.object({ status: z.enum(values(FleetStatus)) });
export type SetFleetStatusInput = z.infer<typeof SetFleetStatusInput>;

export const SimControlInput = z.object({
  speed: z.number().min(0.25).max(8).optional(),
  paused: z.boolean().optional(),
  trafficDensity: z.number().min(0).max(1).optional(),
  demand: z.number().min(0).max(3).optional(),
});
export type SimControlInput = z.infer<typeof SimControlInput>;

export const LightControlInput = z.object({
  mode: z.enum(values(LightMode)).optional(),
  holdPhase: z.number().int().min(0).max(7).optional(),
  /** Green seconds per phase, indexed like LightDetail.phases. */
  greens: z.array(z.number().int().min(8).max(90)).min(1).max(8).optional(),
});
export type LightControlInput = z.infer<typeof LightControlInput>;

export const OrderListQuery = z.object({
  status: z.string().optional(),
  vehicleId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type OrderListQuery = z.infer<typeof OrderListQuery>;

export interface PartnerDto {
  id: string;
  name: string;
  color: string;
}

export interface ParkDto {
  id: string;
  code: string;
  name: string;
  partner: PartnerDto;
  address: string;
  capacity: number;
  serviceBoxes: number;
  /** Yard gate in world metres. */
  x: number | null;
  z: number | null;
  counts: { total: number; onLine: number; inPark: number; maintenance: number };
}

export interface VehicleDto {
  id: string;
  plate: string;
  model: string;
  color: string;
  year: number;
  fleetStatus: FleetStatus;
  parkId: string;
  parkCode: string;
  driverName: string | null;
  mileageKm: number;
}

export interface OrderEventDto {
  id: string;
  type: OrderEventType;
  actor: Actor;
  note: string | null;
  vehicleId: string | null;
  x: number | null;
  z: number | null;
  at: string;
}

export interface DisputeDto {
  id: string;
  reason: string;
  status: DisputeStatus;
  note: string | null;
  openedAt: string;
  resolvedAt: string | null;
}

export interface OrderDto {
  id: string;
  code: string;
  status: OrderStatus;
  source: OrderSource;
  passengerName: string;
  pickup: PlaceRef;
  dropoff: PlaceRef;
  vehicleId: string | null;
  vehiclePlate: string | null;
  fareRsd: number;
  distanceMeters: number;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  events?: OrderEventDto[];
  disputes?: DisputeDto[];
}
