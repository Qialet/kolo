import type { Vec2 } from '../geometry.js';

export interface LatLon {
  lat: number;
  lon: number;
}

export interface BBoxDeg {
  s: number;
  w: number;
  n: number;
  e: number;
}

/**
 * Fixed origin of the world for every Belgrade district: the centre of the Slavija roundabout.
 * It never moves when districts are added, so stored coordinates stay valid.
 */
export const BELGRADE_ANCHOR: LatLon = { lat: 44.80248, lon: 20.46632 };

/** Right bank: Kalemegdan – Hram Svetog Save, Savamala – Tašmajdan. */
export const BELGRADE_BBOX: BBoxDeg = { s: 44.798, w: 20.447, n: 44.8235, e: 20.473 };

const EARTH_RADIUS = 6371008.8;
const M_PER_DEG = (EARTH_RADIUS * Math.PI) / 180;
const COS_LAT0 = Math.cos((BELGRADE_ANCHOR.lat * Math.PI) / 180);

/** Equirectangular projection around the anchor: x east, z south, metres (sub-metre error over a few km). */
export function project(p: LatLon): Vec2 {
  return {
    x: (p.lon - BELGRADE_ANCHOR.lon) * M_PER_DEG * COS_LAT0 + 0,
    z: -(p.lat - BELGRADE_ANCHOR.lat) * M_PER_DEG + 0,
  };
}

export function unproject(p: Vec2): LatLon {
  return { lat: BELGRADE_ANCHOR.lat - p.z / M_PER_DEG, lon: BELGRADE_ANCHOR.lon + p.x / (M_PER_DEG * COS_LAT0) };
}
