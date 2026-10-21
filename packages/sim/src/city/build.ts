import {
  add,
  cross,
  dist,
  dot,
  headingOf,
  lineIntersection,
  polyline,
  polylinesConflict,
  quadBezier,
  rightOf,
  scale,
  sub,
  v,
  type Rect,
  type Vec2,
} from '../geometry.js';
import { createRng, type Rng } from '../rng.js';
import {
  BUS_LINES,
  EW_STREETS,
  NS_STREETS,
  REMOVED_SEGMENTS,
  SIDEWALK,
  SPECIAL_BLOCKS,
  WORLD_HALF,
  type SpecialBlock,
  type StreetSpec,
} from './layout.js';
import type {
  Address,
  Axis,
  Block,
  Building,
  BuildingKind,
  BusLine,
  BusStop,
  City,
  CityNode,
  Connector,
  CurbRef,
  Depot,
  Lane,
  Poi,
  Segment,
  Slot,
  Street,
  Tree,
  Turn,
} from './types.js';

export const DEFAULT_CITY_SEED = 1389;
/** Distance from the junction box edge to the stop line (holds the zebra crossing). */
export const STOP_SETBACK = 4;

const KMH = 1 / 3.6;

function makeStreet(id: number, spec: StreetSpec, axis: Axis): Street {
  const boulevard = spec.cls === 'boulevard';
  const lanesPerDir = boulevard ? 2 : 1;
  // Slightly generous widths keep streets readable in the isometric view.
  const laneWidth = boulevard ? 3.6 : 4;
  const median = boulevard ? 1.4 : 0;
  return {
    id,
    name: spec.name,
    axis,
    coord: spec.coord,
    cls: boulevard ? 'boulevard' : 'local',
    lanesPerDir,
    laneWidth,
    median,
    halfWidth: median + lanesPerDir * laneWidth,
    speed: (boulevard ? 50 : 40) * KMH,
  };
}

interface Builder {
  rng: Rng;
  city: City;
  /** Grid lookup: nodeAt[col][row]. */
  nodeAt: number[][];
  nsStreets: Street[];
  ewStreets: Street[];
}

export function buildCity(seed = DEFAULT_CITY_SEED): City {
  const rng = createRng(seed);
  const nsStreets = NS_STREETS.map((s, i) => makeStreet(i, s, 'NS'));
  const ewStreets = EW_STREETS.map((s, i) => makeStreet(nsStreets.length + i, s, 'EW'));
  const city: City = {
    seed,
    bounds: { x0: -WORLD_HALF, z0: -WORLD_HALF, x1: WORLD_HALF, z1: WORLD_HALF },
    sidewalk: SIDEWALK,
    streets: [...nsStreets, ...ewStreets],
    nodes: [],
    segments: [],
    lanes: [],
    connectors: [],
    blocks: [],
    buildings: [],
    trees: [],
    addresses: [],
    depots: [],
    busStops: [],
    busLines: [],
    pois: [],
    segmentByKey: new Map(),
    addressById: new Map(),
  };
  const b: Builder = { rng, city, nodeAt: [], nsStreets, ewStreets };

  buildNodes(b);
  buildSegments(b);
  buildLanes(b);
  buildConnectors(b);
  configureJunctions(b);
  buildBlocks(b);
  buildBusLines(b);
  buildStreetTrees(b);
  numberAddresses(b);
  for (const a of city.addresses) city.addressById.set(a.id, a);
  return city;
}

// ───────────────────────────── road network ─────────────────────────────

function buildNodes(b: Builder) {
  const { city, nsStreets, ewStreets } = b;
  nsStreets.forEach((ns, col) => {
    b.nodeAt[col] = [];
    ewStreets.forEach((ew, row) => {
      const node: CityNode = {
        id: city.nodes.length,
        col,
        row,
        x: ns.coord,
        z: ew.coord,
        vStreet: ns.id,
        hStreet: ew.id,
        halfX: ns.halfWidth,
        halfZ: ew.halfWidth,
        in: [],
        out: [],
        signal: null,
        priority: null,
        name: `${ns.name} × ${ew.name}`,
      };
      city.nodes.push(node);
      b.nodeAt[col]![row] = node.id;
    });
  });
}

