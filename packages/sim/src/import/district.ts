import type { District } from '../city/district.js';
import { DEPOT_SITES, importPlaces, type DepotSiteSpec } from './osm-places.js';
import { boundsOfBBox, importRoads, type OsmElement } from './osm-roads.js';
import { BELGRADE_ANCHOR, type BBoxDeg } from './project.js';

export interface DistrictOptions {
  id: string;
  name: string;
  bbox: BBoxDeg;
  osmTimestamp: string;
  /** Real lots for partner depots (defaults to the agreed Belgrade sites). */
  depotSites?: DepotSiteSpec[];
}

/** Assembles a district file from raw OSM elements; meta.version hashes everything else. */
export function buildDistrict(elements: OsmElement[], opts: DistrictOptions): District {
  const roads = importRoads(elements, opts.bbox);
  const district: District = {
    meta: {
      id: opts.id,
      name: opts.name,
      anchor: { ...BELGRADE_ANCHOR },
      bboxDeg: { ...opts.bbox },
      bounds: boundsOfBBox(opts.bbox),
      osmTimestamp: opts.osmTimestamp,
      gtfsVersion: null,
      version: '',
    },
    roads,
    ...importPlaces(elements, opts.bbox, roads, opts.depotSites ?? DEPOT_SITES),
  };
  district.meta.version = fnv1a(JSON.stringify(district));
  return district;
}

/** 32-bit FNV-1a as 8 hex digits. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
