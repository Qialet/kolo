import type { Polyline, Rect, Vec2 } from '../geometry.js';
import type { AreaKind, BuildingUse, DistrictTransit, PoiKind, TransitMode } from './district.js';

export type StreetClass = 'boulevard' | 'local';
export type Turn = 'S' | 'L' | 'R';

export interface Street {
  id: number;
  name: string;
  cls: StreetClass;
  lanesPerDir: number;
  laneWidth: number;
  halfWidth: number;
  /** Speed limit in m/s. */
  speed: number;
}

export interface SignalPhase {
  /** Green seconds. */
  green: number;
}

/** Phases are served in order; every incoming segment of the node belongs to one phase. */
export interface SignalPlan {
  phases: SignalPhase[];
  offset: number;
}

export interface CityNode {
  id: number;
  x: number;
  z: number;
  /** Radius of the junction area: lanes end where they leave this circle. */
  radius: number;
  in: number[];
  out: number[];
  signal: SignalPlan | null;
  name: string;
  /** Cut by the district frame: vehicles appear and disappear here. */
  boundary?: boolean;
}

export interface Segment {
  id: number;
  from: number;
  to: number;
  street: number;
  /** Unit travel direction where the segment leaves its start node / enters its end node. */
  dirIn: Vec2;
  dirOut: Vec2;
  lanes: number[];
  length: number;
  speed: number;
  reverse: number;
  /** Right of way at the end node: approaches with a lower rank yield to higher ones. */
  rank: number;
  /** Signal phase of this approach at the end node (0 when unsignalised). */
  phase: number;
  /** OSM layer: below 0 a tunnel, above 0 a bridge deck; 0 is street level. */
  layer: number;
  /** Bus / trolleybus only: cars never route over it. */
  psvOnly?: boolean;
  /** Has trolleybus wires overhead. */
  trolley?: boolean;
  /** Tram track (also psvOnly): one lane on the track axis, joined only to other tracks. */
  rail?: boolean;
  /**
   * In the main strongly connected network: every core segment reaches every other one without
   * leaving the map. Taxis, addresses and orders live here; frame entries and exits are not core.
   */
  core?: boolean;
}

export interface Lane {
  id: number;
  seg: number;
  /** 0 = inner (next to the centre line), lanesInSeg - 1 = curb lane. */
  index: number;
  lanesInSeg: number;
  /** Centre line from the start stop line to the end stop line. */
  line: Polyline;
  start: Vec2;
  end: Vec2;
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
  /** Signal phase that lets this connector move (the phase of its incoming segment). */
  phase: number;
  line: Polyline;
  vmax: number;
  conflicts: number[];
}

export type BuildingKind = BuildingUse | 'garage' | 'depot-office';

export interface Building {
  id: string;
  outline: Vec2[];
  holes: Vec2[][];
  /** Area centroid. */
  x: number;
  z: number;
  h: number;
  levels: number;
  kind: BuildingKind;
  tint: number;
  addressId: string | null;
  name: string | null;
}

/** Land cover polygon (water, parks, plazas …). */
export interface Area {
  kind: AreaKind;
  outer: Vec2[];
  holes: Vec2[][];
}

/** Axis of one tram track between junctions, for rails and the overhead wire. */
export interface Track {
  points: Vec2[];
  layer: number;
}

/** Asphalt of one road between junctions: its OSM centre line and the paved width on each side. */
export interface RoadStrip {
  points: Vec2[];
  /** Metres to the left / right of the line in its point order. */
  left: number;
  right: number;
  /** OSM layer: tunnels (below 0) are not drawn over the blocks above them. */
  layer: number;
}

export interface Tree {
  x: number;
  z: number;
  r: number;
  h: number;
}

/** Playground: a soft pad with a sandbox, swings and a climbing frame. */
export interface Playground {
  x: number;
  z: number;
  /** Pad size along its own axes before rotation. */
  w: number;
  d: number;
  /** three.js rotation around Y that turns the pad's local x axis onto its long side. */
  rot: number;
  /** Equipment arrangement (0..2). */
  variant: number;
}

/** A car parked on the sidewalk of a local street (static decoration, outside the traffic model). */
export interface ParkedCar {
  x: number;
  z: number;
  heading: number;
  /** Index into the renderer's neutral car palette. */
  tint: number;
}

export interface CurbRef {
  lane: number;
  s: number;
}

export interface Address extends CurbRef {
  id: string;
  label: string;
  street: number;
  number: string;
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
  /** Real lot outline. */
  lot: Vec2[];
  /** Service garage footprint (four corners). */
  garage: Vec2[];
  gate: Vec2;
  /** Inside the lot, just behind the gate. */
  yard: Vec2;
  curb: CurbRef;
  addressId: string;
  slots: Slot[];
  boxes: Slot[];
}

/** A GTFS stop bound to a curb lane; vehicles pull over at (lane, s). */
export interface BusStop extends CurbRef {
  /** GTFS stop_id. */
  id: string;
  /** Number on the pole. */
  code: string;
  name: string;
  /** Shelter on the sidewalk just behind the kerb. */
  x: number;
  z: number;
  heading: number;
  /** Ids of the lines calling here. */
  lines: string[];
}

export interface BusLine {
  /** GTFS route_id. */
  id: string;
  /** Number on the vehicle. */
  name: string;
  longName: string;
  mode: TransitMode;
  color: string;
  textColor: string;
}

export interface Poi {
  id: string;
  name: string;
  kind: PoiKind;
  addressId: string;
  weight: number;
  /** Label anchor (the place itself, not its curb). */
  x: number;
  z: number;
}

export interface City {
  districtId: string;
  /** District file version (content hash). */
  version: string;
  bounds: Rect;
  streets: Street[];
  nodes: CityNode[];
  segments: Segment[];
  lanes: Lane[];
  connectors: Connector[];
  roads: RoadStrip[];
  tracks: Track[];
  areas: Area[];
  buildings: Building[];
  trees: Tree[];
  playgrounds: Playground[];
  parkedCars: ParkedCar[];
  addresses: Address[];
  depots: Depot[];
  busStops: BusStop[];
  busLines: BusLine[];
  /** Raw timetable section of the district (stops, patterns, calendar). */
  transit: DistrictTransit;
  pois: Poi[];
  /** Fast lookups. */
  segmentByKey: Map<string, number>;
  addressById: Map<string, Address>;
}