const isRemoved = (axis: Axis, col: number, row: number) =>
  REMOVED_SEGMENTS.some((r) => r.axis === axis && r.col === col && r.row === row);

function buildSegments(b: Builder) {
  const { city, nsStreets, ewStreets } = b;
  const addPair = (a: number, c: number, street: Street) => {
    const na = city.nodes[a]!;
    const nc = city.nodes[c]!;
    const mk = (from: CityNode, to: CityNode): Segment => {
      const d = { x: Math.sign(to.x - from.x), z: Math.sign(to.z - from.z) };
      const seg: Segment = {
        id: city.segments.length,
        from: from.id,
        to: to.id,
        street: street.id,
        axis: street.axis,
        dir: d,
        lanes: [],
        length: dist(from, to),
        speed: street.speed,
        reverse: -1,
      };
      city.segments.push(seg);
      city.segmentByKey.set(`${from.id}>${to.id}`, seg.id);
      from.out.push(seg.id);
      to.in.push(seg.id);
      return seg;
    };
    const s1 = mk(na, nc);
    const s2 = mk(nc, na);
    s1.reverse = s2.id;
    s2.reverse = s1.id;
  };
  nsStreets.forEach((street, col) => {
    for (let row = 0; row < ewStreets.length - 1; row++) {
      if (!isRemoved('NS', col, row)) addPair(b.nodeAt[col]![row]!, b.nodeAt[col]![row + 1]!, street);
    }
  });
  ewStreets.forEach((street, row) => {
    for (let col = 0; col < nsStreets.length - 1; col++) {
      if (!isRemoved('EW', col, row)) addPair(b.nodeAt[col]![row]!, b.nodeAt[col + 1]![row]!, street);
    }
  });
}

/** Half extent of a junction box along a travel direction. */
const boxHalfAlong = (node: CityNode, d: Vec2) => (Math.abs(d.x) > 0 ? node.halfX : node.halfZ);

function buildLanes(b: Builder) {
  const { city } = b;
  for (const seg of city.segments) {
    const street = city.streets[seg.street]!;
    const from = city.nodes[seg.from]!;
    const to = city.nodes[seg.to]!;
    const right = rightOf(seg.dir);
    for (let i = 0; i < street.lanesPerDir; i++) {
      const offset = street.median + (i + 0.5) * street.laneWidth;
      const start = add(add(from, scale(seg.dir, boxHalfAlong(from, seg.dir) + STOP_SETBACK)), scale(right, offset));
      const end = add(add(to, scale(seg.dir, -(boxHalfAlong(to, seg.dir) + STOP_SETBACK))), scale(right, offset));
      const lane: Lane = {
        id: city.lanes.length,
        seg: seg.id,
        index: i,
        lanesInSeg: street.lanesPerDir,
        start: v(start.x, start.z),
        end: v(end.x, end.z),
        dir: seg.dir,
        right,
        length: dist(start, end),
        offset,
        out: [],
        in: [],
      };
      city.lanes.push(lane);
      seg.lanes.push(lane.id);
    }
  }
}

function turnOf(dIn: Vec2, dOut: Vec2): Turn | null {
  const c = cross(dIn, dOut);
  if (c > 0.5) return 'R';
  if (c < -0.5) return 'L';
  return dot(dIn, dOut) > 0 ? 'S' : null;
}

