import {
  add,
  cross,
  dist,
  dot,
  endTangent,
  lineIntersection,
  norm,
  polyline,
  polylinesConflict,
  quadBezier,
  scale,
  startTangent,
  sub,
  type Polyline,
  type Vec2,
} from '../geometry.js';
import { turnBetween } from '../engine/routing.js';
import { cycleOf } from '../engine/signals.js';
import { largestStronglyConnected } from '../graph.js';
import type { District, RoadClass, RoadEdge } from './district.js';
import { layoutDepots } from './depots.js';
import { addPlaces, parkCars } from './places.js';
import type { City, CityNode, Connector, Lane, RoadStrip, Segment, Street, Turn } from './types.js';

/** Junction nodes joined by roads shorter than this become one junction (dual carriageways). */
const CLUSTER_EDGE = 18;
/** Any two nodes this close are merged, whatever they are. */
const TINY_EDGE = 3;
const CLUSTER_RADIUS = 30;
/** Ring pieces shorter than this merge their ends (a car could not stop on them). */
const RING_TINY = 8;
/** Length over which a segment's entry / exit direction is measured. */
const TANGENT_SPAN = 15;
const CONFLICT_CLEARANCE = 1.6;
/** OSM puts signal nodes on the approach, up to this far outside the junction circle. */
const SIGNAL_REACH = 25;
/** |cos| above which two approaches share a phase (opposite or parallel within 30°). */
const PHASE_ALIGN = Math.cos((30 * Math.PI) / 180);
const GREEN_MAIN = 45;
const GREEN_SIDE = 30;

const RANK: Record<RoadClass, number> = {
  trunk: 6,
  primary: 5,
  secondary: 4,
  tertiary: 3,
  busway: 3,
  unclassified: 2,
  residential: 2,
  living_street: 1,
};
const RING_BONUS = 10;
export const laneWidthOf = (cls: RoadClass) => (cls === 'residential' || cls === 'living_street' ? 3.0 : 3.2);

/** A road between two graph nodes while the graph is being simplified. */
interface WorkEdge {
  id: number;
  a: number;
  b: number;
  pts: Vec2[];
  src: RoadEdge;
  lanesFwd: number;
  lanesBwd: number;
  turnFwd?: string;
  turnBwd?: string;
  /** Original edge ids folded into this one. */
  merged: number[];
}

