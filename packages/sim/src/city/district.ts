import type { Rect } from '../geometry.js';

/**
 * A district file: real map data for one part of the city, produced offline by the importer
 * and turned into a City by buildCityFromDistrict on both the server and the client.
 */
export interface District extends DistrictPlaces {
  meta: DistrictMeta;
  roads: DistrictRoads;
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
}

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  osm: number;
  signals?: true;
  giveWay?: true;
  stop?: true;
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
  | 'busway';

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