function buildConnectors(b: Builder) {
  const { city } = b;
  for (const node of city.nodes) {
    const created: Connector[] = [];
    for (const inSegId of node.in) {
      const inSeg = city.segments[inSegId]!;
      for (const outSegId of node.out) {
        const outSeg = city.segments[outSegId]!;
        if (outSeg.id === inSeg.reverse) continue;
        const turn = turnOf(inSeg.dir, outSeg.dir);
        if (!turn) continue;
        for (const inLaneId of inSeg.lanes) {
          const inLane = city.lanes[inLaneId]!;
          if (turn === 'L' && inLane.index !== 0) continue;
          if (turn === 'R' && inLane.index !== inLane.lanesInSeg - 1) continue;
          for (const outLaneId of outSeg.lanes) {
            const outLane = city.lanes[outLaneId]!;
            if (turn === 'S' && Math.abs(inLane.index - outLane.index) > 1) continue;
            let points: Vec2[];
            let vmax = Math.min(inSeg.speed, outSeg.speed);
            if (turn === 'S') {
              points = [inLane.end, outLane.start];
            } else {
              const c = lineIntersection(inLane.end, inLane.dir, outLane.start, outLane.dir) ?? node;
              points = quadBezier(inLane.end, c, outLane.start, 10);
              const radius = Math.min(dist(c, inLane.end), dist(c, outLane.start));
              vmax = Math.max(3.5, Math.min(vmax, Math.sqrt(2.4 * radius)));
            }
            const conn: Connector = {
              id: city.connectors.length,
              node: node.id,
              from: inLane.id,
              to: outLane.id,
              turn,
              approach: inSeg.axis,
              line: polyline(points),
              vmax,
              conflicts: [],
            };
            city.connectors.push(conn);
            created.push(conn);
            inLane.out.push(conn.id);
            outLane.in.push(conn.id);
          }
        }
      }
    }
    for (let i = 0; i < created.length; i++) {
      for (let j = i + 1; j < created.length; j++) {
        const a = created[i]!;
        const c = created[j]!;
        if (a.from === c.from) continue;
        if (polylinesConflict(a.line, c.line, 1.8)) {
          a.conflicts.push(c.id);
          c.conflicts.push(a.id);
        }
      }
    }
  }
}

function configureJunctions(b: Builder) {
  const { city, rng } = b;
  for (const node of city.nodes) {
    const degree = node.out.length;
    const vs = city.streets[node.vStreet]!;
    const hs = city.streets[node.hStreet]!;
    if (degree >= 4) {
      const greenNs = vs.cls === 'boulevard' ? 30 : hs.cls === 'boulevard' ? 16 : 20;
      const greenEw = hs.cls === 'boulevard' ? 30 : vs.cls === 'boulevard' ? 16 : 20;
      const cycle = greenNs + greenEw + 12;
      // Green wave eastbound along the EW boulevard, random elsewhere.
      const offset = hs.cls === 'boulevard' ? ((node.x + WORLD_HALF) / 12.5) % cycle : rng.range(0, cycle);
      node.signal = { greenNs, greenEw, offset };
    } else if (degree === 3) {
      const nsThrough = node.out.some((s) => city.segments[s]!.dir.z < 0) && node.out.some((s) => city.segments[s]!.dir.z > 0);
      node.priority = nsThrough ? 'NS' : 'EW';
    }
  }
}

// ───────────────────────────── blocks & buildings ─────────────────────────────

/** Grid boundaries: world edge, every street, world edge. */
function boundaries(streets: Street[]) {
  return [-WORLD_HALF, ...streets.map((s) => s.coord), WORLD_HALF];
}

interface CellRange {
  c0: number;
  c1: number;
  r0: number;
  r1: number;
}

function cellRanges(): (CellRange & { special: SpecialBlock | null })[] {
  const taken = new Set<string>();
  const out: (CellRange & { special: SpecialBlock | null })[] = [];
  const cells = NS_STREETS.length + 1;
  const rows = EW_STREETS.length + 1;
  for (let c = 0; c < cells; c++) {
    for (let r = 0; r < rows; r++) {
      if (taken.has(`${c},${r}`)) continue;
      let c1 = c;
      let r1 = r;
      // A removed NS segment at street col (c) between rows (r-1, r) merges cell c with c+1.
      if (REMOVED_SEGMENTS.some((x) => x.axis === 'NS' && x.col === c && x.row === r - 1)) c1 = c + 1;
      if (REMOVED_SEGMENTS.some((x) => x.axis === 'EW' && x.row === r && x.col === c - 1)) r1 = r + 1;
      for (let cc = c; cc <= c1; cc++) for (let rr = r; rr <= r1; rr++) taken.add(`${cc},${rr}`);
      out.push({ c0: c, c1, r0: r, r1, special: SPECIAL_BLOCKS[`${c},${r}`] ?? null });
    }
  }
  return out;
}

type Side = 'N' | 'S' | 'W' | 'E';

interface BlockCtx {
  block: Block;
  range: CellRange;
  /** Which sides face a street (and the street id). */
  sides: Partial<Record<Side, Street>>;
}

