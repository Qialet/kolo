import type {
  AreaKind,
  BuildingUse,
  DistrictAddress,
  DistrictArea,
  DistrictBuilding,
  DistrictDepotSite,
  DistrictPlaces,
  DistrictPoi,
  DistrictRoads,
  PoiKind,
} from '../city/district.js';
import { pointInRect, type Rect, type Vec2 } from '../geometry.js';
import { boundsOfBBox, type OsmElement } from './osm-roads.js';
import { clipRing, joinRings, pointInPolygon, polygonCentroid, ringArea, segmentDistance, simplifyRing } from './polygons.js';
import { project, type BBoxDeg } from './project.js';
import { toLatin } from './translit.js';

type Tags = Record<string, string>;

export interface DepotSiteSpec {
  id: string;
  name: string;
  /** OSM way id of the lot. */
  osm: number;
}

/** Partner depots on real surface car parks next to the core network (chosen with the user). */
export const DEPOT_SITES: DepotSiteSpec[] = [
  { id: 'P1', name: 'Avala Fleet', osm: 527970079 },
  { id: 'P2', name: 'Sava Motors', osm: 393230621 },
  { id: 'P3', name: 'Dunav Taxi', osm: 1191458362 },
];

const FLOOR = 3.2;
const SKIP_BUILDINGS = new Set(['no', 'roof', 'bridge', 'wall', 'construction']);
const BUILDING_SIMPLIFY = 0.3;
const AREA_SIMPLIFY = 1;
const MIN_BUILDING = 4;
const MIN_AREA = 20;
const TREE_ROW_STEP = 9;
const BIG_PARK = 30_000;
const POI_SIMPLIFY = 2;

const USE: Record<string, BuildingUse> = {
  apartments: 'residential',
  residential: 'residential',
  dormitory: 'residential',
  house: 'house',
  detached: 'house',
  semidetached_house: 'house',
  terrace: 'house',
  office: 'office',
  hotel: 'office',
  retail: 'retail',
  commercial: 'retail',
  kiosk: 'retail',
  supermarket: 'retail',
  hospital: 'civic',
  school: 'civic',
  university: 'civic',
  college: 'civic',
  kindergarten: 'civic',
  government: 'civic',
  public: 'civic',
  civic: 'civic',
  train_station: 'civic',
  church: 'religious',
  cathedral: 'religious',
  chapel: 'religious',
  mosque: 'religious',
  synagogue: 'religious',
  monastery: 'religious',
  religious: 'religious',
  industrial: 'industrial',
  warehouse: 'industrial',
  service: 'industrial',
  garage: 'industrial',
  garages: 'industrial',
};

const DEFAULT_LEVELS: Record<string, number> = {
  apartments: 5,
  residential: 5,
  house: 2,
  detached: 2,
  office: 6,
  retail: 2,
  commercial: 2,
  hospital: 4,
  school: 4,
  university: 4,
  kiosk: 1,
};
/** Tall single-volume buildings: height in metres, one "floor". */
const DEFAULT_HALL: Record<string, number> = { church: 18, cathedral: 18 };

const POI_WEIGHT: Record<PoiKind, number> = { mall: 3, station: 3, market: 2, hospital: 2, park: 1, university: 1, hotel: 1 };

/** Height and storeys from height, building:levels or the building type. */
export function buildingHeight(t: Tags): { h: number; levels: number } {
  const height = Number.parseFloat(t.height ?? '');
  const levels = Number.parseInt(t['building:levels'] ?? '', 10);
  const hasLevels = Number.isFinite(levels) && levels > 0;
  if (Number.isFinite(height) && height > 0) return { h: round1(height), levels: hasLevels ? levels : Math.max(1, Math.round(height / FLOOR)) };
  if (hasLevels) return { h: round1(levels * FLOOR), levels };
  const hall = DEFAULT_HALL[t.building!];
  if (hall) return { h: hall, levels: 1 };
  const n = DEFAULT_LEVELS[t.building!] ?? 4;
  return { h: round1(n * FLOOR), levels: n };
}

