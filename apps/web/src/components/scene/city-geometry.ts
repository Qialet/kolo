import { BAY_BACK, BAY_FWD, BAY_TAPER_IN, BAY_WIDTH, poseAlong, type AreaKind, type Building, type BusStop, type City, type Lane, type Vec2 } from '@kolo/sim';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { chunkCells } from '@/lib/lod';
import { palette } from '@/lib/palette';

const tmpColor = new THREE.Color();

/** Ground levels: vehicles drive at y = 0, everything flat sits a little below or above. */
export const LEVEL = { ground: -0.12, road: 0, ballast: 0.008, marking: 0.02, rail: 0.03, depotLot: 0.005, depotLines: 0.025, platform: 0.18 } as const;
const AREA_LEVEL: Record<AreaKind, number> = {
  parking: -0.11,
  plaza: -0.105,
  grass: -0.1,
  park: -0.095,
  forest: -0.09,
  pitch: -0.085,
  playground: -0.08,
  water: -0.075,
};
const AREA_COLOR: Record<AreaKind, string> = {
  parking: palette.parking,
  plaza: palette.plaza,
  grass: palette.lawn,
  park: palette.park,
  forest: palette.forest,
  pitch: palette.pitch,
  playground: palette.playPad,
  water: palette.water,
};