function buildBlocks(b: Builder) {
  const { city, nsStreets, ewStreets } = b;
  const xb = boundaries(nsStreets);
  const zb = boundaries(ewStreets);
  for (const range of cellRanges()) {
    const west = range.c0 >= 1 ? nsStreets[range.c0 - 1] : undefined;
    const east = range.c1 + 1 <= nsStreets.length ? nsStreets[range.c1] : undefined;
    const north = range.r0 >= 1 ? ewStreets[range.r0 - 1] : undefined;
    const south = range.r1 + 1 <= ewStreets.length ? ewStreets[range.r1] : undefined;
    const inner: Rect = {
      x0: xb[range.c0]! + (west ? west.halfWidth + SIDEWALK : 0),
      x1: xb[range.c1 + 1]! - (east ? east.halfWidth + SIDEWALK : 0),
      z0: zb[range.r0]! + (north ? north.halfWidth + SIDEWALK : 0),
      z1: zb[range.r1 + 1]! - (south ? south.halfWidth + SIDEWALK : 0),
    };
    const edge = !west || !east || !north || !south;
    const special = range.special;
    const block: Block = {
      id: city.blocks.length,
      kind: special ? (special.kind === 'market' ? 'market' : special.kind) : edge ? 'edge' : 'urban',
      inner,
      name: special?.name ?? null,
    };
    city.blocks.push(block);
    const sides: BlockCtx['sides'] = {};
    if (north) sides.N = north;
    if (south) sides.S = south;
    if (west) sides.W = west;
    if (east) sides.E = east;
    const ctx: BlockCtx = { block, range, sides };
    if (!special) fillPerimeter(b, ctx);
    else if (special.kind === 'park') fillPark(b, ctx);
    else if (special.kind === 'depot') fillDepot(b, ctx, special);
    else if (special.kind === 'poi') fillPoi(b, ctx, special);
    else fillMarket(b, ctx, special);
  }
}

/** The directed segment whose curb lane runs along a block side, and the position on it. */
function curbFor(b: Builder, side: Side, street: Street, along: number): CurbRef & { seg: number } {
  const { city } = b;
  // Right-hand traffic: the curb lane next to a block is on the right of the travel direction.
  const want: Vec2 = side === 'N' ? v(1, 0) : side === 'S' ? v(-1, 0) : side === 'W' ? v(0, -1) : v(0, 1);
  let best: { seg: Segment; lane: Lane; s: number; err: number } | null = null;
  for (const seg of city.segments) {
    if (seg.street !== street.id || seg.dir.x !== want.x || seg.dir.z !== want.z) continue;
    const lane = city.lanes[seg.lanes[seg.lanes.length - 1]!]!;
    const p = street.axis === 'EW' ? v(along, lane.start.z) : v(lane.start.x, along);
    const s = dot(sub(p, lane.start), lane.dir);
    const clamped = Math.max(8, Math.min(lane.length - 8, s));
    const err = Math.abs(clamped - s);
    if (!best || err < best.err) best = { seg, lane, s: clamped, err };
  }
  if (!best) throw new Error(`No curb lane for side ${side} of ${street.name}`);
  return { seg: best.seg.id, lane: best.lane.id, s: best.s };
}

function addAddress(b: Builder, side: Side, street: Street, entrance: Vec2, buildingId: string | null, poi: string | null) {
  const along = street.axis === 'EW' ? entrance.x : entrance.z;
  const curb = curbFor(b, side, street, along);
  const addr: Address = {
    id: `A${b.city.addresses.length + 1}`,
    label: street.name,
    street: street.id,
    number: 0,
    x: entrance.x,
    z: entrance.z,
    lane: curb.lane,
    s: curb.s,
    buildingId,
    poi,
  };
  b.city.addresses.push(addr);
  return addr;
}

function heightFor(b: Builder, x: number, z: number) {
  // Taller around the boulevard crossing, lower towards the edges.
  const d = Math.hypot(x + 10, z + 15);
  const t = Math.max(0, 1 - d / 650);
  // Vračar perimeter blocks are 4–7 storeys; kept low so streets stay readable from above.
  return 8 + t * 10 + b.rng.range(0, 5 + t * 6);
}

