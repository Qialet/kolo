import type { Rect } from '../geometry.js';
import type { TransitCalendar } from '../transit/calendar.js';

/**
 * A district file: real map data for one part of the city, produced offline by the importer
 * and turned into a City by buildCityFromDistrict on both the server and the client.
 */
export interface District extends DistrictPlaces {
  meta: DistrictMeta;
  roads: DistrictRoads;
  transit: DistrictTransit;
}

/** Public transport from GTFS, cut to the district frame (empty when there was no feed). */
export interface DistrictTransit {
  /** Feed version and validity, dates YYYYMMDD. */
  feed: { version: string; start: string; end: string } | null;
  calendar: TransitCalendar;
  stops: DistrictStop[];
  lines: DistrictLine[];
  patterns: DistrictPattern[];
}

export interface DistrictStop {
  /** GTFS stop_id. */
  id: string;
  /** Number on the pole (stop_code). */
  code: string;
  /** Latin script. */
  name: string;
  x: number;
  z: number;
  /** Mean unit direction of travel along the shapes at the stop, 0.01 precision. */
  dir: [number, number];
  /** OSM maps a bus bay on the road at the stop, on its side of travel. */
  bay?: true;
}

export type TransitMode = 'bus' | 'trolley' | 'minibus' | 'tram';

export interface DistrictLine {
  /** GTFS route_id. */
  id: string;
  /** Short name on the vehicle (route_short_name). */
  name: string;
  longName: string;
  mode: TransitMode;
  /** #RRGGBB of the line and of its label text. */
  color: string;
  text: string;
}

/** Trips of one line that serve the same in-frame stops in the same order. */
export interface DistrictPattern {
  /** Index into lines. */
  line: number;
  /** GTFS direction_id. */
  dir: number;
  headsign: string;
  /** Indices into stops, in travel order. */
  stops: number[];
  /** Flat x, z pairs of the trip shape inside the frame plus 50 m, simplified to 2 m. */
  shape: number[];
  /** Trips come from stops outside the frame (enter) or go on past it (exit). */
  enter: boolean;
  exit: boolean;
  profiles: DistrictProfile[];
}

/** Trips of a pattern with identical relative times. */
export interface DistrictProfile {
  /** Flat arrival, departure pairs per stop, seconds from the departure at the first stop. */
  t: number[];
  /** Seconds from that departure when the trip crosses the frame inwards (negative) and outwards. */
  enter?: number;
  exit?: number;
  /** Per service id: delta-coded ascending seconds of day of that departure (may exceed 86 400). */
  starts: Record<string, number[]>;
}

/** Everything off the road graph: buildings, land cover, addresses, places of interest, depot sites. */
export interface DistrictPlaces {
  buildings: DistrictBuilding[];
  areas: DistrictArea[];
  /** Flat x, z pairs of single trees. */
  trees: number[];
  addresses: DistrictAddress[];
  pois: DistrictPoi[];
  depotSites: DistrictDepotSite[];
}

export type BuildingUse = 'residential' | 'house' | 'office' | 'retail' | 'civic' | 'religious' | 'industrial' | 'other';

export interface DistrictBuilding {
  /** OSM element: w123 (way) or r123 (relation; r123-2 for its second outer ring). */
  id: string;
  /** Flat x, z pairs of the outer ring, not closed. */
  pts: number[];
  holes?: number[][];
  /** Height in metres. */
  h: number;
  levels: number;
  use: BuildingUse;
  name?: string;
  addr?: { street: string; number: string };
}

export type AreaKind = 'water' | 'park' | 'grass' | 'forest' | 'plaza' | 'pitch' | 'parking' | 'playground';

export interface DistrictArea {
  kind: AreaKind;
  /** Flat x, z rings: the first is the outline, the rest are holes. */
  rings: number[][];
}

export interface DistrictAddress {
  /** n123 / w123 / r123 of the tagged OSM element. */
  id: string;
  street: string;
  number: string;
  x: number;
  z: number;
  /** Building the address belongs to. */
  building?: string;
}

export type PoiKind = 'mall' | 'hospital' | 'station' | 'market' | 'university' | 'hotel' | 'park';

export interface DistrictPoi {
  id: string;
  name: string;
  kind: PoiKind;
  weight: number;
  /** Arrival point: the node itself, or the outline vertex closest to a drivable road. */
  x: number;
  z: number;
  building?: string;
  /** Flat x, z outline of an area POI (simplified), for places whose arrival point is far from the core. */
  outline?: number[];
}

/** A real lot chosen for a partner depot; the yard is laid out by packages/sim. */
export interface DistrictDepotSite {
  id: string;
  name: string;
  osm: number;
  /** Flat x, z pairs of the lot outline, not closed. */
  pts: number[];
}

export interface DistrictMeta {
  id: string;
  name: string;
  /** Projection origin shared by all districts. */
  anchor: { lat: number; lon: number };
  bboxDeg: { s: number; w: number; n: number; e: number };
  /** District frame in world metres. */
  bounds: Rect;
  osmTimestamp: string;
  gtfsVersion: string | null;
  /** Content hash; client and server compare it on connect. */
  version: string;
}

export interface DistrictRoads {
  nodes: RoadNode[];
  edges: RoadEdge[];
  restrictions: TurnRestriction[];
  /** Marked pedestrian crossings on the streets: x, z pairs. */
  crossings?: number[];
  /** Tracks no tram runs on in the model (yards, sidings, two-way track, the railway), drawn only: x, z pairs per track. */
  scenery?: number[][];
  /** Paved ways no vehicle drives in the model (service roads, streets left out of the graph, pedestrian streets, paths), drawn only. */
  paths?: DistrictPath[];
}

/** road: a street left out of the graph; service: driveways, yards and parking aisles; pedestrian: pedestrian streets; footway: paths, steps and cycleways off the streets. */
export type PathKind = 'road' | 'service' | 'pedestrian' | 'footway';

export interface DistrictPath {
  kind: PathKind;
  /** Paved width, metres. */
  w: number;
  /** Centre line: x, z pairs. */
  pts: number[];
}

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  osm: number;
  signals?: true;
  giveWay?: true;
  stop?: true;
  /** All-way stop (OSM stop=all): every approach of the junction stops. */
  stopAll?: true;
  /** Unit travel direction (x, z) of the traffic a give way or stop sign faces, 0.01 precision; absent when OSM gives no direction. */
  signDir?: [number, number];
  /** Cut by the district frame: traffic enters and leaves the world here. */
  boundary?: true;
}

export type RoadClass =
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'unclassified'
  | 'residential'
  | 'living_street'
  | 'busway'
  /** A one-way tram track (railway=tram): its own lane, trams only. */
  | 'tram';

/** A road between two graph nodes, stored in its forward direction. */
export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  /** Flat x, z pairs from a to b, 0.1 m precision. */
  pts: number[];
  name: string;
  cls: RoadClass;
  /** Is a link road (on/off ramp). */
  link?: true;
  lanesFwd: number;
  lanesBwd: number;
  /** m/s */
  speed: number;
  layer: number;
  tunnel?: true;
  bridge?: true;
  roundabout?: true;
  psvOnly?: true;
  trolley?: true;
  /** OSM turn:lanes for each direction ("left|through;right"). */
  turnFwd?: string;
  turnBwd?: string;
  osm: number;
}

/** OSM turn restriction resolved onto edges: from edge, via node, to edge. */
export interface TurnRestriction {
  from: number;
  via: number;
  to: number;
  /** only_* (every other turn from `from` at `via` is forbidden) vs no_*. */
  only: boolean;
}