function areaKind(t: Tags): AreaKind | null {
  if (t.natural === 'water' || t.waterway === 'riverbank') return 'water';
  if (t.leisure === 'playground') return 'playground';
  if (t.leisure === 'pitch') return 'pitch';
  if (t.amenity === 'parking' && t.parking === 'surface') return 'parking';
  if (t['area:highway'] === 'pedestrian' || t['area:highway'] === 'footway' || t.place === 'square') return 'plaza';
  if (t.leisure === 'park' || t.leisure === 'garden') return 'park';
  if (t.landuse === 'forest' || t.natural === 'wood') return 'forest';
  if (['grass', 'flowerbed', 'recreation_ground'].includes(t.landuse ?? '') || ['grassland', 'scrub'].includes(t.natural ?? '')) return 'grass';
  return null;
}

function poiKind(t: Tags): PoiKind | null {
  if (t.shop === 'mall') return 'mall';
  if (t.amenity === 'hospital') return 'hospital';
  if (t.railway === 'station' || t.public_transport === 'station' || t.amenity === 'bus_station' || t.amenity === 'ferry_terminal') return 'station';
  if (t.amenity === 'marketplace') return 'market';
  if (t.amenity === 'university' || t.amenity === 'college') return 'university';
  if (t.tourism === 'hotel') return 'hotel';
  if (t.leisure === 'park') return 'park';
  return null;
}

interface Shape {
  outer: Vec2[];
  holes: Vec2[][];
}

const latin = (t: Tags, key: string) => t[`${key}:sr-Latn`] ?? toLatin(t[key] ?? '');
const round1 = (v: number) => Math.round(v * 10) / 10 + 0;
const flat = (ring: Vec2[]) => ring.flatMap((p) => [round1(p.x), round1(p.z)]);
const idOf = (e: OsmElement) => `${e.type[0]}${e.id}`;