function addBuilding(
  b: Builder,
  ctx: BlockCtx,
  rect: Rect,
  kind: BuildingKind,
  h: number,
  opts: { side?: Side; name?: string; poi?: string } = {},
): Building {
  const id = `B${b.city.buildings.length + 1}`;
  const building: Building = {
    id,
    x: (rect.x0 + rect.x1) / 2,
    z: (rect.z0 + rect.z1) / 2,
    w: rect.x1 - rect.x0,
    d: rect.z1 - rect.z0,
    h,
    kind,
    tint: b.rng.int(0, 3),
    addressId: null,
    name: opts.name ?? null,
    blockId: ctx.block.id,
  };
  b.city.buildings.push(building);
  const side = opts.side;
  const street = side ? ctx.sides[side] : undefined;
  if (side && street) {
    const entrance =
      side === 'N'
        ? v(building.x, rect.z0 - SIDEWALK / 2)
        : side === 'S'
          ? v(building.x, rect.z1 + SIDEWALK / 2)
          : side === 'W'
            ? v(rect.x0 - SIDEWALK / 2, building.z)
            : v(rect.x1 + SIDEWALK / 2, building.z);
    building.addressId = addAddress(b, side, street, entrance, id, opts.poi ?? null).id;
  }
  return building;
}

/** Splits [a0, a1] into building frontages with occasional passages. */
function frontages(b: Builder, a0: number, a1: number): [number, number][] {
  const out: [number, number][] = [];
  let cursor = a0;
  while (a1 - cursor > 10) {
    let w = b.rng.range(14, 30);
    if (a1 - (cursor + w) < 14) w = a1 - cursor;
    out.push([cursor, cursor + w]);
    cursor += w;
    if (b.rng.chance(0.18)) cursor += b.rng.range(3, 6);
  }
  return out;
}

function fillPerimeter(b: Builder, ctx: BlockCtx) {
  const { inner } = ctx.block;
  const { rng } = b;
  const depthN = ctx.sides.N ? rng.range(12, 17) : 0;
  const depthS = ctx.sides.S ? rng.range(12, 17) : 0;
  const kindAt = () => (rng.chance(0.22) ? 'office' : 'residential');
  if (ctx.sides.N) {
    for (const [x0, x1] of frontages(b, inner.x0, inner.x1)) {
      addBuilding(b, ctx, { x0, x1, z0: inner.z0, z1: inner.z0 + depthN }, kindAt(), heightFor(b, x0, inner.z0), { side: 'N' });
    }
  }
  if (ctx.sides.S) {
    for (const [x0, x1] of frontages(b, inner.x0, inner.x1)) {
      addBuilding(b, ctx, { x0, x1, z0: inner.z1 - depthS, z1: inner.z1 }, kindAt(), heightFor(b, x0, inner.z1), { side: 'S' });
    }
  }
  const z0 = inner.z0 + depthN + (depthN ? 1 : 0);
  const z1 = inner.z1 - depthS - (depthS ? 1 : 0);
  for (const side of ['W', 'E'] as const) {
    if (!ctx.sides[side]) continue;
    const depth = rng.range(12, 16);
    for (const [a0, a1] of frontages(b, z0, z1)) {
      const rect = side === 'W' ? { x0: inner.x0, x1: inner.x0 + depth, z0: a0, z1: a1 } : { x0: inner.x1 - depth, x1: inner.x1, z0: a0, z1: a1 };
      addBuilding(b, ctx, rect, kindAt(), heightFor(b, rect.x0, a0), { side });
    }
  }
  // Courtyard trees.
  const cx0 = inner.x0 + 22;
  const cx1 = inner.x1 - 22;
  const cz0 = inner.z0 + 22;
  const cz1 = inner.z1 - 22;
  if (cx1 > cx0 && cz1 > cz0) {
    const n = rng.int(2, 6);
    for (let i = 0; i < n; i++) {
      b.city.trees.push({ x: rng.range(cx0, cx1), z: rng.range(cz0, cz1), r: rng.range(2.6, 4.2), h: rng.range(6, 10) });
    }
  }
}

