/** Persisted, admin-controlled availability of a car. */
export const FleetStatus = {
  ON_LINE: 'ON_LINE',
  IN_PARK: 'IN_PARK',
  MAINTENANCE: 'MAINTENANCE',
} as const;
export type FleetStatus = (typeof FleetStatus)[keyof typeof FleetStatus];

/** Live, simulation-driven activity of a taxi. Index order is the wire encoding. */
export const TAXI_ACTIVITIES = [
  'PARKED',
  'LEAVING_PARK',
  'FREE',
  'TO_PICKUP',
  'AT_PICKUP',
  'ON_TRIP',
  'TO_PARK',
  'TO_SERVICE',
  'IN_SERVICE',
] as const;
export type TaxiActivity = (typeof TAXI_ACTIVITIES)[number];

export const OrderStatus = {
  SEARCHING: 'SEARCHING',
  ASSIGNED: 'ASSIGNED',
  ARRIVED: 'ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
  EXPIRED: 'EXPIRED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = ['SEARCHING', 'ASSIGNED', 'ARRIVED', 'IN_PROGRESS'];

export const OrderEventType = {
  CREATED: 'CREATED',
  OFFERED: 'OFFERED',
  OFFER_MISSED: 'OFFER_MISSED',
  ASSIGNED: 'ASSIGNED',
  ARRIVED: 'ARRIVED',
  PICKED_UP: 'PICKED_UP',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
  EXPIRED: 'EXPIRED',
  DISPUTE_OPENED: 'DISPUTE_OPENED',
  DISPUTE_RESOLVED: 'DISPUTE_RESOLVED',
} as const;
export type OrderEventType = (typeof OrderEventType)[keyof typeof OrderEventType];

export const Actor = {
  PASSENGER: 'PASSENGER',
  DRIVER: 'DRIVER',
  DISPATCHER: 'DISPATCHER',
  SYSTEM: 'SYSTEM',
} as const;
export type Actor = (typeof Actor)[keyof typeof Actor];

export const OrderSource = {
  APP: 'APP',
  PHONE: 'PHONE',
  BUS_STOP: 'BUS_STOP',
  DISPATCHER: 'DISPATCHER',
} as const;
export type OrderSource = (typeof OrderSource)[keyof typeof OrderSource];

export const DisputeStatus = {
  OPEN: 'OPEN',
  REFUNDED: 'REFUNDED',
  REJECTED: 'REJECTED',
} as const;
export type DisputeStatus = (typeof DisputeStatus)[keyof typeof DisputeStatus];

/** Wire index = position: new kinds go at the end. */
export const VEHICLE_KINDS = ['TAXI', 'CAR', 'BUS', 'TROLLEY', 'MINIBUS', 'TRAM'] as const;
export type VehicleKind = (typeof VEHICLE_KINDS)[number];

/** Public transport: runs on the timetable and may use bus-only roads. */
export const isTransitKind = (kind: VehicleKind) => kind === 'BUS' || kind === 'TROLLEY' || kind === 'MINIBUS' || kind === 'TRAM';

/** Signal aspect of one approach. Serbian sequence: RED → RED_AMBER → GREEN → AMBER → RED. */
export const LIGHT_ASPECTS = ['RED', 'RED_AMBER', 'GREEN', 'AMBER', 'FLASHING'] as const;
export type LightAspect = (typeof LIGHT_ASPECTS)[number];

export const LightMode = {
  AUTO: 'AUTO',
  FLASHING: 'FLASHING',
  /** Keep one phase green (see holdPhase). */
  HOLD: 'HOLD',
} as const;
export type LightMode = (typeof LightMode)[keyof typeof LightMode];
