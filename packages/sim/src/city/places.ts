import { cross, headingOf, type Rect, type Vec2 } from '../geometry.js';
import { minAreaRect, pointInPolygon, polygonCentroid, segmentDistance } from '../import/polygons.js';
import { createRng } from '../rng.js';
import type { District } from './district.js';
import { lanePoint } from './lanes.js';
import type { Address, Building, City, CurbRef, Lane } from './types.js';

/** Shortest lane that can hold a pick-up point (8 m clear at both ends). */
const MIN_CURB_LANE = 24;
const CURB_END = 8;
/** Entrance: this far behind the kerb, on the sidewalk. */
const ENTRANCE_BEHIND_KERB = 2.2;
const SAME_STREET_REACH = 70;
const ANY_STREET_REACH = 35;
const POI_REACH = 150;
const RING_RANK = 10;
const PARK_TREE_STEP = 11;
const MAX_TREES = 12_000;
/** Rendered car body plus a gap between bumpers. */
const PARK_PITCH = 6.1;
/** Car centre measured from the kerb into the sidewalk: clear of taxis pulled over at the kerb. */
const PARK_INTO_SIDEWALK = 2.75;

const ring = (flat: number[]): Vec2[] => Array.from({ length: flat.length / 2 }, (_, i) => ({ x: flat[2 * i]!, z: flat[2 * i + 1]! }));
const CELL = 50;
const key = (cx: number, cz: number) => `${cx},${cz}`;

/** Coarse uniform grid over line pieces. */
export class SegmentGrid<T> {
  private readonly cells = new Map<string, { a: Vec2; b: Vec2; item: T }[]>();

  add(a: Vec2, b: Vec2, item: T) {
    const x0 = Math.floor(Math.min(a.x, b.x) / CELL);
    const x1 = Math.floor(Math.max(a.x, b.x) / CELL);
    const z0 = Math.floor(Math.min(a.z, b.z) / CELL);
    const z1 = Math.floor(Math.max(a.z, b.z) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const list = this.cells.get(key(cx, cz)) ?? [];
        list.push({ a, b, item });
        this.cells.set(key(cx, cz), list);
      }
    }
  }

  *near(p: Vec2, reach: number) {
    const r = Math.ceil(reach / CELL);
    const cx = Math.floor(p.x / CELL);
    const cz = Math.floor(p.z / CELL);
    const seen = new Set<object>();
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        for (const piece of this.cells.get(key(cx + dx, cz + dz)) ?? []) {
          if (seen.has(piece)) continue;
          seen.add(piece);
          yield piece;
        }
      }
    }
  }
}

export interface CurbHit {
  lane: Lane;
  /** Arc length of the nearest point on the lane. */
  s: number;
  dist: number;
  /** The query point is on the right of the travel direction (the kerb side). */
  right: boolean;
}

/** Curb lanes where vehicles may stop: core network at street level, not bus-only, not on a ring, long enough. */
export class CurbIndex {
  private readonly grid = new SegmentGrid<{ lane: Lane; s0: number }>();

  constructor(private readonly city: City) {
    for (const seg of city.segments) {
      if (!seg.core || seg.psvOnly || seg.rank >= RING_RANK || seg.layer !== 0) continue;
      const lane = city.lanes[seg.lanes[seg.lanes.length - 1]!]!;
      if (lane.length < MIN_CURB_LANE) continue;
      const { points, cum } = lane.line;
      for (let i = 1; i < points.length; i++) this.grid.add(points[i - 1]!, points[i]!, { lane, s0: cum[i - 1]! });
    }
  }

  /** Nearest accepted curb point within `reach`. */
  nearest(p: Vec2, reach: number, accept: (hit: CurbHit) => boolean = () => true): CurbHit | null {
    let best: CurbHit | null = null;
    for (const { a, b, item } of this.grid.near(p, reach)) {
      const d = segmentDistance(p, a, b);
      if (d > reach || (best && d >= best.dist)) continue;
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
      const t = Math.max(0, Math.min(len, (p.x - a.x) * dir.x + (p.z - a.z) * dir.z));
      const hit: CurbHit = { lane: item.lane, s: item.s0 + t, dist: d, right: cross(dir, { x: p.x - a.x, z: p.z - a.z }) > 0 };
      if (accept(hit)) best = hit;
    }
    return best;
  }

  /** Pick-up point on the kerb: same street on the house side, same street, then any street nearby. */
  bind(p: Vec2, street: string | undefined, reach = ANY_STREET_REACH): CurbHit | null {
    const name = (h: CurbHit) => this.city.streets[this.city.segments[h.lane.seg]!.street]!.name;
    if (street) {
      const own = this.nearest(p, SAME_STREET_REACH, (h) => h.right && name(h) === street) ?? this.nearest(p, SAME_STREET_REACH, (h) => name(h) === street);
      if (own) return own;
    }
    return this.nearest(p, reach);
  }