function fillPark(b: Builder, ctx: BlockCtx) {
  const { inner } = ctx.block;
  const { rng } = b;
  const cx = (inner.x0 + inner.x1) / 2;
  const cz = (inner.z0 + inner.z1) / 2;
  for (let x = inner.x0 + 6; x < inner.x1 - 4; x += 11) {
    for (let z = inner.z0 + 6; z < inner.z1 - 4; z += 11) {
      const px = x + rng.range(-3, 3);
      const pz = z + rng.range(-3, 3);
      // Keep the central plaza and the two crossing paths clear.
      if (Math.hypot(px - cx, pz - cz) < 20 || Math.abs(px - cx) < 4 || Math.abs(pz - cz) < 4) continue;
      if (rng.chance(0.25)) continue;
      b.city.trees.push({ x: px, z: pz, r: rng.range(3, 5), h: rng.range(7, 12) });
    }
  }
  const side: Side = ctx.sides.S ? 'S' : 'N';
  const street = ctx.sides[side]!;
  const entrance = side === 'S' ? v(cx, inner.z1 + SIDEWALK / 2) : v(cx, inner.z0 - SIDEWALK / 2);
  const addr = addAddress(b, side, street, entrance, null, 'park');
  b.city.pois.push({ id: 'park', name: ctx.block.name ?? 'Park', kind: 'park', addressId: addr.id, weight: 1 });
}

function fillPoi(b: Builder, ctx: BlockCtx, spec: Extract<SpecialBlock, { kind: 'poi' }>) {
  const { inner } = ctx.block;
  const inset = spec.poi === 'hotel' ? 26 : 18;
  const rect = { x0: inner.x0 + inset, x1: inner.x1 - inset, z0: inner.z0 + inset, z1: inner.z1 - inset };
  const h = spec.poi === 'hotel' ? 30 : spec.poi === 'mall' ? 15 : spec.poi === 'hospital' ? 19 : 12;
  const side: Side = ctx.sides.N ? 'N' : 'S';
  const building = addBuilding(b, ctx, rect, 'poi', h, { name: spec.name, poi: spec.poiId });
  const street = ctx.sides[side]!;
  const entrance = side === 'N' ? v(building.x, inner.z0 - SIDEWALK / 2) : v(building.x, inner.z1 + SIDEWALK / 2);
  const addr = addAddress(b, side, street, entrance, building.id, spec.poiId);
  building.addressId = addr.id;
  b.city.pois.push({ id: spec.poiId, name: spec.name, kind: spec.poi, addressId: addr.id, weight: spec.weight });
  // Plaza trees around the landmark.
  for (let x = inner.x0 + 3; x < inner.x1; x += 14) {
    b.city.trees.push({ x, z: inner.z0 + 3, r: 2.4, h: 6 });
    b.city.trees.push({ x, z: inner.z1 - 3, r: 2.4, h: 6 });
  }
}

function fillMarket(b: Builder, ctx: BlockCtx, spec: Extract<SpecialBlock, { kind: 'market' }>) {
  const { inner } = ctx.block;
  const { rng } = b;
  // Market hall along the north side, open-air stalls behind it.
  const hall = addBuilding(b, ctx, { x0: inner.x0 + 10, x1: inner.x1 - 10, z0: inner.z0, z1: inner.z0 + 16 }, 'poi', 9, {
    name: spec.name,
    poi: spec.poiId,
    side: 'N',
  });
  b.city.pois.push({ id: spec.poiId, name: spec.name, kind: 'market', addressId: hall.addressId!, weight: spec.weight });
  for (let x = inner.x0 + 8; x < inner.x1 - 8; x += 9) {
    for (let z = inner.z0 + 26; z < inner.z1 - 8; z += 10) {
      if (rng.chance(0.2)) continue;
      addBuilding(b, ctx, { x0: x, x1: x + 6, z0: z, z1: z + 4 }, 'stall', 3);
    }
  }
}