/** Buildings, land cover, trees, addresses, places of interest and depot lots of a district. */
export function importPlaces(elements: OsmElement[], bbox: BBoxDeg, roads: DistrictRoads, sites: DepotSiteSpec[] = DEPOT_SITES): DistrictPlaces {
  const bounds = boundsOfBBox(bbox);
  const nodes = new Map<number, OsmElement>();
  for (const e of elements) if (e.type === 'node' && (e.tags || !nodes.has(e.id))) nodes.set(e.id, e);
  const ways = new Map<number, OsmElement>();
  for (const e of elements) if (e.type === 'way') ways.set(e.id, e);
  const xy = new Map<number, Vec2>();
  const pos = (id: number): Vec2 | undefined => {
    let p = xy.get(id);
    if (!p) {
      const n = nodes.get(id);
      if (!n) return undefined;
      p = project({ lat: n.lat!, lon: n.lon! });
      xy.set(id, p);
    }
    return p;
  };
  const ringOf = (ids: number[]): Vec2[] | null => {
    const out: Vec2[] = [];
    for (const id of ids) {
      const p = pos(id);
      if (!p) return null;
      out.push(p);
    }
    return out;
  };

  /** Closed ways and multipolygon relations as outlines with holes. */
  const shapesOf = (e: OsmElement): Shape[] => {
    if (e.type === 'way') {
      const ids = e.nodes ?? [];
      if (ids.length < 4 || ids[0] !== ids[ids.length - 1]) return [];
      const outer = ringOf(ids.slice(0, -1));
      return outer ? [{ outer, holes: [] }] : [];
    }
    if (e.type !== 'relation' || e.tags?.type !== 'multipolygon' || !e.members) return [];
    const chains = (role: (r: string) => boolean) =>
      e.members!.filter((m) => m.type === 'way' && role(m.role) && ways.get(m.ref)?.nodes).map((m) => ways.get(m.ref)!.nodes!);
    const outers = joinRings(chains((r) => r !== 'inner')).map(ringOf).filter((r): r is Vec2[] => !!r);
    const inners = joinRings(chains((r) => r === 'inner')).map(ringOf).filter((r): r is Vec2[] => !!r);
    const shapes = outers.map((outer) => ({ outer, holes: [] as Vec2[][] }));
    for (const inner of inners) shapes.find((s) => pointInPolygon(inner[0]!, s.outer, []))?.holes.push(inner);
    return shapes;
  };

  // ── buildings ──
  const buildings: DistrictBuilding[] = [];
  const shapeOfBuilding = new Map<string, Shape>();
  for (const e of elements) {
    const t = e.tags;
    if (!t?.building || SKIP_BUILDINGS.has(t.building)) continue;
    shapesOf(e).forEach((shape, k) => {
      const outer = simplifyRing(shape.outer, BUILDING_SIMPLIFY);
      if (ringArea(outer) < MIN_BUILDING || !pointInRect(polygonCentroid(outer), bounds)) return;
      const holes = shape.holes.map((h) => simplifyRing(h, BUILDING_SIMPLIFY)).filter((h) => ringArea(h) >= 1);
      const id = k ? `${idOf(e)}-${k + 1}` : idOf(e);
      const b: DistrictBuilding = { id, pts: flat(outer), ...buildingHeight(t), use: USE[t.building!] ?? 'other' };
      if (holes.length) b.holes = holes.map(flat);
      if (t.name) b.name = latin(t, 'name');
      if (t['addr:street'] && t['addr:housenumber']) b.addr = { street: latin(t, 'addr:street'), number: toLatin(t['addr:housenumber']) };
      buildings.push(b);
      shapeOfBuilding.set(id, { outer, holes });
    });
  }
  const buildingAt = buildingLocator(shapeOfBuilding);

  // ── land cover ──
  const areas: DistrictArea[] = [];
  const areaSize = new Map<OsmElement, number>();
  for (const e of elements) {
    const t = e.tags;
    if (!t || t.building) continue;
    const kind = areaKind(t);
    if (!kind) continue;
    for (const shape of shapesOf(e)) {
      const outer = clipRing(simplifyRing(shape.outer, AREA_SIMPLIFY), bounds);
      if (ringArea(outer) < MIN_AREA) continue;
      const holes = shape.holes.map((h) => clipRing(simplifyRing(h, AREA_SIMPLIFY), bounds)).filter((h) => h.length);
      areas.push({ kind, rings: [flat(outer), ...holes.map(flat)] });
      areaSize.set(e, (areaSize.get(e) ?? 0) + ringArea(outer));
    }
  }

  // ── trees ──
  const trees: number[] = [];
  const plant = (p: Vec2) => {
    if (pointInRect(p, bounds)) trees.push(round1(p.x), round1(p.z));
  };
  for (const e of elements) {
    if (e.tags?.natural === 'tree' && e.type === 'node') plant(pos(e.id)!);
    if (e.tags?.natural === 'tree_row' && e.type === 'way') {
      const line = ringOf(e.nodes ?? []);
      if (line) for (const p of sampleLine(line, TREE_ROW_STEP)) plant(p);
    }
  }

  // ── addresses: the building's own first, then entrances and tagged points ──
  const addresses: DistrictAddress[] = [];
  const seen = new Set<string>();
  const addAddress = (a: DistrictAddress) => {
    const key = `${a.street}|${a.number}`;
    if (seen.has(key) || !pointInRect(a, bounds)) return;
    seen.add(key);
    addresses.push(a);
  };
  for (const b of buildings) {
    if (!b.addr) continue;
    const c = polygonCentroid(shapeOfBuilding.get(b.id)!.outer);
    addAddress({ id: b.id, street: b.addr.street, number: b.addr.number, x: round1(c.x), z: round1(c.z), building: b.id });
  }
  for (const e of elements) {
    const t = e.tags;
    if (!t?.['addr:street'] || !t['addr:housenumber'] || (t.building && e.type !== 'node')) continue;
    const p = e.type === 'node' ? pos(e.id) : shapesOf(e)[0] && polygonCentroid(shapesOf(e)[0]!.outer);
    if (!p) continue;
    const a: DistrictAddress = { id: idOf(e), street: latin(t, 'addr:street'), number: toLatin(t['addr:housenumber']), x: round1(p.x), z: round1(p.z) };
    const building = buildingAt(p);
    if (building) a.building = building;
    addAddress(a);
  }

  // ── places of interest ──
  const roadAt = roadDistance(roads);
  const byName = new Map<string, { poi: DistrictPoi; size: number }>();
  for (const e of elements) {
    const t = e.tags;
    const kind = t?.name ? poiKind(t) : null;
    if (!t || !kind) continue;
    let p: Vec2 | undefined;
    let size = 0;
    let outline: number[] | undefined;
    if (e.type === 'node') p = pos(e.id);
    else {
      const shape = shapesOf(e)[0];
      if (!shape) continue;
      size = areaSize.get(e) ?? ringArea(shape.outer);
      outline = flat(simplifyRing(shape.outer, POI_SIMPLIFY));
      p = roads.edges.length ? shape.outer.reduce((best, q) => (roadAt(q) < roadAt(best) ? q : best)) : polygonCentroid(shape.outer);
    }
    if (!p || !pointInRect(p, bounds)) continue;
    const poi: DistrictPoi = { id: idOf(e), name: latin(t, 'name'), kind, weight: POI_WEIGHT[kind], x: round1(p.x), z: round1(p.z) };
    if (kind === 'park' && size > BIG_PARK) poi.weight = 2;
    if (outline) poi.outline = outline;
    const own = t.building && shapeOfBuilding.has(idOf(e)) ? idOf(e) : buildingAt(p);
    if (own) poi.building = own;
    const key = `${kind}|${poi.name}`;
    const prev = byName.get(key);
    if (!prev || size > prev.size) byName.set(key, { poi, size });
  }
  const pois = [...byName.values()].map((x) => x.poi);

  // ── depot lots ──
  const depotSites: DistrictDepotSite[] = [];
  for (const site of sites) {
    const w = ways.get(site.osm);
    const shape = w ? shapesOf(w)[0] : undefined;
    if (shape) depotSites.push({ id: site.id, name: site.name, osm: site.osm, pts: flat(shape.outer) });
  }

  return { buildings, areas, trees, addresses, pois, depotSites };
}