  /** Curb reference and sidewalk entrance for a hit. */
  curb(hit: CurbHit): CurbRef & Vec2 & { street: number } {
    const seg = this.city.segments[hit.lane.seg]!;
    const street = this.city.streets[seg.street]!;
    const s = Math.max(CURB_END, Math.min(hit.lane.length - CURB_END, hit.s));
    const p = lanePoint(this.city, hit.lane.id, s, street.laneWidth / 2 + ENTRANCE_BEHIND_KERB);
    return { lane: hit.lane.id, s, x: p.x, z: p.z, street: seg.street };
  }
}

/** Finds the building containing a point. */
export function buildingIndex(buildings: Pick<Building, 'id' | 'outline' | 'holes'>[]): (p: Vec2) => string | undefined {
  const grid = new Map<string, number[]>();
  buildings.forEach((b, i) => {
    const r = boxOf(b.outline);
    for (let cx = Math.floor(r.x0 / CELL); cx <= Math.floor(r.x1 / CELL); cx++) {
      for (let cz = Math.floor(r.z0 / CELL); cz <= Math.floor(r.z1 / CELL); cz++) {
        const list = grid.get(key(cx, cz)) ?? [];
        list.push(i);
        grid.set(key(cx, cz), list);
      }
    }
  });
  return (p) => {
    for (const i of grid.get(key(Math.floor(p.x / CELL), Math.floor(p.z / CELL))) ?? []) {
      const b = buildings[i]!;
      if (pointInPolygon(p, b.outline, b.holes)) return b.id;
    }
    return undefined;
  };
}

/** Whether a point lies on the paved part of any road. */
export function roadSurface(city: City): (p: Vec2, pad?: number) => boolean {
  const grid = new SegmentGrid<number>();
  for (const road of city.roads) {
    if (road.layer < 0) continue;
    const half = Math.max(road.left, road.right);
    for (let i = 1; i < road.points.length; i++) grid.add(road.points[i - 1]!, road.points[i]!, half);
  }
  return (p, pad = 0) => {
    for (const { a, b, item } of grid.near(p, 30)) if (segmentDistance(p, a, b) < item + pad) return true;
    return false;
  };
}

function boxOf(pts: Vec2[]): Rect {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    z0 = Math.min(z0, p.z);
    x1 = Math.max(x1, p.x);
    z1 = Math.max(z1, p.z);
  }
  return { x0, z0, x1, z1 };
}

const tintOf = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 4;
};

/** Buildings, land cover, addresses, places of interest, trees and playgrounds of a district. */
export function addPlaces(city: City, district: District) {
  for (const a of district.areas) {
    const [outer, ...holes] = a.rings.map(ring);
    city.areas.push({ kind: a.kind, outer: outer!, holes });
  }
  const byId = new Map<string, Building>();
  for (const b of district.buildings) {
    const outline = ring(b.pts);
    const c = polygonCentroid(outline);
    const building: Building = {
      id: b.id,
      outline,
      holes: (b.holes ?? []).map(ring),
      x: c.x,
      z: c.z,
      h: b.h,
      levels: b.levels,
      kind: b.use,
      tint: tintOf(b.id),
      addressId: null,
      name: b.name ?? null,
    };
    city.buildings.push(building);
    byId.set(b.id, building);
  }

  const curbs = new CurbIndex(city);
  const addAddress = (a: Address) => {
    city.addresses.push(a);
    city.addressById.set(a.id, a);
  };
  for (const a of district.addresses) {
    const hit = curbs.bind(a, a.street);
    if (!hit) continue;
    const { street, ...curb } = curbs.curb(hit);
    const address: Address = { id: `A${a.id}`, label: `${a.street} ${a.number}`, street, number: a.number, ...curb, buildingId: a.building ?? null, poi: null };
    addAddress(address);
    const b = a.building ? byId.get(a.building) : undefined;
    if (b && !b.addressId) b.addressId = address.id;
  }

  for (const p of district.pois) {
    const own = p.building ? byId.get(p.building)?.addressId : null;
    const base = own ? city.addressById.get(own)! : null;
    let address: Address;
    if (base) {
      address = { ...base, id: `AP${p.id}`, label: `${p.name}, ${base.label}`, poi: p.id };
    } else {
      // A large park may face the core network on another side than its arrival point.
      let hit = curbs.bind(p, undefined, POI_REACH);
      for (const q of hit ? [] : ring(p.outline ?? [])) {
        const h = curbs.nearest(q, POI_REACH);
        if (h && (!hit || h.dist < hit.dist)) hit = h;
      }
      if (!hit) continue;
      const { street, ...curb } = curbs.curb(hit);
      address = { id: `AP${p.id}`, label: `${p.name}, ${city.streets[street]!.name}`, street, number: '', ...curb, buildingId: p.building ?? null, poi: p.id };
    }
    addAddress(address);
    city.pois.push({ id: p.id, name: p.name, kind: p.kind, addressId: address.id, weight: p.weight, x: p.x, z: p.z });
  }

  plantTrees(city, district);
  for (const a of city.areas) {
    if (a.kind !== 'playground') continue;
    const box = minAreaRect(a.outer);
    const variant = Math.round(Math.abs(box.center.x * 7 + box.center.z * 13)) % 3;
    city.playgrounds.push({ x: box.center.x, z: box.center.z, w: box.len, d: box.wid, rot: Math.atan2(-box.u.z, box.u.x), variant });
  }
}

