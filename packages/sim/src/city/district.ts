import type { Rect } from '../geometry.js';

/**
 * A district file: real map data for one part of the city, produced offline by the importer
 * and turned into a City by buildCityFromDistrict on both the server and the client.
 */
export interface District {
  meta: DistrictMeta;
  roads: DistrictRoads;
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