function fillDepot(b: Builder, ctx: BlockCtx, spec: Extract<SpecialBlock, { kind: 'depot' }>) {
  const { inner } = ctx.block;
  const { city } = b;
  // The gate faces the longer street frontage; the yard is a compact band around it.
  const tall = inner.z1 - inner.z0 > inner.x1 - inner.x0;
  const gateSide: Side = tall ? (ctx.sides.E ? 'E' : 'W') : ctx.sides.S ? 'S' : 'N';
  const street = ctx.sides[gateSide]!;
  const cx = (inner.x0 + inner.x1) / 2;
  const cz = (inner.z0 + inner.z1) / 2;
  const inward = gateSide === 'E' ? v(-1, 0) : gateSide === 'W' ? v(1, 0) : gateSide === 'S' ? v(0, -1) : v(0, 1);
  const along = tall ? v(0, 1) : v(1, 0);
  const gate = gateSide === 'E' ? v(inner.x1, cz) : gateSide === 'W' ? v(inner.x0, cz) : gateSide === 'S' ? v(cx, inner.z1) : v(cx, inner.z0);
  const depth = tall ? inner.x1 - inner.x0 : inner.z1 - inner.z0;
  const span = tall ? inner.z1 - inner.z0 : inner.x1 - inner.x0;
  const halfSpan = Math.min(span / 2, 46);
  /** Local frame: u along the gate street, w from the gate into the yard. */
  const P = (u: number, w: number) => add(add(gate, scale(along, u)), scale(inward, w));
  const rectOf = (a: Vec2, c: Vec2): Rect => ({ x0: Math.min(a.x, c.x), x1: Math.max(a.x, c.x), z0: Math.min(a.z, c.z), z1: Math.max(a.z, c.z) });

  const lot = rectOf(P(-halfSpan, 0), P(halfSpan, depth));
  const gw = spec.boxes * 9;
  const garage = rectOf(P(-gw / 2, depth - 16), P(gw / 2, depth));
  addBuilding(b, ctx, garage, 'garage', 7, { name: `${spec.name} servis` });
  const office = addBuilding(b, ctx, rectOf(P(halfSpan - 15, 0.5), P(halfSpan - 2, 12)), 'depot-office', 6, { name: spec.name });
  const yard = P(0, 8);

  // Service boxes: cars drive in nose-first, away from the gate.
  const boxes: Slot[] = [];
  for (let i = 0; i < spec.boxes; i++) {
    const p = P(-gw / 2 + 4.5 + i * 9, depth - 8);
    boxes.push({ x: p.x, z: p.z, heading: headingOf(inward) });
  }

  // Pairs of slot rows facing a shared aisle, filled until capacity.
  const slots: Slot[] = [];
  for (let w = 20; w + 14 < depth - 22 && slots.length < spec.capacity; w += 30) {
    for (const [rowW, facing] of [
      [w, inward],
      [w + 14, scale(inward, -1)],
    ] as const) {
      for (let u = -halfSpan + 6; u <= halfSpan - 6 && slots.length < spec.capacity; u += 3.4) {
        const p = P(u, rowW);
        slots.push({ x: p.x, z: p.z, heading: headingOf(facing) });
      }
    }
  }

  const entrance = add(gate, scale(inward, -SIDEWALK / 2));
  const addr = addAddress(b, gateSide, street, entrance, office.id, null);
  office.addressId = addr.id;
  const curb = curbFor(b, gateSide, street, street.axis === 'EW' ? gate.x : gate.z);
  city.depots.push({
    id: spec.depotId,
    name: spec.name,
    blockId: ctx.block.id,
    lot,
    garage,
    gate,
    yard,
    curb: { lane: curb.lane, s: curb.s },
    addressId: addr.id,
    slots,
    boxes,
  });

  // The rest of the block is ordinary housing on both sides of the yard.
  const parts: { inner: Rect; sides: BlockCtx['sides'] }[] = tall
    ? [
        { inner: { ...inner, z1: lot.z0 - 3 }, sides: { N: ctx.sides.N, W: ctx.sides.W, E: ctx.sides.E } },
        { inner: { ...inner, z0: lot.z1 + 3 }, sides: { S: ctx.sides.S, W: ctx.sides.W, E: ctx.sides.E } },
      ]
    : [
        { inner: { ...inner, x1: lot.x0 - 3 }, sides: { W: ctx.sides.W, N: ctx.sides.N, S: ctx.sides.S } },
        { inner: { ...inner, x0: lot.x1 + 3 }, sides: { E: ctx.sides.E, N: ctx.sides.N, S: ctx.sides.S } },
      ];
  for (const part of parts) {
    const w = part.inner.x1 - part.inner.x0;
    const d = part.inner.z1 - part.inner.z0;
    if (w < 30 || d < 30) continue;
    const sides = Object.fromEntries(Object.entries(part.sides).filter(([, s]) => s)) as BlockCtx['sides'];
    fillPerimeter(b, { block: { ...ctx.block, inner: part.inner }, range: ctx.range, sides });
  }
}

// ───────────────────────────── transit & greenery ─────────────────────────────