/** Builds a City from a district file: the road graph, then buildings, places and partner depots. */
export function buildCityFromDistrict(district: District): City {
  const { roads } = district;
  const nodePos = new Map(roads.nodes.map((n) => [n.id, { x: n.x, z: n.z }]));
  const boundary = new Set(roads.nodes.filter((n) => n.boundary).map((n) => n.id));
  const signalled = new Set(roads.nodes.filter((n) => n.signals).map((n) => n.id));

  const edges = new Map<number, WorkEdge>();
  for (const e of roads.edges) {
    const pts: Vec2[] = [];
    for (let i = 0; i < e.pts.length; i += 2) pts.push({ x: e.pts[i]!, z: e.pts[i + 1]! });
    edges.set(e.id, { id: e.id, a: e.a, b: e.b, pts, src: e, lanesFwd: e.lanesFwd, lanesBwd: e.lanesBwd, turnFwd: e.turnFwd, turnBwd: e.turnBwd, merged: [e.id] });
  }
  const signalPoints = foldPassThrough(edges, boundary, signalled, nodePos);

  // ── junction clusters ──
  const incident = incidence(edges);
  const ringNode = new Set<number>();
  for (const e of edges.values()) if (e.src.roundabout) ringNode.add(e.a).add(e.b);
  const isJunction = (n: number) => (incident.get(n)?.size ?? 0) >= 3 || signalled.has(n) || ringNode.has(n);
  const cluster = new Map<number, number[]>();
  const clusterOf = new Map<number, number>();
  for (const n of nodePos.keys()) {
    cluster.set(n, [n]);
    clusterOf.set(n, n);
  }
  const candidates = [...edges.values()]
    .map((e) => ({ e, len: polyline(e.pts).length }))
    .filter(({ e, len }) => {
      if (boundary.has(e.a) || boundary.has(e.b) || len >= CLUSTER_EDGE) return false;
      // A ring keeps its shape unless a piece of it is too short to hold a car (mini-roundabouts).
      if (e.src.roundabout) return len < RING_TINY;
      return len < TINY_EDGE || (isJunction(e.a) && isJunction(e.b));
    })
    .sort((p, q) => p.len - q.len);
  for (const { e } of candidates) {
    const ca = clusterOf.get(e.a)!;
    const cb = clusterOf.get(e.b)!;
    if (ca === cb) continue;
    const members = [...cluster.get(ca)!, ...cluster.get(cb)!];
    if (!e.src.roundabout && members.filter((m) => ringNode.has(m)).length > 1) continue;
    const c = centroid(members.map((m) => nodePos.get(m)!));
    if (members.some((m) => dist(nodePos.get(m)!, c) > CLUSTER_RADIUS)) continue;
    cluster.set(ca, members);
    cluster.delete(cb);
    for (const m of members) clusterOf.set(m, ca);
  }
  // Roads inside one junction disappear; the junction's connectors replace them.
  for (const e of [...edges.values()]) if (clusterOf.get(e.a) === clusterOf.get(e.b)) edges.delete(e.id);

  // ── city skeleton ──
  const city: City = {
    districtId: district.meta.id,
    version: district.meta.version,
    bounds: { ...district.meta.bounds },
    streets: [],
    nodes: [],
    segments: [],
    lanes: [],
    connectors: [],
    roads: [],
    areas: [],
    buildings: [],
    trees: [],
    playgrounds: [],
    parkedCars: [],
    addresses: [],
    depots: [],
    busStops: [],
    busLines: [],
    pois: [],
    segmentByKey: new Map(),
    addressById: new Map(),
  };
  const nodeOfCluster = new Map<number, CityNode>();
  const radius = new Map<number, number>();
  for (const [key, members] of cluster) {
    const used = members.some((m) => (incident.get(m)?.size ?? 0) > 0);
    if (!used) continue;
    const c = centroid(members.map((m) => nodePos.get(m)!));
    const node: CityNode = {
      id: city.nodes.length,
      x: round2(c.x),
      z: round2(c.z),
      radius: 0,
      in: [],
      out: [],
      signal: null,
      name: '',
    };
    if (members.some((m) => boundary.has(m))) node.boundary = true;
    city.nodes.push(node);
    nodeOfCluster.set(key, node);
    radius.set(node.id, Math.max(0, ...members.map((m) => dist(nodePos.get(m)!, c))));
  }
  const cityNode = (osmGraphNode: number) => nodeOfCluster.get(clusterOf.get(osmGraphNode)!)!;

  const streetByName = new Map<string, Street>();
  const streetOf = (e: WorkEdge) => {
    const key = e.src.name || `#${e.src.cls}`;
    let s = streetByName.get(key);
    const w = laneWidthOf(e.src.cls);
    const half = halfWidthOf(e);
    if (!s) {
      s = {
        id: city.streets.length,
        name: e.src.name,
        cls: RANK[e.src.cls] >= RANK.secondary ? 'boulevard' : 'local',
        lanesPerDir: Math.max(e.lanesFwd, e.lanesBwd),
        laneWidth: w,
        halfWidth: half,
        speed: e.src.speed,
      };
      city.streets.push(s);
      streetByName.set(key, s);
    } else {
      s.lanesPerDir = Math.max(s.lanesPerDir, e.lanesFwd, e.lanesBwd);
      s.halfWidth = Math.max(s.halfWidth, half);
      s.speed = Math.max(s.speed, e.src.speed);
    }
    return s;
  };

  // ── segments ──
  interface SegInfo {
    edge: WorkEdge;
    forward: boolean;
    base: Polyline;
    lanes: number;
    width: number;
    twoWay: boolean;
    turn?: string;
  }
  const info: SegInfo[] = [];
  const segOfEdge = new Map<number, { fwd?: Segment; bwd?: Segment }>();
  for (const e of edges.values()) {
    const street = streetOf(e);
    const twoWay = e.lanesFwd > 0 && e.lanesBwd > 0;
    const pair: { fwd?: Segment; bwd?: Segment } = {};
    for (const forward of [true, false]) {
      const n = forward ? e.lanesFwd : e.lanesBwd;
      if (n === 0) continue;
      const pts = forward ? e.pts : [...e.pts].reverse();
      const from = cityNode(forward ? e.a : e.b);
      const to = cityNode(forward ? e.b : e.a);
      const base = polyline(pts);
      const seg: Segment = {
        id: city.segments.length,
        from: from.id,
        to: to.id,
        street: street.id,
        dirIn: chordTangent(base, true),
        dirOut: chordTangent(base, false),
        lanes: [],
        length: base.length,
        speed: e.src.speed,
        reverse: -1,
        rank: RANK[e.src.cls] + (e.src.roundabout ? RING_BONUS : 0),
        phase: 0,
      };
      if (e.src.psvOnly) seg.psvOnly = true;
      city.segments.push(seg);
      city.segmentByKey.set(`${from.id}>${to.id}`, seg.id);
      from.out.push(seg.id);
      to.in.push(seg.id);
      info.push({ edge: e, forward, base, lanes: n, width: laneWidthOf(e.src.cls), twoWay, turn: forward ? e.turnFwd : e.turnBwd });
      if (forward) pair.fwd = seg;
      else pair.bwd = seg;
    }
    if (pair.fwd && pair.bwd) {
      pair.fwd.reverse = pair.bwd.id;
      pair.bwd.reverse = pair.fwd.id;
    }
    segOfEdge.set(e.id, pair);
  }

  // ── junction sizes: room for the widest crossing road ──
  const degreeOf = new Map<number, number>();
  for (const node of city.nodes) {
    const segs = [...node.in, ...node.out];
    const degree = new Set(segs.map((s) => info[s]!.edge.id)).size;
    degreeOf.set(node.id, degree);
    let r = 0;
    if (!node.boundary && degree >= 3) {
      r = radius.get(node.id)! + Math.max(...segs.map((s) => halfWidthOf(info[s]!.edge))) + 1.5;
    } else if (!node.boundary && degree === 2) r = 1.5;
    node.radius = Math.min(r, CLUSTER_RADIUS);
    const names = [...new Set(segs.map((s) => city.streets[city.segments[s]!.street]!.name).filter(Boolean))];
    node.name = names.slice(0, 3).join(' × ') || 'Raskrsnica';
  }

  // ── traffic signals: an OSM signal node belongs to the nearest junction within reach ──
  const junctions = city.nodes.filter((n) => !n.boundary && degreeOf.get(n.id)! >= 3);
  const lit = new Set<number>();
  for (const n of roads.nodes) {
    if (!n.signals) continue;
    let best: CityNode | null = null;
    let bestGap = Infinity;
    for (const j of junctions) {
      const gap = dist(n, j) - j.radius;
      if (gap < bestGap) {
        bestGap = gap;
        best = j;
      }
    }
    if (best && bestGap <= SIGNAL_REACH) lit.add(best.id);
  }
  for (const id of lit) planSignal(city, city.nodes[id]!);

  // ── roads cut by the frame right next to a junction get a stub outside the frame ──
  for (const seg of city.segments) {
    const si = info[seg.id]!;
    const from = city.nodes[seg.from]!;
    const to = city.nodes[seg.to]!;
    const room = Math.max(from.radius, to.radius) + 6;
    if (!(from.boundary || to.boundary) || si.base.length >= room) continue;
    const pts = [...si.base.points];
    const extra = room - si.base.length;
    if (from.boundary) pts[0] = sub(pts[0]!, scale(startTangent(si.base), extra));
    else pts[pts.length - 1] = add(pts[pts.length - 1]!, scale(endTangent(si.base), extra));
    si.base = polyline(pts);
    seg.length = si.base.length;
  }

  // ── lanes ──
  for (const seg of city.segments) {
    const si = info[seg.id]!;
    const from = city.nodes[seg.from]!;
    const to = city.nodes[seg.to]!;
    for (let i = 0; i < si.lanes; i++) {
      const offset = si.twoWay ? (i + 0.5) * si.width : (i + 0.5) * si.width - (si.lanes * si.width) / 2;
      const shifted = polyline(offsetPoints(si.base.points, offset));
      const line = trimToJunctions(shifted, from, to);
      const lane: Lane = {
        id: city.lanes.length,
        seg: seg.id,
        index: i,
        lanesInSeg: si.lanes,
        line,
        start: line.points[0]!,
        end: line.points[line.points.length - 1]!,
        length: line.length,
        offset,
        out: [],
        in: [],
      };
      city.lanes.push(lane);
      seg.lanes.push(lane.id);
    }
  }

  // ── turn restrictions resolved onto segments ──
  const workEdgeOf = new Map<number, WorkEdge>();
  for (const e of edges.values()) for (const id of e.merged) workEdgeOf.set(id, e);
  const banned = new Set<string>();
  const onlyTo = new Map<number, Set<number>>();
  for (const r of roads.restrictions) {
    const fe = workEdgeOf.get(r.from);
    const te = workEdgeOf.get(r.to);
    const via = clusterOf.has(r.via) ? nodeOfCluster.get(clusterOf.get(r.via)!) : undefined;
    if (!fe || !te || !via) continue;
    const fp = segOfEdge.get(fe.id)!;
    const tp = segOfEdge.get(te.id)!;
    const fromSeg = [fp.fwd, fp.bwd].find((s) => s && s.to === via.id);
    const toSeg = [tp.fwd, tp.bwd].find((s) => s && s.from === via.id);
    if (!fromSeg || !toSeg) continue;
    if (r.only) {
      const set = onlyTo.get(fromSeg.id) ?? new Set<number>();
      set.add(toSeg.id);
      onlyTo.set(fromSeg.id, set);
    } else banned.add(`${fromSeg.id}>${toSeg.id}`);
  }

  // ── connectors ──
  for (const node of city.nodes) {
    const created: Connector[] = [];
    for (const inId of node.in) {
      const sIn = city.segments[inId]!;
      const only = onlyTo.get(inId);
      const moves: { sOut: Segment; turn: Turn }[] = [];
      for (const outId of node.out) {
        const sOut = city.segments[outId]!;
        if (info[outId]!.edge === info[inId]!.edge) continue;
        if (banned.has(`${inId}>${outId}`) || (only && !only.has(outId))) continue;
        const turn = turnBetween(sIn, sOut);
        if (turn) moves.push({ sOut, turn });
      }
      const lanesIn = sIn.lanes.map((l) => city.lanes[l]!);
      const marks = parseTurnLanes(info[inId]!.turn, lanesIn.length);
      for (const { sOut, turn } of moves) {
        const lanesOut = sOut.lanes.map((l) => city.lanes[l]!);
        for (const [i, j] of laneMoves(turn, lanesIn.length, lanesOut.length, marks)) {
          created.push(connect(city, node, lanesIn[i]!, lanesOut[j]!, turn, sIn, sOut));
        }
      }
      // Dead end of a two-way street: turn around from the inner lane.
      if (!moves.length && !node.boundary && node.out.length && node.out.every((o) => info[o]!.edge === info[inId]!.edge)) {
        const back = city.segments[node.out[0]!]!;
        created.push(connect(city, node, lanesIn[0]!, city.lanes[back.lanes[0]!]!, 'L', sIn, back));
      }
      // Every lane must lead somewhere when the junction lets the segment go on at all.
      if (moves.length) {
        for (const lane of lanesIn) {
          if (lane.out.length) continue;
          const move = moves.find((m) => m.turn === 'S') ?? moves[0]!;
          const target = city.lanes[move.sOut.lanes[Math.min(lane.index, move.sOut.lanes.length - 1)]!]!;
          created.push(connect(city, node, lane, target, move.turn, sIn, move.sOut));
        }
      }
    }
    for (let i = 0; i < created.length; i++) {
      for (let j = i + 1; j < created.length; j++) {
        const a = created[i]!;
        const c = created[j]!;
        if (a.from === c.from) continue;
        if (polylinesConflict(a.line, c.line, CONFLICT_CLEARANCE)) {
          a.conflicts.push(c.id);
          c.conflicts.push(a.id);
        }
      }
    }
  }
  void signalPoints;
  for (const id of largestCarScc(city)) city.segments[id]!.core = true;
  for (const e of edges.values()) city.roads.push(roadStrip(e));
  addPlaces(city, district);
  layoutDepots(city, district.depotSites);
  parkCars(city);
  return city;
}