/** Real trees plus a loose grid in parks and woods, kept off buildings, water, plazas and roads. */
function plantTrees(city: City, district: District) {
  for (let i = 0; i < district.trees.length; i += 2) city.trees.push({ x: district.trees[i]!, z: district.trees[i + 1]!, r: 2.6, h: 7.5 });
  const inBuilding = buildingIndex(city.buildings);
  const onRoad = roadSurface(city);
  const blocked = city.areas.filter((a) => a.kind === 'water' || a.kind === 'plaza' || a.kind === 'pitch' || a.kind === 'playground').map((a) => ({ a, box: boxOf(a.outer) }));
  const free = (p: Vec2) => !inBuilding(p) && !onRoad(p, 2) && !blocked.some(({ a, box }) => p.x >= box.x0 && p.x <= box.x1 && p.z >= box.z0 && p.z <= box.z1 && pointInPolygon(p, a.outer, a.holes));
  city.areas.forEach((area, i) => {
    if (area.kind !== 'park' && area.kind !== 'forest') return;
    const rng = createRng(1389 + i);
    const box = boxOf(area.outer);
    for (let x = box.x0 + PARK_TREE_STEP / 2; x < box.x1; x += PARK_TREE_STEP) {
      for (let z = box.z0 + PARK_TREE_STEP / 2; z < box.z1; z += PARK_TREE_STEP) {
        if (city.trees.length >= MAX_TREES) return;
        const p = { x: x + rng.range(-3, 3), z: z + rng.range(-3, 3) };
        if (rng.chance(area.kind === 'forest' ? 0.1 : 0.3) || !pointInPolygon(p, area.outer, area.holes) || !free(p)) continue;
        city.trees.push({ ...p, r: rng.range(3, 5), h: rng.range(7, 12) });
      }
    }
  });
}

/**
 * Cars parked on the sidewalks of residential streets: never at entrances, depot gates, in
 * buildings or on another road's asphalt. Runs after depots are laid out.
 */
export function parkCars(city: City) {
  const rng = createRng(104729);
  const blocked = new Map<number, [number, number][]>();
  const block = (lane: number, s0: number, s1: number) => {
    const list = blocked.get(lane) ?? [];
    list.push([s0, s1]);
    blocked.set(lane, list);
  };
  for (const a of city.addresses) block(a.lane, a.s - 3.4, a.s + 3.4);
  for (const st of city.busStops) block(st.lane, st.s - 22, st.s + 9);
  for (const d of city.depots) block(d.curb.lane, d.curb.s - 11, d.curb.s + 11);
  const inBuilding = buildingIndex(city.buildings);
  const onRoad = roadSurface(city);

  for (const seg of city.segments) {
    if (!seg.core || seg.psvOnly || seg.rank > 2 || seg.layer !== 0) continue;
    const street = city.streets[seg.street]!;
    const lane = city.lanes[seg.lanes[seg.lanes.length - 1]!]!;
    const spans = blocked.get(lane.id) ?? [];
    const fill = rng.range(0.35, 0.85);
    const lateral = street.laneWidth / 2 + PARK_INTO_SIDEWALK;
    for (let s = 9 + PARK_PITCH / 2; s < lane.length - 9 - PARK_PITCH / 2; s += PARK_PITCH) {
      const half = PARK_PITCH / 2;
      if (spans.some(([s0, s1]) => s + half > s0 && s - half < s1)) continue;
      if (!rng.chance(fill)) continue;
      const at = s + rng.range(-0.3, 0.3);
      const ends = [lanePoint(city, lane.id, at - 2.2, lateral), lanePoint(city, lane.id, at + 2.2, lateral)];
      const p = lanePoint(city, lane.id, at, lateral);
      if ([p, ...ends].some((q) => inBuilding(q) || onRoad(q, 0.4))) continue;
      city.parkedCars.push({ x: p.x, z: p.z, heading: headingOf({ x: ends[1]!.x - ends[0]!.x, z: ends[1]!.z - ends[0]!.z }), tint: rng.int(0, 6) });
    }
  }
}