function sampleLine(line: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    for (let s = carry; s <= l; s += step) out.push({ x: a.x + ((b.x - a.x) * s) / l, z: a.z + ((b.z - a.z) * s) / l });
    carry = (((carry - l) % step) + step) % step;
  }
  return out;
}

const CELL = 50;
const cellKey = (cx: number, cz: number) => `${cx},${cz}`;

/** Finds the building containing a point through a coarse grid of outline bounding boxes. */
function buildingLocator(shapes: Map<string, Shape>): (p: Vec2) => string | undefined {
  const grid = new Map<string, string[]>();
  for (const [id, s] of shapes) {
    const r = boxOf(s.outer);
    for (let cx = Math.floor(r.x0 / CELL); cx <= Math.floor(r.x1 / CELL); cx++) {
      for (let cz = Math.floor(r.z0 / CELL); cz <= Math.floor(r.z1 / CELL); cz++) {
        const k = cellKey(cx, cz);
        const list = grid.get(k) ?? [];
        list.push(id);
        grid.set(k, list);
      }
    }
  }
  return (p) => grid.get(cellKey(Math.floor(p.x / CELL), Math.floor(p.z / CELL)))?.find((id) => pointInPolygon(p, shapes.get(id)!.outer, shapes.get(id)!.holes));
}

/** Distance from a point to the nearest drivable road (searched within 200 m). */
function roadDistance(roads: DistrictRoads): (p: Vec2) => number {
  const grid = new Map<string, [Vec2, Vec2][]>();
  for (const e of roads.edges) {
    for (let i = 2; i < e.pts.length; i += 2) {
      const a = { x: e.pts[i - 2]!, z: e.pts[i - 1]! };
      const b = { x: e.pts[i]!, z: e.pts[i + 1]! };
      const k = cellKey(Math.floor((a.x + b.x) / 2 / CELL), Math.floor((a.z + b.z) / 2 / CELL));
      const list = grid.get(k) ?? [];
      list.push([a, b]);
      grid.set(k, list);
    }
  }
  return (p) => {
    let best = Infinity;
    const cx = Math.floor(p.x / CELL);
    const cz = Math.floor(p.z / CELL);
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (const [a, b] of grid.get(cellKey(cx + dx, cz + dz)) ?? []) best = Math.min(best, segmentDistance(p, a, b));
    return best;
  };
}

function boxOf(ring: Vec2[]): Rect {
  return {
    x0: Math.min(...ring.map((p) => p.x)),
    z0: Math.min(...ring.map((p) => p.z)),
    x1: Math.max(...ring.map((p) => p.x)),
    z1: Math.max(...ring.map((p) => p.z)),
  };
}