/** Axis-aligned box with a vertical colour gradient baked into vertex colours. */
export function gradientBox(w: number, h: number, d: number, x: number, y: number, z: number, top: string, bottom = top) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  const pos = g.attributes.position!;
  const colors = new Float32Array(pos.count * 3);
  const cTop = new THREE.Color(top);
  const cBottom = new THREE.Color(bottom);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - y) / h;
    tmpColor.copy(cBottom).lerp(cTop, t);
    colors.set([tmpColor.r, tmpColor.g, tmpColor.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function paint(g: THREE.BufferGeometry, color: string) {
  const c = new THREE.Color(color);
  const colors = new Float32Array(g.attributes.position!.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/** Flat quad lying on the ground, centred at (x, z), its local z axis turned to `heading`. */
function quad(w: number, d: number, x: number, y: number, z: number, color: string, heading = 0) {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  if (heading) g.rotateY(heading);
  g.translate(x, y, z);
  return paint(g, color);
}

/** Ground geometry from a flat triangle list, every triangle turned to face up. */
function upward(pos: number[] | Float32Array): THREE.BufferGeometry {
  const arr = Float32Array.from(pos);
  for (let i = 0; i < arr.length; i += 9) {
    const ux = arr[i + 3]! - arr[i]!;
    const uz = arr[i + 5]! - arr[i + 2]!;
    const vx = arr[i + 6]! - arr[i]!;
    const vz = arr[i + 8]! - arr[i + 2]!;
    // y of (u × v): negative means the face looks down.
    if (uz * vx - ux * vz < 0) {
      for (let k = 0; k < 3; k++) [arr[i + 3 + k], arr[i + 6 + k]] = [arr[i + 6 + k]!, arr[i + 3 + k]!];
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  g.computeVertexNormals();
  return g;
}

/** Merges parts into one geometry; every part is reduced to position, normal and colour so they match. */
const merge = (parts: THREE.BufferGeometry[]) => {
  if (!parts.length) return new THREE.BufferGeometry();
  const flat = parts.map((p) => {
    const g = p.index ? p.toNonIndexed() : p;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    return g;
  });
  const g = mergeGeometries(flat);
  for (const p of parts) p.dispose();
  if (!g) throw new Error('Could not merge city geometry');
  return g;
};

/** Flat polygon with holes at height y (triangulated in the ground plane). */
export function flatPolygon(outer: Vec2[], holes: Vec2[][], y: number, color: string): THREE.BufferGeometry {
  const contour = outer.map((p) => new THREE.Vector2(p.x, p.z));
  const holeRings = holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.z)));
  if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
  for (const h of holeRings) if (!THREE.ShapeUtils.isClockWise(h)) h.reverse();
  const tris = THREE.ShapeUtils.triangulateShape(contour, holeRings);
  const pts = [...contour, ...holeRings.flat()];
  const pos = new Float32Array(tris.length * 9);
  tris.forEach(([a, b, c], i) => [a!, b!, c!].forEach((k, j) => pos.set([pts[k]!.x, y, pts[k]!.y], i * 9 + j * 3)));
  return paint(upward(pos), color);
}

/** Ribbon along a polyline, `left` / `right` metres to either side (mitred joins). */
function ribbon(points: Vec2[], left: number, right: number, y: number, color: string): THREE.BufferGeometry | null {
  if (points.length < 2) return null;
  const normals: Vec2[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    normals.push({ x: -(b.z - a.z) / l, z: (b.x - a.x) / l });
  }
  const side = (i: number): Vec2 => {
    const n1 = normals[Math.max(0, i - 1)]!;
    const n2 = normals[Math.min(normals.length - 1, i)]!;
    const m = { x: n1.x + n2.x, z: n1.z + n2.z };
    const l = Math.hypot(m.x, m.z) || 1;
    const k = Math.max(0.5, (m.x * n1.x + m.z * n1.z) / l);
    return { x: m.x / l / k, z: m.z / l / k };
  };
  const pos: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const na = side(i - 1);
    const nb = side(i);
    const al = [a.x - na.x * left, y, a.z - na.z * left];
    const ar = [a.x + na.x * right, y, a.z + na.z * right];
    const bl = [b.x - nb.x * left, y, b.z - nb.z * left];
    const br = [b.x + nb.x * right, y, b.z + nb.z * right];
    pos.push(...al, ...ar, ...br, ...al, ...br, ...bl);
  }
  return paint(upward(pos), color);
}

const laneWidth = (city: City, lane: Lane) => city.streets[city.segments[lane.seg]!.street]!.laneWidth;
const isRail = (city: City, lane: number) => !!city.segments[city.lanes[lane]!.seg]!.rail;
/** Street segments among a node's legs (tram tracks left out). */
const roadLegs = (city: City, segs: number[]) => segs.filter((s) => !city.segments[s]!.rail);

/** Whether a closed outline crosses itself (any two non-adjacent edges intersect). */
function selfIntersects(ring: Vec2[]): boolean {
  const n = ring.length;
  const side = (a: Vec2, b: Vec2, c: Vec2) => Math.sign((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j]!;
      const d = ring[(j + 1) % n]!;
      if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return true;
    }
  }
  return false;
}

/** Junction pad: its outline triangulated, or a fan from the junction centre when the outline crosses itself. */
function padGeometry(outline: Vec2[], centre: Vec2, y: number, color: string): THREE.BufferGeometry {
  if (!selfIntersects(outline)) return flatPolygon(outline, [], y, color);
  const pos: number[] = [];
  outline.forEach((a, i) => {
    const b = outline[(i + 1) % outline.length]!;
    pos.push(centre.x, y, centre.z, a.x, y, a.z, b.x, y, b.z);
  });
  return paint(upward(pos), color);
}

/** Pavement under the district (beyond it, the sky plane) and land cover polygons. */
export function buildGroundGeometry(city: City) {
  const b = city.bounds;
  const m = 300;
  const parts: THREE.BufferGeometry[] = [quad(b.x1 - b.x0 + 2 * m, b.z1 - b.z0 + 2 * m, (b.x0 + b.x1) / 2, LEVEL.ground, (b.z0 + b.z1) / 2, palette.sidewalk)];
  for (const a of city.areas) parts.push(flatPolygon(a.outer, a.holes, AREA_LEVEL[a.kind], AREA_COLOR[a.kind]));
  return merge(parts);
}

/** Stops at a kerb (not on a track), with their curb lane and the kerb's offset from its centre. */
function curbStops(city: City) {
  return city.busStops
    .filter((stop) => !isRail(city, stop.lane))
    .map((stop) => {
      const lane = city.lanes[stop.lane]!;
      return { stop, lane, kerb: laneWidth(city, lane) / 2 };
    });
}

/** Span of a stop's bay along its lane (clipped to the lane) and the bay's width beyond the kerb at `at`. */
function bayAt(stop: BusStop, lane: Lane) {
  const start = stop.s - BAY_BACK;
  const end = stop.s + BAY_FWD;
  const width = (at: number) => BAY_WIDTH * Math.max(0, Math.min(1, (at - start) / BAY_TAPER_IN, (end - at) / BAY_FWD));
  return { s0: Math.max(0, start), s1: Math.min(lane.length, end), full: start + BAY_TAPER_IN, width };
}

/** Bay outline: the kerb line from the start of the bay to its end, back along its tapered outer edge. */
function bayOutline(stop: BusStop, lane: Lane, kerb: number): Vec2[] {
  const { s0, s1, width } = bayAt(stop, lane);
  const inner: Vec2[] = [];
  const outer: Vec2[] = [];
  for (let at = s0; ; at = Math.min(s1, at + 1)) {
    inner.push(poseAlong(lane.line, at, kerb - 0.05));
    outer.push(poseAlong(lane.line, at, kerb + width(at)));
    if (at >= s1) break;
  }
  return [...inner, ...outer.reverse()];
}

/** Asphalt: a strip per road, a pad per junction and the bus bays. */
export function buildRoadGeometry(city: City) {
  const parts: THREE.BufferGeometry[] = [];
  for (const r of city.roads) {
    // Tunnels run under the blocks: drawing them on the ground would cut through courtyards.
    if (r.layer < 0) continue;
    const g = ribbon(r.points, r.left, r.right, LEVEL.road, palette.asphalt);
    if (g) parts.push(g);
  }
  for (const pad of city.pads) if (pad.layer >= 0) parts.push(padGeometry(pad.outline, city.nodes[pad.node]!, LEVEL.road + 0.001, palette.asphalt));
  // Bus bays cut into the sidewalk, just under the street's own asphalt where they meet.
  for (const { stop, lane, kerb } of curbStops(city)) if (stop.bay) parts.push(flatPolygon(bayOutline(stop, lane, kerb), [], LEVEL.road - 0.002, palette.asphalt));
  return merge(parts);
}

/** Dashes along a lane line `lateral` metres to its right. */
function dashes(parts: THREE.BufferGeometry[], lane: Lane, lateral: number, dash: number, gap: number) {
  for (let s = 1.5; s + dash < lane.length - 1; s += dash + gap) {
    const p = poseAlong(lane.line, s + dash / 2, lateral);
    parts.push(quad(0.14, dash, p.x, LEVEL.marking, p.z, palette.marking, p.heading));
  }
}

/** Zigzag line `lateral` metres right of a lane, swinging `swing` metres further across, from s0 to s1. */
function zigzag(parts: THREE.BufferGeometry[], lane: Lane, s0: number, s1: number, lateral: number, swing: number, color: string) {
  const step = 1.5;
  let prev = poseAlong(lane.line, s0, lateral);
  for (let k = 1; s0 + k * step <= s1; k++) {
    const p = poseAlong(lane.line, s0 + k * step, lateral + (k % 2 ? swing : 0));
    const dx = p.x - prev.x;
    const dz = p.z - prev.z;
    parts.push(quad(0.12, Math.hypot(dx, dz) + 0.06, (p.x + prev.x) / 2, LEVEL.marking, (p.z + prev.z) / 2, color, Math.atan2(dx, dz)));
    prev = p;
  }
}

/** Stop markings in the stops' cobalt: a zigzag at the kerb where buses stand in the lane; at a bay a broken line along the lane edge and the zigzag inside the bay. */
function stopMarkings(city: City, parts: THREE.BufferGeometry[]) {
  for (const { stop, lane, kerb } of curbStops(city)) {
    if (!stop.bay) {
      zigzag(parts, lane, Math.max(0.5, stop.s - 18), stop.s, kerb - 0.25, -0.6, palette.bus);
      continue;
    }
    const { s0, s1, full } = bayAt(stop, lane);
    for (let at = s0 + 0.5; at + 1 <= s1; at += 2) {
      const p = poseAlong(lane.line, at + 0.5, kerb);
      parts.push(quad(0.15, 1, p.x, LEVEL.marking, p.z, palette.bus, p.heading));
    }
    zigzag(parts, lane, Math.max(s0, full), stop.s, kerb + BAY_WIDTH - 0.25, -0.6, palette.bus);
  }
}

/** Centre lines, lane lines, stop lines at unsignalised approaches, zebra crossings and stop markings. */
export function buildMarkingsGeometry(city: City) {
  const parts: THREE.BufferGeometry[] = [];
  for (const seg of city.segments) {
    if (seg.layer < 0 || seg.rail) continue;
    const lanes = seg.lanes.map((l) => city.lanes[l]!);
    const w = laneWidth(city, lanes[0]!);
    // Centre line once per two-way pair, on the left edge of the inner lane.
    if (seg.reverse > seg.id) dashes(parts, lanes[0]!, -w / 2, 3, 4);
    for (let i = 0; i + 1 < lanes.length; i++) dashes(parts, lanes[i]!, w / 2, 3, 6);
    const to = city.nodes[seg.to]!;
    if (!to.signal && !to.boundary && roadLegs(city, to.in).length + roadLegs(city, to.out).length > 2) {
      for (const lane of lanes) {
        const p = poseAlong(lane.line, lane.length - 0.25);
        parts.push(quad(w, 0.45, p.x, LEVEL.marking + 0.001, p.z, palette.marking, p.heading));
      }
    }
  }
  // Zebras at the crossings OSM marks: stripes along the road across its whole paved width.
  for (const c of city.crossings) {
    const side = { x: Math.cos(c.heading), z: -Math.sin(c.heading) };
    for (let t = -c.left + 0.55; t < c.right - 0.3; t += 1.1) {
      parts.push(quad(0.55, 2.8, c.x - side.x * t, LEVEL.marking, c.z - side.z * t, palette.marking, c.heading));
    }
  }
  stopMarkings(city, parts);
  return merge(parts);
}

/** Partner yards: the violet lot surface and slot separators. */
export function buildDepotGeometry(city: City) {
  const lots: THREE.BufferGeometry[] = [];
  const lines: THREE.BufferGeometry[] = [];
  for (const depot of city.depots) {
    lots.push(flatPolygon(depot.lot, [], LEVEL.depotLot, palette.depotLot));
    for (const slot of depot.slots) {
      // Two separators per slot, parallel to the car.
      const side = { x: Math.cos(slot.heading), z: -Math.sin(slot.heading) };
      for (const k of [-1.3, 1.3]) lines.push(quad(0.12, 5, slot.x + side.x * k, LEVEL.depotLines, slot.z + side.z * k, palette.depot, slot.heading));
    }
  }
  return { lots: merge(lots), lines: merge(lines) };
}

/** Box with a flat vertex colour, rotated around Z (tilt) and Y, bottom at y. */
function part(w: number, h: number, d: number, color: string, x: number, y: number, z: number, rotY: number, tilt = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (tilt) g.rotateX(tilt);
  g.translate(0, h / 2, 0);
  g.rotateY(rotY);
  g.translate(x, y, z);
  return paint(g, color);
}

/** Playgrounds: soft pad, sandbox, swings, a climbing tower with a slide and benches. */
export function buildPlaygroundGeometry(city: City) {
  const parts: THREE.BufferGeometry[] = [];
  const base = AREA_LEVEL.playground + 0.01;
  for (const pg of city.playgrounds) {
    if (pg.w < 6 || pg.d < 4) continue;
    const long = pg.w;
    const short = pg.d;
    // Local frame of the pad: u along its long side, v across, turned by pg.rot like three.js rotateY.
    const c = Math.cos(pg.rot);
    const s = Math.sin(pg.rot);
    const at = (u: number, v: number) => ({ x: pg.x + u * c + v * s, z: pg.z - u * s + v * c });
    const rot = pg.rot + Math.PI / 2;
    const put = (w: number, h: number, d: number, color: string, u: number, y: number, v: number, tilt = 0) => {
      const p = at(u, v);
      parts.push(part(w, h, d, color, p.x, base + y, p.z, rot, tilt));
    };
    const slots = [-0.3, 0.02, 0.3].map((k) => k * long);
    const order = [[0, 1, 2], [2, 0, 1], [1, 2, 0]][pg.variant % 3]!;
    const sand = slots[order[0]!]!;
    put(3.2, 0.28, 3.2, palette.marking, sand, 0, 0);
    put(2.7, 0.3, 2.7, palette.playSand, sand, 0, 0);
    const swing = slots[order[1]!]!;
    for (const v of [-1.5, 1.5]) put(0.14, 2.4, 0.14, palette.playFrame, swing, 0, v);
    put(3.1, 0.12, 0.12, palette.playFrame, swing, 2.3, 0);
    for (const v of [-0.6, 0.6]) {
      put(0.04, 1.6, 0.04, palette.playFrame, swing, 0.75, v);
      put(0.5, 0.06, 0.4, palette.playSeat, swing, 0.7, v);
    }
    const tower = slots[order[2]!]!;
    put(1.8, 1.5, 1.8, palette.playFrame, tower, 0, -0.6);
    put(2.1, 0.12, 2.1, palette.playSlide, tower, 1.5, -0.6);
    put(1.2, 0.9, 1.2, palette.playSlide, tower, 1.62, -0.6);
    const dir = tower > 0.5 ? -1 : 1;
    put(0.8, 0.08, 3, palette.playSlide, tower + dir * 2.3, 0.75, -0.6, dir > 0 ? 0.45 : -0.45);
    for (const v of [-short / 2 + 0.5, short / 2 - 0.5]) put(0.45, 0.45, long * 0.18, palette.trunk, -long * 0.15 * Math.sign(v), 0, v);
  }
  return merge(parts);
}

/** Building tint by use: partner yards and public buildings stand out a little. */
export function buildingTint(b: Building): string {
  if (b.kind === 'garage') return '#FFE2D6';
  if (b.kind === 'depot-office') return '#E6E0FF';
  if (b.kind === 'civic') return palette.poiTint;
  if (b.kind === 'religious') return '#F4EEE4';
  return palette.buildingTints[b.tint % palette.buildingTints.length]!;
}

/** Footprint extruded to the building height (shape space is x, -z; extrusion becomes y). */
export function extrudeBuilding(b: Building): THREE.BufferGeometry {
  const toShape = (ring: Vec2[]) => ring.map((p) => new THREE.Vector2(p.x, -p.z));
  const outer = toShape(b.outline);
  if (THREE.ShapeUtils.isClockWise(outer)) outer.reverse();
  const shape = new THREE.Shape(outer);
  for (const h of b.holes) {
    const hole = toShape(h);
    if (!THREE.ShapeUtils.isClockWise(hole)) hole.reverse();
    shape.holes.push(new THREE.Path(hole));
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: b.h, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, LEVEL.ground, 0);
  return g;
}

export interface BuildingChunk {
  key: string;
  geometry: THREE.BufferGeometry;
  /** City building indexes in this chunk, in mesh order. */
  buildings: number[];
  /** First triangle of every building of the chunk, plus the total, for picking. */
  firstTriangle: Uint32Array;
}

/**
 * Buildings merged per chunk (by the centroid of the footprint, so each building lands in exactly
 * one): a vertical colour gradient, the storey height per vertex for the window shader, and the
 * first triangle of every building for picking.
 */
export function buildBuildingChunks(city: City) {
  const started = performance.now();
  const centroids = city.buildings.map((b) => ({
    x: b.outline.reduce((a, p) => a + p.x, 0) / b.outline.length,
    z: b.outline.reduce((a, p) => a + p.z, 0) / b.outline.length,
  }));
  const base = new THREE.Color(palette.buildingBase);
  let triangles = 0;
  const chunks: BuildingChunk[] = chunkCells(centroids).map((cell) => {
    const parts: THREE.BufferGeometry[] = [];
    const firstTriangle = new Uint32Array(cell.items.length + 1);
    let own = 0;
    cell.items.forEach((index, i) => {
      const b = city.buildings[index]!;
      firstTriangle[i] = own;
      const extruded = extrudeBuilding(b);
      const g = extruded.index ? extruded.toNonIndexed() : extruded;
      g.deleteAttribute('uv');
      g.computeVertexNormals();
      const pos = g.attributes.position!;
      const colors = new Float32Array(pos.count * 3);
      const floors = new Float32Array(pos.count).fill(b.h / Math.max(1, b.levels));
      const top = new THREE.Color(buildingTint(b));
      for (let k = 0; k < pos.count; k++) {
        tmpColor.copy(base).lerp(top, Math.min(1, (pos.getY(k) - LEVEL.ground) / Math.max(1, b.h)));
        colors.set([tmpColor.r, tmpColor.g, tmpColor.b], k * 3);
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      g.setAttribute('floorH', new THREE.BufferAttribute(floors, 1));
      own += pos.count / 3;
      parts.push(g);
    });
    firstTriangle[cell.items.length] = own;
    triangles += own;
    const geometry = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!geometry) throw new Error('Could not merge buildings');
    geometry.computeBoundingSphere();
    return { key: cell.key, geometry, buildings: cell.items, firstTriangle };
  });
  return { chunks, triangles, ms: Math.round(performance.now() - started) };
}

/** Index within its chunk of the building that owns a triangle of the chunk mesh. */
export function buildingOfTriangle(firstTriangle: Uint32Array, face: number): number {
  let lo = 0;
  let hi = firstTriangle.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (firstTriangle[mid]! <= face) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Window grid on walls: rows by each building's storey height (floorH attribute), columns every
 * 2.7 m along the wall whatever its direction; the ground floor stays plain.
 */
export function withWindows(material: THREE.MeshStandardMaterial) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float floorH;\nvarying vec3 vKoloWorld;\nvarying vec3 vKoloNormal;\nvarying float vKoloFloor;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vKoloWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vKoloNormal = normal;
        vKoloFloor = floorH;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vKoloWorld;\nvarying vec3 vKoloNormal;\nvarying float vKoloFloor;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float koloY = vKoloWorld.y - (${LEVEL.ground.toFixed(2)});
        if (abs(vKoloNormal.y) < 0.5 && koloY > min(vKoloFloor, 3.6) + 0.4) {
          float floorF = fract(koloY / vKoloFloor);
          float rowMask = step(0.34, floorF) * step(floorF, 0.78);
          vec2 along = normalize(vec2(-vKoloNormal.z, vKoloNormal.x));
          float col = fract(dot(vKoloWorld.xz, along) / 2.7);
          float colMask = step(0.22, col) * step(col, 0.78);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.6, 0.67, 0.78), rowMask * colMask * 0.5);
        }`,
      );
  };
  material.customProgramCacheKey = () => 'kolo-windows-v2';
  return material;
}

/**
 * Overhead wires: trolleybus pairs 5.6 m up over the curb lanes of wired streets and the turns
 * between them, and a single tram wire 6.0 m up over every track and its junction curves.
 */
export function buildWireGeometry(city: City): THREE.BufferGeometry {
  const pos: number[] = [];
  const curbOf = (seg: number) => {
    const s = city.segments[seg]!;
    return s.lanes[s.lanes.length - 1]!;
  };
  const wired = new Set(city.segments.filter((s) => s.trolley).map((s) => curbOf(s.id)));
  const string = (line: Lane['line'], sides: readonly number[], height: number) => {
    for (const side of sides) {
      let prev = poseAlong(line, 0, side);
      for (let s = WIRE_STEP; s < line.length + WIRE_STEP; s += WIRE_STEP) {
        const p = poseAlong(line, Math.min(s, line.length), side);
        pos.push(prev.x, height, prev.z, p.x, height, p.z);
        prev = p;
      }
    }
  };
  for (const id of wired) string(city.lanes[id]!.line, TROLLEY_SIDES, WIRE_HEIGHT);
  for (const c of city.connectors) if (wired.has(c.from) && wired.has(c.to)) string(c.line, TROLLEY_SIDES, WIRE_HEIGHT);
  for (const lane of railLanes(city)) string(lane.line, [0], TRAM_WIRE_HEIGHT);
  for (const c of railConnectors(city)) string(c.line, [0], TRAM_WIRE_HEIGHT);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

const WIRE_HEIGHT = 5.6;
const TRAM_WIRE_HEIGHT = 6.0;
/** The two wires of a trolleybus pair, 0.3 m to either side of the lane centre. */
const TROLLEY_SIDES = [-0.3, 0.3] as const;
const WIRE_STEP = 4;

/** Track lanes at street level and above (tunnels run under the blocks). */
const railLanes = (city: City) => city.lanes.filter((l) => city.segments[l.seg]!.rail && city.segments[l.seg]!.layer >= 0);
const railConnectors = (city: City) => city.connectors.filter((c) => isRail(city, c.from) && city.segments[city.lanes[c.from]!.seg]!.layer >= 0);

/** Stretches of a lane not lying on a street lane (outside its twins). */
function ownSpans(lane: Lane): [number, number][] {
  const shared = (lane.twins ?? []).map((t) => [t.s0, t.s1] as const).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [s0, s1] of shared) {
    if (s0 > at) out.push([at, s0]);
    at = Math.max(at, s1);
  }
  if (at < lane.length) out.push([at, lane.length]);
  return out.filter(([a, b]) => b - a > 0.5);
}

/** Lane shares its first / last metre with a street lane. */
const sharedAt = (lane: Lane, s: number) => (lane.twins ?? []).some((t) => t.s0 <= s + 1 && t.s1 >= s - 1);

/** Points of a polyline between a and b, every 2 m. */
function slice(line: Lane['line'], a: number, b: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let s = a; s < b; s += 2) pts.push(poseAlong(line, s));
  pts.push(poseAlong(line, b));
  return pts;
}

/** Half the gauge (1.0 m between the rails) and the width of a rail head. */
const GAUGE_HALF = 0.5;
const RAIL_WIDTH = 0.08;
const BALLAST_HALF = 1.3;
const PLATFORM = { width: 2.2, length: 30, height: 0.3 } as const;

/**
 * A tram stopped at s has its front there: the platform runs back from it, on the side of the
 * track the city chose clear of car lanes (none where the track runs between them).
 */
export const platformOf = (city: City, stop: City['busStops'][number]) => {
  if (!stop.rail || stop.platform === undefined) return null;
  const lane = city.lanes[stop.rail.lane]!;
  return poseAlong(lane.line, Math.max(PLATFORM.length / 2, stop.rail.s - PLATFORM.length / 2), stop.platform);
};

/**
 * Tram tracks: two rails along every track lane and junction curve, a ballast bed where the
 * track runs on its own (not on a street lane) and a platform at stops served only by trams.
 */
export function buildTrackGeometry(city: City) {
  const rails: THREE.BufferGeometry[] = [];
  const ballast: THREE.BufferGeometry[] = [];
  const platforms: THREE.BufferGeometry[] = [];
  const lay = (points: Vec2[]) => {
    for (const g of [
      ribbon(points, -GAUGE_HALF, GAUGE_HALF + RAIL_WIDTH, LEVEL.rail, palette.rail),
      ribbon(points, GAUGE_HALF + RAIL_WIDTH, -GAUGE_HALF, LEVEL.rail, palette.rail),
    ])
      if (g) rails.push(g);
  };
  const bed = (points: Vec2[]) => {
    const g = ribbon(points, BALLAST_HALF, BALLAST_HALF, LEVEL.ballast, palette.ballast);
    if (g) ballast.push(g);
  };
  for (const lane of railLanes(city)) {
    lay(lane.line.points);
    for (const [a, b] of ownSpans(lane)) bed(slice(lane.line, a, b));
  }
  for (const c of railConnectors(city)) {
    lay(c.line.points);
    const from = city.lanes[c.from]!;
    const to = city.lanes[c.to]!;
    if (!sharedAt(from, from.length) && !sharedAt(to, 0)) bed(c.line.points);
  }
  for (const stop of city.busStops) {
    const p = platformOf(city, stop);
    if (p) platforms.push(part(PLATFORM.width, PLATFORM.height, PLATFORM.length, palette.platform, p.x, LEVEL.ground, p.z, p.heading));
  }
  return { rails: merge(rails), ballast: merge(ballast), platforms: merge(platforms) };
}