/** Paved width around the OSM centre line: two-way lanes sit right and left of it, one-way lanes centred. */
function roadStrip(e: WorkEdge): RoadStrip {
  const w = laneWidthOf(e.src.cls);
  const twoWay = e.lanesFwd > 0 && e.lanesBwd > 0;
  const half = ((e.lanesFwd + e.lanesBwd) * w) / 2;
  return { points: e.pts, left: twoWay ? e.lanesBwd * w : half, right: twoWay ? e.lanesFwd * w : half };
}

/** Largest set of segments that cars can drive between in both directions without leaving the map. */
function largestCarScc(city: City): number[] {
  const n = city.segments.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const c of city.connectors) {
    const a = city.lanes[c.from]!.seg;
    const b = city.lanes[c.to]!.seg;
    if (!city.segments[a]!.psvOnly && !city.segments[b]!.psvOnly) adj[a]!.push(b);
  }
  return largestStronglyConnected(adj);
}

// ───────────────────────────── signals ─────────────────────────────

/**
 * Phases from approach directions: opposite approaches (and parallel carriageways) move together.
 * The phase carrying the highest-ranked road gets the long green; offsets are spread by node id.
 */
function planSignal(city: City, node: CityNode) {
  const approaches = node.in.map((s) => city.segments[s]!);
  const groups: Segment[][] = [];
  for (const a of approaches) {
    const g = groups.find((list) => list.every((b) => Math.abs(dot(a.dirOut, b.dirOut)) > PHASE_ALIGN));
    if (g) g.push(a);
    else groups.push([a]);
  }
  if (groups.length < 2) return;
  groups.forEach((g, i) => g.forEach((s) => (s.phase = i)));
  const top = Math.max(...approaches.map((s) => s.rank));
  const phases = groups.map((g) => ({ green: g.some((s) => s.rank === top) ? GREEN_MAIN : GREEN_SIDE }));
  const cycle = cycleOf({ phases, offset: 0 });
  node.signal = { phases, offset: (node.id * 7919) % cycle };
}

