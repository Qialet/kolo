import { poseAlong, type Vec2 } from '../geometry.js';
import type { City } from './types.js';

/** Point on a lane at arc length `s`, shifted `lateral` metres to the right. Used by the engine and renderer. */
export function lanePoint(city: City, laneId: number, s: number, lateral = 0): Vec2 {
  const p = poseAlong(city.lanes[laneId]!.line, s, lateral);
  return { x: p.x, z: p.z };
}