function buildBusLines(b: Builder) {
  const { city } = b;
  for (const spec of BUS_LINES) {
    const segments: number[] = [];
    for (let i = 1; i < spec.waypoints.length; i++) {
      let [c, r] = spec.waypoints[i - 1]!;
      const [tc, tr] = spec.waypoints[i]!;
      while (c !== tc || r !== tr) {
        const nc = c + Math.sign(tc - c);
        const nr = r + Math.sign(tr - r);
        const from = b.nodeAt[c]![r]!;
        const to = b.nodeAt[nc]![nr]!;
        const seg = city.segmentByKey.get(`${from}>${to}`);
        if (seg === undefined) throw new Error(`Bus line ${spec.id} uses a missing segment`);
        segments.push(seg);
        c = nc;
        r = nr;
      }
    }
    const line: BusLine = { id: spec.id, name: spec.name, segments, stops: [] };
    segments.forEach((segId, i) => {
      if (i % 2 !== 0) return;
      const seg = city.segments[segId]!;
      // A bus about to turn left from a multi-lane road is in the inner lane, not at the curb.
      const nextSeg = city.segments[segments[(i + 1) % segments.length]!]!;
      if (seg.lanes.length > 1 && turnOf(seg.dir, nextSeg.dir) === 'L') return;
      const laneId = seg.lanes[seg.lanes.length - 1]!;
      let stop = city.busStops.find((s) => s.lane === laneId);
      if (!stop) {
        const lane = city.lanes[laneId]!;
        const s = lane.length * 0.55;
        const street = city.streets[seg.street]!;
        const p = add(add(lane.start, scale(lane.dir, s)), scale(lane.right, street.halfWidth - lane.offset + SIDEWALK * 0.65));
        const cross = city.streets[seg.axis === 'NS' ? city.nodes[seg.to]!.hStreet : city.nodes[seg.to]!.vStreet]!;
        stop = {
          id: `S${city.busStops.length + 1}`,
          name: `${street.name} / ${cross.name}`,
          lane: laneId,
          s,
          x: p.x,
          z: p.z,
          heading: headingOf(lane.dir),
          lines: [],
        };
        city.busStops.push(stop);
      }
      stop.lines.push(line.id);
      line.stops.push(stop.id);
    });
    city.busLines.push(line);
  }
}

function buildStreetTrees(b: Builder) {
  const { city, rng } = b;
  for (const street of city.streets) {
    if (street.cls !== 'boulevard') continue;
    for (const seg of city.segments) {
      if (seg.street !== street.id || seg.reverse < seg.id) continue;
      const from = city.nodes[seg.from]!;
      const to = city.nodes[seg.to]!;
      const len = dist(from, to);
      const right = rightOf(seg.dir);
      for (let s = 24; s < len - 24; s += 16) {
        for (const sideSign of [1, -1]) {
          const p = add(add(from, scale(seg.dir, s)), scale(right, sideSign * (street.halfWidth + SIDEWALK * 0.5)));
          if (city.busStops.some((st) => dist(st, p) < 14)) continue;
          city.trees.push({ x: p.x, z: p.z, r: rng.range(2.2, 3), h: rng.range(6.5, 8.5) });
        }
      }
    }
  }
}

function numberAddresses(b: Builder) {
  const { city } = b;
  for (const street of city.streets) {
    const list = city.addresses.filter((a) => a.street === street.id);
    const along = (a: Address) => (street.axis === 'EW' ? a.x : a.z);
    const side = (a: Address) => (street.axis === 'EW' ? a.z > street.coord : a.x > street.coord);
    for (const parity of [false, true]) {
      list
        .filter((a) => side(a) === parity)
        .sort((p, q) => along(p) - along(q))
        .forEach((a, i) => {
          a.number = parity ? 2 + i * 2 : 1 + i * 2;
          a.label = `${street.name} ${a.number}`;
        });
    }
  }
  for (const poi of city.pois) {
    const addr = city.addresses.find((a) => a.id === poi.addressId);
    if (addr) addr.label = `${poi.name}, ${addr.label}`;
  }
}

/** Convenience used by the engine and renderer. */
export function lanePoint(city: City, laneId: number, s: number, lateral = 0): Vec2 {
  const lane = city.lanes[laneId]!;
  return add(add(lane.start, scale(lane.dir, s)), scale(lane.right, lateral));
}