// ───────────────────────────── graph simplification ─────────────────────────────

function incidence(edges: Map<number, WorkEdge>) {
  const inc = new Map<number, Set<number>>();
  const add1 = (n: number, e: number) => {
    let s = inc.get(n);
    if (!s) inc.set(n, (s = new Set()));
    s.add(e);
  };
  for (const e of edges.values()) {
    add1(e.a, e.id);
    add1(e.b, e.id);
  }
  return inc;
}

function reversed(e: WorkEdge): WorkEdge {
  return { ...e, a: e.b, b: e.a, pts: [...e.pts].reverse(), lanesFwd: e.lanesBwd, lanesBwd: e.lanesFwd, turnFwd: e.turnBwd, turnBwd: e.turnFwd };
}

/**
 * Joins the two roads meeting at every pass-through node (degree 2, same road profile) into one.
 * Returns the positions of traffic signals that sat on folded nodes.
 */
function foldPassThrough(edges: Map<number, WorkEdge>, boundary: Set<number>, signalled: Set<number>, nodePos: Map<number, Vec2>): Vec2[] {
  const points: Vec2[] = [];
  const inc = incidence(edges);
  for (const [node, set] of inc) {
    if (set.size !== 2 || boundary.has(node)) continue;
    const [id1, id2] = [...set] as [number, number];
    let e1 = edges.get(id1)!;
    let e2 = edges.get(id2)!;
    if (e1.a === e1.b || e2.a === e2.b) continue;
    if (e1.b !== node) e1 = reversed(e1);
    if (e2.a !== node) e2 = reversed(e2);
    if (e1.a === e2.b) continue;
    const s1 = e1.src;
    const s2 = e2.src;
    const same =
      s1.cls === s2.cls &&
      s1.layer === s2.layer &&
      !!s1.psvOnly === !!s2.psvOnly &&
      !!s1.roundabout === !!s2.roundabout &&
      !!s1.tunnel === !!s2.tunnel &&
      e1.lanesFwd === e2.lanesFwd &&
      e1.lanesBwd === e2.lanesBwd;
    if (!same) continue;
    const merged: WorkEdge = {
      ...e1,
      b: e2.b,
      pts: [...e1.pts, ...e2.pts.slice(1)],
      turnFwd: e2.turnFwd,
      turnBwd: e1.turnBwd,
      merged: [...e1.merged, ...e2.merged],
      src: { ...s1, speed: Math.min(s1.speed, s2.speed), trolley: s1.trolley || s2.trolley ? true : undefined },
    };
    edges.delete(id2);
    edges.set(id1, merged);
    inc.get(e2.b)!.delete(id2);
    inc.get(e2.b)!.add(id1);
    set.clear();
    if (signalled.has(node)) points.push(nodePos.get(node)!);
  }
  return points;
}

