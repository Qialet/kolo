import {
  add,
  cross,
  cubicBezier,
  dist,
  dot,
  endTangent,
  lineIntersection,
  norm,
  polyline,
  polylinesConflict,
  poseAlong,
  projectOnPolyline,
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
import { buildTwins } from './corridors.js';
import { layoutDepots } from './depots.js';
import { addPlaces, parkCars } from './places.js';
import { aroundIsland, findRings, pushOutOf, type Ring } from './rings.js';
import { applySigns } from './signs.js';
import { laySurface, offsetPoints, placeCrossings, pointAt, slice, trimToJunctions, type SurfaceRoad } from './surface.js';
import { addTransit } from './transit-places.js';
import type { City, CityNode, Connector, Lane, Segment, Street, Turn } from './types.js';

/** Junction nodes joined by roads shorter than this become one junction (dual carriageways). */
const CLUSTER_EDGE = 18;
/** Any two nodes this close are merged, whatever they are. */
const TINY_EDGE = 3;
const CLUSTER_RADIUS = 30;
/** Ring pieces shorter than this merge their ends (a car could not stop on them). */
const RING_TINY = 8;
/** A ring junction takes in a track crossing at most this far beyond the ring's half width. */
const RING_REACH = 6;
/** Length over which a segment's entry / exit direction is measured. */
const TANGENT_SPAN = 15;
const CONFLICT_CLEARANCE = 1.6;
/** Bends of a road sharper than this are rounded off (a single OSM corner node would pinch the asphalt). */
const ROUND_BEND = (35 * Math.PI) / 180;
/** Centre-line radius of a rounded bend, unless the road pieces around it are too short. */
const BEND_RADIUS = 8;
/** Sharpest bend a tram takes through a switch or across another track. */
const SWITCH_COS = Math.cos((60 * Math.PI) / 180);
/** Junction circle radius per metre of kerb shift where a road changes width: a taper of 1 in 8. */
const TAPER = 4;
const TAPER_MAX = 15;
/** OSM puts signal nodes on the approach, up to this far outside the junction circle. */
const SIGNAL_REACH = 25;
/** |cos| above which two approaches share a phase (opposite or parallel within 30°). */
const PHASE_ALIGN = Math.cos((30 * Math.PI) / 180);
const GREEN_MAIN = 45;
const GREEN_SIDE = 30;
/** Lights at both ends of a link with less lane than this between them run as one. */
const SHORT_LINK = 30;

const RANK: Record<RoadClass, number> = {
  trunk: 6,
  primary: 5,
  secondary: 4,
  tertiary: 3,
  busway: 3,
  unclassified: 2,
  residential: 2,
  living_street: 1,
  // Trams go first at unsignalised crossings, even before a roundabout's own traffic.
  tram: 20,
};
const RING_BONUS = 10;
export const laneWidthOf = (cls: RoadClass) => (cls === 'tram' ? 2.6 : cls === 'residential' || cls === 'living_street' ? 3.0 : 3.2);

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
  const rings = findRings(
    [...edges.values()]
      .filter((e) => e.src.roundabout)
      .map((e) => (e.lanesFwd > 0 ? { a: e.a, b: e.b, pts: e.pts, half: halfWidthOf(e) } : { a: e.b, b: e.a, pts: [...e.pts].reverse(), half: halfWidthOf(e) })),
  );
  const ringOfOsm = new Map<number, Ring>();
  for (const ring of rings) for (const n of ring.nodes) ringOfOsm.set(n, ring);

  // ── junction clusters ──
  const incident = incidence(edges);
  const ringNode = new Set<number>();
  for (const e of edges.values()) if (e.src.roundabout) ringNode.add(e.a).add(e.b);
  const isJunction = (n: number) => (incident.get(n)?.size ?? 0) >= 3 || signalled.has(n) || ringNode.has(n);
  // A street passing over a track is no street junction: it must not stretch the circle of the real one next to it.
  const roadDegree = (n: number) => [...(incident.get(n) ?? [])].filter((id) => edges.get(id)!.src.cls !== 'tram').length;
  const sizesJunction = new Set([...nodePos.keys()].filter((n) => roadDegree(n) >= 3 || signalled.has(n) || ringNode.has(n)));
  const cluster = new Map<number, number[]>();
  const clusterOf = new Map<number, number>();
  for (const n of nodePos.keys()) {
    cluster.set(n, [n]);
    clusterOf.set(n, n);
  }
  // A small ring is one junction: cars drive round its island through the junction.
  for (const ring of rings) {
    if (!ring.mini) continue;
    const members = [...ring.nodes];
    for (const m of members) cluster.delete(m);
    cluster.set(members[0]!, members);
    for (const m of members) clusterOf.set(m, members[0]!);
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
    // Off the ring a ring junction takes in only what does not size a junction and lies by its outer kerb
    // (a track crossing its road): a street junction next to it would stretch its circle over the ring.
    const onRing = members.filter((m) => ringNode.has(m));
    if (!e.src.roundabout && onRing.length) {
      if (onRing.length > 1 || members.some((m) => !ringNode.has(m) && sizesJunction.has(m))) continue;
      const kerb = (ringOfOsm.get(onRing[0]!)?.half ?? 0) + RING_REACH;
      if (members.some((m) => dist(nodePos.get(m)!, nodePos.get(onRing[0]!)!) > kerb)) continue;
    }
    const c = centroid(members.map((m) => nodePos.get(m)!));
    if (members.some((m) => dist(nodePos.get(m)!, c) > CLUSTER_RADIUS)) continue;
    cluster.set(ca, members);
    cluster.delete(cb);
    for (const m of members) clusterOf.set(m, ca);
  }
  // Tracks inside a junction keep their OSM course for the track curves between its approaches.
  const innerTracks = new Map<number, WorkEdge[]>();
  for (const e of edges.values()) {
    if (e.src.cls !== 'tram' || clusterOf.get(e.a) !== clusterOf.get(e.b)) continue;
    const key = clusterOf.get(e.a)!;
    innerTracks.set(key, [...(innerTracks.get(key) ?? []), e]);
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
    pads: [],
    crossings: [],
    tracks: [],
    areas: [],
    buildings: [],
    trees: [],
    playgrounds: [],
    parkedCars: [],
    addresses: [],
    depots: [],
    busStops: [],
    busLines: [],
    transit: district.transit,
    pois: [],
    signs: [],
    segmentByKey: new Map(),
    addressById: new Map(),
  };
  const nodeOfCluster = new Map<number, CityNode>();
  const radius = new Map<number, number>();
  /** Distance from a junction's centre to its furthest OSM node, sizing or not (a track crossing taken in). */
  const reach = new Map<number, number>();
  /** Ring a junction lies on (a small ring: the junction it collapsed into). */
  const ringAt = new Map<number, Ring>();
  for (const [key, members] of cluster) {
    const used = members.some((m) => (incident.get(m)?.size ?? 0) > 0);
    if (!used) continue;
    const sized = members.filter((m) => sizesJunction.has(m));
    const shape = sized.length ? sized : members;
    const c = centroid(shape.map((m) => nodePos.get(m)!));
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
    radius.set(node.id, Math.max(0, ...shape.map((m) => dist(nodePos.get(m)!, c))));
    reach.set(node.id, Math.max(0, ...members.map((m) => dist(nodePos.get(m)!, c))));
    const ring = members.map((m) => ringOfOsm.get(m)).find(Boolean);
    if (ring) ringAt.set(node.id, ring);
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

  for (const e of edges.values()) if (e.src.cls !== 'tram') e.pts = roundCorners(e.pts);

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
      const rank = RANK[e.src.cls] + (e.src.roundabout ? RING_BONUS : 0);
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
        rank,
        priority: rank,
        phase: 0,
        layer: e.src.layer,
      };
      if (e.src.psvOnly) seg.psvOnly = true;
      if (e.src.trolley) seg.trolley = true;
      if (e.src.cls === 'tram') seg.rail = true;
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

  /** Paved width left and right of a road looking out of the node along it. */
  const widthsOut = (node: CityNode, e: WorkEdge): [number, number] => {
    const pair = segOfEdge.get(e.id)!;
    const out = [pair.fwd, pair.bwd].find((s) => s?.from === node.id);
    const back = [pair.fwd, pair.bwd].find((s) => s?.to === node.id);
    const w = laneWidthOf(e.src.cls);
    if (out && back) return [info[back.id]!.lanes * w, info[out.id]!.lanes * w];
    const half = ((e.lanesFwd + e.lanesBwd) * w) / 2;
    return [half, half];
  };
  /** A road that changes width at a node gets a circle long enough for its kerbs and lanes to taper. */
  const taperRadius = (node: CityNode, segs: number[]) => {
    const legs = [...new Set(segs.map((s) => info[s]!.edge))];
    if (legs.length !== 2 || legs.some((e) => e.src.cls === 'tram' || e.a === e.b)) return 0;
    const [l1, r1] = widthsOut(node, legs[0]!);
    const [l2, r2] = widthsOut(node, legs[1]!);
    // Looking out along one road the right kerb carries on as the left kerb of the other.
    const shift = Math.max(Math.abs(r1 - l2), Math.abs(l1 - r2));
    if (shift < 0.25) return 0;
    // Take at most 40% of what the junction at the road's other end leaves of it.
    const room = Math.min(
      ...legs.map((e) => {
        const s = (segOfEdge.get(e.id)!.fwd ?? segOfEdge.get(e.id)!.bwd)!;
        const other = city.nodes[s.from === node.id ? s.to : s.from]!;
        return 0.4 * (polyline(e.pts).length - other.radius);
      }),
    );
    return Math.min(TAPER * shift, TAPER_MAX, room);
  };

  // ── junction sizes: room for the widest crossing road ──
  /** Where the ring's own lanes and the roads off it end at a junction on a big ring, from its centre. */
  const ringCut = new Map<number, { ring: number; road: number }>();
  /** Distance from a junction's centre at which the road's lanes and asphalt end. */
  const cutAt = (node: CityNode, e: WorkEdge) => {
    const cut = ringCut.get(node.id);
    return cut ? (e.src.roundabout ? cut.ring : cut.road) : node.radius;
  };
  const degreeOf = new Map<number, number>();
  /** Streets meeting at a node, tracks left out: only road junctions take traffic lights. */
  const roadDegreeOf = new Map<number, number>();
  for (const node of city.nodes) {
    const segs = [...node.in, ...node.out];
    const degree = new Set(segs.map((s) => info[s]!.edge.id)).size;
    degreeOf.set(node.id, degree);
    roadDegreeOf.set(node.id, new Set(segs.filter((s) => !city.segments[s]!.rail).map((s) => info[s]!.edge.id)).size);
    let r = 0;
    if (!node.boundary && degree >= 3) {
      r = radius.get(node.id)! + Math.max(...segs.map((s) => halfWidthOf(info[s]!.edge))) + 1.5;
    } else if (!node.boundary && degree === 2) r = 1.5;
    // On a ring the roads end at its outer kerb, while the ring itself runs on through: the entry
    // merges into it and the exit leaves it within the width of the road.
    const ring = ringAt.get(node.id);
    const roads = segs.filter((s) => !info[s]!.edge.src.roundabout);
    if (ring && !ring.mini && !node.boundary && roads.length && roads.length < segs.length) {
      const spread = radius.get(node.id)!;
      const ringHalf = Math.max(...segs.filter((s) => info[s]!.edge.src.roundabout).map((s) => halfWidthOf(info[s]!.edge)));
      const roadHalf = Math.max(...roads.map((s) => pavedHalfOf(info[s]!.edge)));
      // The roads end past any track crossing taken in, so nobody waits on the rails.
      const cut = { ring: spread + Math.max(3, roadHalf + 1.5), road: Math.max(spread + ringHalf + 1.5, reach.get(node.id)! + 3) };
      ringCut.set(node.id, cut);
      r = Math.max(cut.ring, cut.road);
    }
    node.radius = Math.min(r, CLUSTER_RADIUS);
    const names = [...new Set(segs.map((s) => city.streets[city.segments[s]!.street]!.name).filter(Boolean))];
    node.name = names.slice(0, 3).join(' × ') || 'Raskrsnica';
  }

  // Tapers, once the junctions around them have their size.
  for (const node of city.nodes) {
    if (!node.boundary && degreeOf.get(node.id) === 2) node.radius = Math.max(node.radius, taperRadius(node, [...node.in, ...node.out]));
  }

  // ── traffic signals: an OSM signal node belongs to the nearest junction within reach ──
  const junctions = city.nodes.filter((n) => !n.boundary && roadDegreeOf.get(n.id)! >= 3);
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
  pairSignals(city);

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
      const offset = seg.rail ? 0 : si.twoWay ? (i + 0.5) * si.width : (i + 0.5) * si.width - (si.lanes * si.width) / 2;
      const shifted = polyline(offsetPoints(si.base.points, offset));
      const circles: [CityNode, CityNode] = [
        { ...from, radius: cutAt(from, si.edge) },
        { ...to, radius: cutAt(to, si.edge) },
      ];
      let line = trimToJunctions(shifted, ...circles);
      if (ringCut.has(from.id) || ringCut.has(to.id)) {
        // On a ring every lane ends square across the road where its centre line leaves the circle: an outer
        // ring lane can lie wholly outside the circle.
        const across = trimToJunctions(si.base, ...circles).points;
        const s0 = projectOnPolyline(shifted, ringCut.has(from.id) ? across[0]! : line.points[0]!);
        const s1 = projectOnPolyline(shifted, ringCut.has(to.id) ? across[across.length - 1]! : line.points[line.points.length - 1]!);
        line = slice(shifted, s0, Math.max(s1, s0 + 0.5));
      }
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

  /**
   * OSM course of the track from the end of one rail segment to the start of another through their
   * junction (empty when they meet at one OSM node), or null when no track joins them there. A tram
   * runs on through a switch or a crossing only where the track bends less than SWITCH_BEND.
   */
  const trackCourse = (sIn: Segment, sOut: Segment): Vec2[] | null => {
    const a = info[sIn.id]!;
    const b = info[sOut.id]!;
    const u = a.forward ? a.edge.b : a.edge.a;
    const v = b.forward ? b.edge.a : b.edge.b;
    const arrive = trackDir(a.base.points, false);
    const leave = trackDir(b.base.points, true);
    if (u === v) return dot(arrive, leave) > SWITCH_COS ? [] : null;
    // Pieces of the junction's own tracks in their direction of travel.
    const ways = (innerTracks.get(clusterOf.get(u)!) ?? []).flatMap((e) => {
      const out: { from: number; to: number; pts: Vec2[]; len: number }[] = [];
      if (e.lanesFwd > 0) out.push({ from: e.a, to: e.b, pts: e.pts, len: polyline(e.pts).length });
      if (e.lanesBwd > 0) out.push({ from: e.b, to: e.a, pts: [...e.pts].reverse(), len: polyline(e.pts).length });
      return out;
    });
    const runsOn = (from: Vec2, pts: Vec2[]) => dot(from, trackDir(pts, true)) > SWITCH_COS;
    // Shortest chain of pieces (a handful: plain relaxation over pieces, each entered straight enough).
    const best = new Map<number, { len: number; pts: Vec2[] }>();
    ways.forEach((w, i) => {
      if (w.from === u && runsOn(arrive, w.pts)) best.set(i, { len: w.len, pts: w.pts });
    });
    for (let round = 0, changed = true; changed && round <= ways.length; round++) {
      changed = false;
      ways.forEach((w, i) => {
        const at = best.get(i);
        if (!at) return;
        ways.forEach((next, j) => {
          if (next.from !== w.to || !runsOn(trackDir(w.pts, false), next.pts)) return;
          const len = at.len + next.len;
          if ((best.get(j)?.len ?? Infinity) <= len) return;
          best.set(j, { len, pts: [...at.pts, ...next.pts] });
          changed = true;
        });
      });
    }
    let found: { len: number; pts: Vec2[] } | null = null;
    ways.forEach((w, i) => {
      const at = best.get(i);
      if (at && w.to === v && dot(trackDir(w.pts, false), leave) > SWITCH_COS && (!found || at.len < found.len)) found = at;
    });
    return found ? (found as { pts: Vec2[] }).pts : null;
  };

  // ── connectors ──
  for (const node of city.nodes) {
    const created: Connector[] = [];
    const ring = ringAt.get(node.id);
    const mini = ring?.mini ? ring : undefined;
    for (const inId of node.in) {
      const sIn = city.segments[inId]!;
      const only = onlyTo.get(inId);
      const moves: { sOut: Segment; turn: Turn }[] = [];
      for (const outId of node.out) {
        const sOut = city.segments[outId]!;
        if (info[outId]!.edge === info[inId]!.edge) continue;
        if (!!sOut.rail !== !!sIn.rail) continue;
        if (banned.has(`${inId}>${outId}`) || (only && !only.has(outId))) continue;
        const turn = turnBetween(sIn, sOut);
        if (turn) moves.push({ sOut, turn });
      }
      const lanesIn = sIn.lanes.map((l) => city.lanes[l]!);
      const marks = parseTurnLanes(info[inId]!.turn, lanesIn.length);
      for (const { sOut, turn } of moves) {
        if (sIn.rail) {
          // Trams take only the curves OSM lays: none where the tracks merely cross.
          const course = trackCourse(sIn, sOut);
          if (course) created.push(connectTrack(city, node, lanesIn[0]!, city.lanes[sOut.lanes[0]!]!, turn, sIn, sOut, [info[inId]!.base, course, info[sOut.id]!.base]));
          continue;
        }
        const lanesOut = sOut.lanes.map((l) => city.lanes[l]!);
        const onRing = ringCut.has(node.id) ? ringLaneMoves(!!info[inId]!.edge.src.roundabout, !!info[sOut.id]!.edge.src.roundabout, lanesIn.length, lanesOut.length) : null;
        for (const [i, j] of onRing ?? laneMoves(turn, lanesIn.length, lanesOut.length, marks)) {
          const round = mini ? connectRound(city, node, lanesIn[i]!, lanesOut[j]!, turn, sIn, sOut, mini) : null;
          created.push(round ?? connect(city, node, lanesIn[i]!, lanesOut[j]!, turn, sIn, sOut));
        }
      }
      // Dead end of a two-way street: turn around from the inner lane.
      if (!sIn.rail && !moves.length && !node.boundary && node.out.length && node.out.every((o) => info[o]!.edge === info[inId]!.edge)) {
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
  buildTwins(city);
  for (const flat of roads.scenery ?? []) {
    city.tracks.push({ points: Array.from({ length: flat.length / 2 }, (_, i) => ({ x: flat[2 * i]!, z: flat[2 * i + 1]! })), layer: 0, scenery: true });
  }
  const surfaceRoads: SurfaceRoad[] = [];
  for (const e of edges.values()) {
    if (e.src.cls === 'tram') {
      city.tracks.push({ points: e.pts, layer: e.src.layer });
      continue;
    }
    // A two-way road has both segments; a one-way road (folded edges may run backward) is centred either way.
    // The segment's base carries any stub past the frame.
    const pair = segOfEdge.get(e.id)!;
    const seg = (pair.fwd ?? pair.bwd)!;
    const w = laneWidthOf(e.src.cls);
    const twoWay = e.lanesFwd > 0 && e.lanesBwd > 0;
    const half = ((e.lanesFwd + e.lanesBwd) * w) / 2;
    const [from, to] = [city.nodes[seg.from]!, city.nodes[seg.to]!];
    const base = info[seg.id]!.base;
    // Where the lanes meet each junction: the ends of those running in, else the starts of those leaving.
    const back = seg.reverse >= 0 ? city.segments[seg.reverse] : undefined;
    const at = (s: Segment | undefined, end: boolean) => (s ? s.lanes.map((l) => projectOnPolyline(base, end ? city.lanes[l]!.end : city.lanes[l]!.start)) : []);
    const intoTo = at(seg, true);
    const intoFrom = back ? at(back, true) : at(seg, false);
    surfaceRoads.push({
      base,
      from,
      to,
      left: twoWay ? e.lanesBwd * w : half,
      right: twoWay ? e.lanesFwd * w : half,
      layer: e.src.layer,
      stopFrom: Math.min(...intoFrom),
      stopTo: Math.max(...intoTo),
      cutFrom: cutAt(from, e),
      cutTo: cutAt(to, e),
    });
  }
  // A junction pad needs two streets meeting; elsewhere the street runs on to the node.
  const surface = laySurface(city, surfaceRoads, (n) => !n.boundary && n.radius > 0 && roadDegreeOf.get(n.id)! >= 2);
  city.roads = surface.strips;
  city.pads = surface.pads;
  // The island stays clear of asphalt: a small ring's pad wraps round it, a big ring's pads stop at its kerb.
  for (const pad of city.pads) {
    const ring = ringAt.get(pad.node);
    if (ring?.mini) {
      // Kerb returns between the mouths keep clear of the ring that cars drive round.
      pad.outline = pushOutOf(pad.outline, ring.outer);
      pad.island = ring.island;
    } else if (ring) pad.outline = pushOutOf(pad.outline, ring.island);
  }
  city.crossings = placeCrossings(roads.crossings ?? [], surfaceRoads, surface.spans);
  addPlaces(city, district);
  addTransit(city, district.transit);
  layoutDepots(city, district.depotSites);
  parkCars(city);
  // Last: marking a few segments with a control changes their shape, which slows every later pass over the segments.
  applySigns(city, roads.nodes, (id) => info[id]!.base, (id) => !city.nodes[id]!.boundary && roadDegreeOf.get(id)! >= 3);
  return city;
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
    if (a.rail) continue;
    const g = groups.find((list) => list.every((b) => Math.abs(dot(a.dirOut, b.dirOut)) > PHASE_ALIGN));
    if (g) g.push(a);
    else groups.push([a]);
  }
  if (groups.length < 2) return;
  // Tracks never get a phase of their own: a tram moves with the street it runs closest to.
  for (const a of approaches) {
    if (!a.rail) continue;
    const align = (g: Segment[]) => Math.max(...g.map((b) => Math.abs(dot(a.dirOut, b.dirOut))));
    groups.reduce((best, g) => (align(g) > align(best) ? g : best)).push(a);
  }
  groups.forEach((g, i) => g.forEach((s) => (s.phase = i)));
  const top = Math.max(...approaches.filter((s) => !s.rail).map((s) => s.rank));
  const phases = groups.map((g) => ({ green: g.some((s) => !s.rail && s.rank === top) ? GREEN_MAIN : GREEN_SIDE }));
  const cycle = cycleOf({ phases, offset: 0 });
  node.signal = { phases, offset: (node.id * 7919) % cycle };
}

/**
 * Two-phase lights a short link apart run as one controller: the second takes the first one's plan and
 * offset, its phases turned so that the link's own direction goes green at both together (otherwise a
 * queue held on the link by the second light blocks the first junction for a whole cycle).
 */
function pairSignals(city: City) {
  const paired = new Set<number>();
  for (const s of city.segments) {
    const a = city.nodes[s.from]!;
    const b = city.nodes[s.to]!;
    if (s.rail || !a.signal || !b.signal || paired.has(b.id) || paired.has(a.id)) continue;
    if (a.signal.phases.length !== 2 || b.signal.phases.length !== 2 || s.length - a.radius - b.radius >= SHORT_LINK) continue;
    // The approach to `a` that runs on along the link carries the phase the link's traffic leaves on.
    const feeder = a.in.map((id) => city.segments[id]!).find((f) => !f.rail && dot(f.dirOut, s.dirIn) > PHASE_ALIGN);
    if (!feeder) continue;
    if (s.phase !== feeder.phase) for (const id of b.in) city.segments[id]!.phase = 1 - city.segments[id]!.phase;
    b.signal = { phases: a.signal.phases.map((p) => ({ ...p })), offset: a.signal.offset };
    paired.add(a.id).add(b.id);
  }
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

/** Direction of a track at its start (or end) over its first (last) few metres. */
function trackDir(pts: Vec2[], atStart: boolean): Vec2 {
  const line = polyline(pts);
  const span = Math.min(4, line.length);
  const p = atStart ? pointAt(line, 0) : pointAt(line, line.length - span);
  const q = atStart ? pointAt(line, span) : pointAt(line, line.length);
  return norm(sub(q, p));
}

/** Rounds every bend sharper than ROUND_BEND into a curve of BEND_RADIUS, within half of each piece around it. */
function roundCorners(raw: Vec2[]): Vec2[] {
  // OSM may repeat a point: a zero-length piece has no direction.
  const pts = raw.filter((p, i) => i === 0 || i === raw.length - 1 || dist(p, raw[i - 1]!) > 0.05);
  if (pts.length < 3) return pts;
  const out: Vec2[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, p, b] = [pts[i - 1]!, pts[i]!, pts[i + 1]!];
    const uIn = norm(sub(p, a));
    const uOut = norm(sub(b, p));
    const bend = Math.acos(Math.max(-1, Math.min(1, dot(uIn, uOut))));
    if (bend < ROUND_BEND) {
      out.push(p);
      continue;
    }
    const t = Math.min(BEND_RADIUS * Math.tan(Math.min(bend, 2.6) / 2), dist(a, p) / 2, dist(p, b) / 2);
    if (t < 0.3) {
      out.push(p);
      continue;
    }
    out.push(...quadBezier(sub(p, scale(uIn, t)), p, add(p, scale(uOut, t)), 6));
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

function centroid(ps: Vec2[]): Vec2 {
  const s = ps.reduce((a, p) => add(a, p), { x: 0, z: 0 });
  return scale(s, 1 / ps.length);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function halfWidthOf(e: WorkEdge) {
  const w = laneWidthOf(e.src.cls);
  return e.lanesFwd > 0 && e.lanesBwd > 0 ? Math.max(e.lanesFwd, e.lanesBwd) * w : ((e.lanesFwd + e.lanesBwd) * w) / 2;
}

/** Half the paved width of the whole road, both directions. */
function pavedHalfOf(e: WorkEdge) {
  return ((e.lanesFwd + e.lanesBwd) * laneWidthOf(e.src.cls)) / 2;
}

/** Direction over the first / last TANGENT_SPAN metres: robust to tiny kinks at OSM nodes. */
function chordTangent(line: Polyline, atStart: boolean): Vec2 {
  const span = Math.min(TANGENT_SPAN, line.length);
  const a = atStart ? pointAt(line, 0) : pointAt(line, line.length - span);
  const b = atStart ? pointAt(line, span) : pointAt(line, line.length);
  const d = sub(b, a);
  return Math.hypot(d.x, d.z) > 1e-6 ? norm(d) : atStart ? startTangent(line) : endTangent(line);
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

/**
 * (in, out) lane pairs where a road enters or leaves a big ring: the lanes keep their order from the
 * outer kerb (entries merge into the outer lanes, exits leave from them); null for any other move.
 */
function ringLaneMoves(inRing: boolean, outRing: boolean, nIn: number, nOut: number): [number, number][] | null {
  if (inRing === outRing) return null;
  if (!inRing) return Array.from({ length: nIn }, (_, i) => [i, Math.max(0, i + nOut - nIn)]);
  return Array.from({ length: nOut }, (_, j) => [Math.max(0, j + nIn - nOut), j]);
}

/** Connector round the island of a small ring, held to the speed of its curve; null when the ends lie too close round it. */
function connectRound(city: City, node: CityNode, inLane: Lane, outLane: Lane, turn: Turn, sIn: Segment, sOut: Segment, ring: Ring): Connector | null {
  const points = aroundIsland(ring, inLane.end, endTangent(inLane.line), outLane.start, startTangent(outLane.line));
  if (!points) return null;
  const vmax = Math.max(3.5, Math.min(sIn.speed, sOut.speed, Math.sqrt(2.4 * ring.radius)));
  return addConnector(city, node, inLane, outLane, turn, sIn, polyline(points), vmax);
}

/**
 * Track curve along the OSM course: the rest of the incoming track past its lane, the course through
 * the junction and the outgoing track up to its lane. The speed is held to the tightest bend.
 */
function connectTrack(city: City, node: CityNode, inLane: Lane, outLane: Lane, turn: Turn, sIn: Segment, sOut: Segment, [baseIn, course, baseOut]: [Polyline, Vec2[], Polyline]): Connector {
  const tail = slice(baseIn, projectOnPolyline(baseIn, inLane.end), baseIn.length).points;
  const head = slice(baseOut, 0, projectOnPolyline(baseOut, outLane.start)).points;
  const points = [inLane.end, ...tail, ...course, ...head, outLane.start].filter((p, i, all) => i === 0 || dist(p, all[i - 1]!) > 0.05);
  const line = polyline(points.length > 1 ? points : [inLane.end, outLane.start]);
  // Bend radius through points 3 m apart along the curve.
  let r = Infinity;
  for (let s = 3; s + 3 <= line.length; s += 1) {
    const [a, b, c] = [poseAlong(line, s - 3), poseAlong(line, s), poseAlong(line, s + 3)];
    const area2 = Math.abs(cross(sub(b, a), sub(c, a)));
    if (area2 > 1e-6) r = Math.min(r, (dist(a, b) * dist(b, c) * dist(a, c)) / (2 * area2));
  }
  const vmax = Math.max(3.5, Math.min(sIn.speed, sOut.speed, Math.sqrt(2.4 * r)));
  return addConnector(city, node, inLane, outLane, turn, sIn, line, vmax);
}

function addConnector(city: City, node: CityNode, inLane: Lane, outLane: Lane, turn: Turn, sIn: Segment, line: Polyline, vmax: number): Connector {
  const conn: Connector = { id: city.connectors.length, node: node.id, from: inLane.id, to: outLane.id, turn, phase: sIn.phase, line, vmax, conflicts: [] };
  city.connectors.push(conn);
  inLane.out.push(conn.id);
  outLane.in.push(conn.id);
  return conn;
}

function connect(city: City, node: CityNode, inLane: Lane, outLane: Lane, turn: Turn, sIn: Segment, sOut: Segment): Connector {
  const p0 = inLane.end;
  const p1 = outLane.start;
  const d0 = endTangent(inLane.line);
  const d1 = startTangent(outLane.line);
  const chord = dist(p0, p1);
  let points: Vec2[];
  let vmax = Math.min(sIn.speed, sOut.speed);
  const lateral = Math.abs(cross(d0, sub(p1, p0)));
  const k = chord / 3;
  if (Math.abs(cross(d0, d1)) < 0.17 && dot(d0, d1) > 0) {
    // Straight on, or an S-bend across to an offset lane (a taper, a lane that starts aside).
    if (lateral < 0.2 || chord < 0.5) points = [p0, p1];
    else {
      points = cubicBezier(p0, add(p0, scale(d0, k)), sub(p1, scale(d1, k)), p1, 10);
      vmax = Math.max(3.5, Math.min(vmax, Math.sqrt((2.4 * chord * chord) / (4 * lateral))));
    }
  } else {
    const c = lineIntersection(p0, d0, p1, d1);
    if (c && dot(sub(c, p0), d0) > 0 && dot(sub(p1, c), d1) > 0 && dist(c, p0) <= 3 * chord) {
      points = quadBezier(p0, c, p1, 10);
      const r = Math.max(1, Math.min(dist(c, p0), dist(c, p1)));
      vmax = Math.max(3.5, Math.min(vmax, Math.sqrt(2.4 * r)));
    } else {
      // The lanes' lines do not meet ahead of both ends: leave and join each lane along it.
      points = cubicBezier(p0, add(p0, scale(d0, k)), sub(p1, scale(d1, k)), p1, 10);
      vmax = Math.max(3.5, Math.min(vmax, Math.sqrt(2.4 * Math.max(1, chord / 2))));
    }
  }
  return addConnector(city, node, inLane, outLane, turn, sIn, polyline(points), vmax);
}
