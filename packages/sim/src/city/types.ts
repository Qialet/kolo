import type { Polyline, Rect, Vec2 } from '../geometry.js';

export type Axis = 'NS' | 'EW';
export type StreetClass = 'boulevard' | 'local';
export type Turn = 'S' | 'L' | 'R';

export interface Street {
  id: number;
  name: string;
  /** NS streets run north–south at a fixed x; EW streets run east–west at a fixed z. */
  axis: Axis;
  coord: number;
  cls: StreetClass;
  lanesPerDir: number;
  laneWidth: number;
  /** Half width of the central median (0 for local streets). */
  median: number;
  halfWidth: number;
  /** Speed limit in m/s. */
  speed: number;
}

export interface SignalPlan {
  greenNs: number;
  greenEw: number;
  offset: number;
}

export interface CityNode {
  id: number;
  col: number;
  row: number;
  x: number;
  z: number;
  vStreet: number;
  hStreet: number;
  /** Half extent of the junction box along x / z. */
  halfX: number;
  halfZ: number;
  in: number[];
  out: number[];
  signal: SignalPlan | null;
  /** For unsignalised junctions: the axis that has right of way. */
  priority: Axis | null;
  name: string;
}

export interface Segment {
  id: number;
  from: number;
  to: number;
  street: number;
  axis: Axis;
  dir: Vec2;
  lanes: number[];
  length: number;
  speed: number;
  reverse: number;
}

export interface Lane {
  id: number;
  seg: number;
  /** 0 = inner (next to the centre line), lanesInSeg - 1 = curb lane. */
  index: number;
  lanesInSeg: number;
  start: Vec2;
  end: Vec2;
  dir: Vec2;
  right: Vec2;
  length: number;
  offset: number;
  out: number[];
  in: number[];
}

export interface Connector {
  id: number;
  node: number;
  from: number;
  to: number;
  turn: Turn;
  approach: Axis;
  line: Polyline;
  vmax: number;
  conflicts: number[];
}

export type BuildingKind = 'residential' | 'office' | 'poi' | 'garage' | 'depot-office' | 'stall' | 'kiosk';

export interface Building {
  id: string;
  x: number;
  z: number;
  /** Size along x / z. */
  w: number;
  d: number;
  h: number;
  kind: BuildingKind;
  tint: number;
  addressId: string | null;
  name: string | null;
  blockId: number;
}

export interface Tree {
  x: number;
  z: number;
  r: number;
  h: number;
}

export interface CurbRef {
  lane: number;
  s: number;
}

export interface Address extends CurbRef {
  id: string;
  label: string;
  street: number;
  number: number;
  /** Entrance on the sidewalk. */
  x: number;
  z: number;
  buildingId: string | null;
  poi: string | null;
}

export interface Slot {
  x: number;
  z: number;
  heading: number;
}

export interface Depot {
  id: string;
  name: string;
  blockId: number;
  lot: Rect;
  garage: Rect;
  gate: Vec2;
  /** Inside the lot, just behind the gate. */
  yard: Vec2;
  curb: CurbRef;
  addressId: string;
  slots: Slot[];
  boxes: Slot[];
}

export interface BusStop extends CurbRef {
  id: string;
  name: string;
  x: number;
  z: number;
  heading: number;
  lines: string[];
}

export interface BusLine {
  id: string;
  name: string;
  /** Closed loop of segment ids. */
  segments: number[];
  stops: string[];
}

export type BlockKind = 'urban' | 'park' | 'depot' | 'poi' | 'market' | 'edge';

export interface Block {
  id: number;
  kind: BlockKind;
  /** Usable area inside sidewalks. */
  inner: Rect;
  name: string | null;
}

export interface Poi {
  id: string;
  name: string;
  kind: 'mall' | 'hospital' | 'station' | 'market' | 'university' | 'hotel' | 'park';
  addressId: string;
  weight: number;
}

export interface City {
  seed: number;
  bounds: Rect;
  sidewalk: number;
  streets: Street[];
  nodes: CityNode[];
  segments: Segment[];
  lanes: Lane[];
  connectors: Connector[];
  blocks: Block[];
  buildings: Building[];
  trees: Tree[];
  addresses: Address[];
  depots: Depot[];
  busStops: BusStop[];
  busLines: BusLine[];
  pois: Poi[];
  /** Fast lookups. */
  segmentByKey: Map<string, number>;
  addressById: Map<string, Address>;
}