// ───────────────────────────── geometry ─────────────────────────────

function centroid(ps: Vec2[]): Vec2 {
  const s = ps.reduce((a, p) => add(a, p), { x: 0, z: 0 });
  return scale(s, 1 / ps.length);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function halfWidthOf(e: WorkEdge) {
  const w = laneWidthOf(e.src.cls);
  return e.lanesFwd > 0 && e.lanesBwd > 0 ? Math.max(e.lanesFwd, e.lanesBwd) * w : ((e.lanesFwd + e.lanesBwd) * w) / 2;
}

/** Direction over the first / last TANGENT_SPAN metres: robust to tiny kinks at OSM nodes. */
function chordTangent(line: Polyline, atStart: boolean): Vec2 {
  const span = Math.min(TANGENT_SPAN, line.length);
  const a = atStart ? pointAt(line, 0) : pointAt(line, line.length - span);
  const b = atStart ? pointAt(line, span) : pointAt(line, line.length);
  const d = sub(b, a);
  return Math.hypot(d.x, d.z) > 1e-6 ? norm(d) : atStart ? startTangent(line) : endTangent(line);
}

function pointAt(line: Polyline, s: number): Vec2 {
  const { points, cum } = line;
  let i = 1;
  while (i < points.length - 1 && cum[i]! < s) i++;
  const a = points[i - 1]!;
  const b = points[i]!;
  const len = cum[i]! - cum[i - 1]! || 1;
  const t = Math.max(0, Math.min(1, (s - cum[i - 1]!) / len));
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/** Parallel polyline `d` metres to the right (mitred joins, limited at sharp bends). */
export function offsetPoints(points: Vec2[], d: number): Vec2[] {
  const n = points.length;
  const normals: Vec2[] = [];
  for (let i = 1; i < n; i++) {
    const t = norm(sub(points[i]!, points[i - 1]!));
    normals.push({ x: -t.z, z: t.x });
  }
  return points.map((p, i) => {
    if (i === 0) return add(p, scale(normals[0]!, d));
    if (i === n - 1) return add(p, scale(normals[n - 2]!, d));
    const n1 = normals[i - 1]!;
    const n2 = normals[i]!;
    const m = norm(add(n1, n2));
    const k = Math.max(0.5, dot(m, n1));
    return add(p, scale(m, d / k));
  });
}

/** Cuts a lane centre line where it leaves the start junction and enters the end junction. */
function trimToJunctions(line: Polyline, from: CityNode, to: CityNode): Polyline {
  const L = line.length;
  let s0 = exitArc(line, from, from.radius, true);
  let s1 = exitArc(line, to, to.radius, false);
  // Junction circles may overlap on short roads: keep at least 2.5 m of lane (or the whole road).
  const minLen = Math.min(2.5, L);
  if (L - s0 - s1 < minLen) {
    const f = Math.max(0, (L - minLen) / Math.max(1e-6, s0 + s1));
    s0 *= f;
    s1 *= f;
  }
  return slice(line, s0, L - s1);
}

/** Arc length from the given end of the line to where it leaves a circle of radius r around the node. */
function exitArc(line: Polyline, node: Vec2, r: number, fromStart: boolean): number {
  if (r <= 0) return 0;
  const L = line.length;
  const at = (s: number) => pointAt(line, fromStart ? s : L - s);
  if (dist(at(0), node) >= r) return 0;
  let lo = 0;
  let hi = L;
  if (dist(at(hi), node) < r) return L;
  // Walk out in 1 m steps, then bisect.
  for (let s = 1; s <= L; s += 1) {
    if (dist(at(s), node) >= r) {
      hi = s;
      lo = s - 1;
      break;
    }
  }
  for (let k = 0; k < 20; k++) {
    const mid = (lo + hi) / 2;
    if (dist(at(mid), node) < r) lo = mid;
    else hi = mid;
  }
  return hi;
}

function slice(line: Polyline, s0: number, s1: number): Polyline {
  const pts: Vec2[] = [pointAt(line, s0)];
  for (let i = 1; i < line.points.length - 1; i++) if (line.cum[i]! > s0 + 0.05 && line.cum[i]! < s1 - 0.05) pts.push(line.points[i]!);
  pts.push(pointAt(line, s1));
  return polyline(pts);
}

// ───────────────────────────── lanes and connectors ─────────────────────────────

/** Turns allowed per lane from OSM turn:lanes ("left|through;right"), or null when absent or inconsistent. */
export function parseTurnLanes(tag: string | undefined, lanes: number): Set<Turn>[] | null {
  if (!tag) return null;
  const parts = tag.split('|');
  if (parts.length !== lanes) return null;
  return parts.map((p) => {
    const set = new Set<Turn>();
    for (const t of p.split(';')) {
      if (t.includes('left')) set.add('L');
      else if (t.includes('right')) set.add('R');
      else if (t === 'reverse') continue;
      else set.add('S');
    }
    if (!set.size) set.add('S');
    return set;
  });
}

/** (in lane index, out lane index) pairs for one turn. Index 0 is the inner lane. */
function laneMoves(turn: Turn, nIn: number, nOut: number, marks: Set<Turn>[] | null): [number, number][] {
  let from: number[] = [];
  if (marks) from = marks.flatMap((m, i) => (m.has(turn) ? [i] : []));
  if (!from.length) from = turn === 'L' ? [0] : turn === 'R' ? [nIn - 1] : [...Array(nIn).keys()];
  const out: [number, number][] = [];
  const push = (i: number, j: number) => {
    if (j >= 0 && j < nOut && !out.some(([a, b]) => a === i && b === j)) out.push([i, j]);
  };
  if (turn === 'S') {
    for (const i of from) {
      const m = nIn === 1 ? nOut - 1 : Math.round((i * (nOut - 1)) / (nIn - 1));
      for (const j of [m - 1, m, m + 1]) push(i, j);
    }
  } else if (turn === 'L') {
    from.forEach((i, r) => [r, r + 1].forEach((j) => push(i, j)));
  } else {
    [...from].reverse().forEach((i, r) => [nOut - 1 - r, nOut - 2 - r].forEach((j) => push(i, j)));
  }
  return out;
}

function connect(city: City, node: CityNode, inLane: Lane, outLane: Lane, turn: Turn, sIn: Segment, sOut: Segment): Connector {
  const p0 = inLane.end;
  const p1 = outLane.start;
  const d0 = endTangent(inLane.line);
  const d1 = startTangent(outLane.line);
  const chord = dist(p0, p1);
  let points: Vec2[];
  let vmax = Math.min(sIn.speed, sOut.speed);
  if (Math.abs(cross(d0, d1)) < 0.17 && dot(d0, d1) > 0) {
    points = [p0, p1];
  } else {
    let c = lineIntersection(p0, d0, p1, d1);
    if (!c || dot(sub(c, p0), d0) <= 0 || dot(sub(p1, c), d1) <= 0 || dist(c, p0) > 3 * chord) {
      c = scale(add(add(p0, scale(d0, chord / 2)), sub(p1, scale(d1, chord / 2))), 0.5);
    }
    points = quadBezier(p0, c, p1, 10);
    const r = Math.max(1, Math.min(dist(c, p0), dist(c, p1)));
    vmax = Math.max(3.5, Math.min(vmax, Math.sqrt(2.4 * r)));
  }
  const conn: Connector = {
    id: city.connectors.length,
    node: node.id,
    from: inLane.id,
    to: outLane.id,
    turn,
    phase: sIn.phase,
    line: polyline(points),
    vmax,
    conflicts: [],
  };
  city.connectors.push(conn);
  inLane.out.push(conn.id);
  outLane.in.push(conn.id);
  return conn;
}
