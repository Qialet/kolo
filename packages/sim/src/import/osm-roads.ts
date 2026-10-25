import type { DistrictRoads, RoadClass, RoadEdge, RoadNode, TurnRestriction } from '../city/district.js';
import { pointInRect, type Rect, type Vec2 } from '../geometry.js';
import { largestStronglyConnected } from '../graph.js';
import { clipRuns, type RunPoint } from './clip.js';
import { pathsOf } from './osm-paths.js';
import { project, type BBoxDeg } from './project.js';
import { toLatin } from './translit.js';

/** Overpass JSON element. */
export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  members?: { type: 'node' | 'way' | 'relation'; ref: number; role: string }[];
  tags?: Record<string, string>;
}

type Tags = Record<string, string>;

const CLASSES = new Set<string>(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'busway']);
const LINKS = new Set(['trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const DEFAULT_KMH: Record<RoadClass, number> = {
  trunk: 60,
  primary: 50,
  secondary: 50,
  tertiary: 50,
  unclassified: 50,
  residential: 40,
  living_street: 10,
  busway: 50,
  tram: 40,
};
const ZONE_KMH: Record<string, number> = { 'RS:urban': 50, 'RS:living_street': 10, 'RS:rural': 80, 'RS:motorway': 130 };
const YES = new Set(['yes', 'true', '1']);
const MAX_LANES = 5;
/** Crossing tags meaning no paint on the road. */
const UNMARKED = new Set(['no', 'unmarked', 'informal']);

export function boundsOfBBox(b: BBoxDeg): Rect {
  const nw = project({ lat: b.n, lon: b.w });
  const se = project({ lat: b.s, lon: b.e });
  return { x0: nw.x, z0: nw.z, x1: se.x, z1: se.z };
}

interface WayInfo {
  id: number;
  nodes: number[];
  edge: Omit<RoadEdge, 'id' | 'a' | 'b' | 'pts'>;
}

/** A one-way tram track in service (yards and sidings are left out; two-way single track is not modelled). */
function trackInfo(id: number, nodes: number[], t: Tags): WayInfo | null {
  if (t.railway !== 'tram' || t.service || !YES.has(t.oneway ?? '')) return null;
  const edge: WayInfo['edge'] = {
    name: '',
    cls: 'tram',
    lanesFwd: 1,
    lanesBwd: 0,
    speed: Math.round(((speedKmh(t.maxspeed) ?? DEFAULT_KMH.tram) / 3.6) * 100) / 100,
    layer: int(t.layer) ?? 0,
    psvOnly: true,
    osm: id,
  };
  if (t.tunnel === 'yes') edge.tunnel = true;
  if (t.bridge && t.bridge !== 'no') edge.bridge = true;
  return { id, nodes, edge };
}

/** Road class of a street way (links count as their road), whether cars may use it or not. */
function streetClass(t: Tags): RoadClass | null {
  const cls = LINKS.has(t.highway ?? '') ? t.highway!.replace('_link', '') : t.highway;
  return cls && CLASSES.has(cls) ? (cls as RoadClass) : null;
}

/** Road attributes of a drivable OSM way, or null when cars and buses cannot use it. */
function wayInfo(id: number, nodes: number[], t: Tags): WayInfo | null {
  if (t.railway === 'tram') return trackInfo(id, nodes, t);
  if (!t.highway || t.area === 'yes') return null;
  const cls = streetClass(t);
  if (!cls) return null;
  const link = LINKS.has(t.highway);
  const restricted = ['no', 'private'].includes(t.motor_vehicle ?? t.motorcar ?? t.access ?? '');
  const psv = ['yes', 'designated'].includes(t.psv ?? t.bus ?? '');
  if (restricted && !psv) return null;
  const psvOnly = cls === 'busway' || restricted;

  const roundabout = t.junction === 'roundabout' || t.junction === 'circular';
  const reverse = t.oneway === '-1';
  const oneway = reverse || roundabout || YES.has(t.oneway ?? '');
  const lanes = int(t.lanes);
  const lf = int(t['lanes:forward']);
  const lb = int(t['lanes:backward']);
  let fwd: number;
  let bwd: number;
  if (oneway) {
    fwd = lanes ?? lf ?? (cls === 'trunk' ? 2 : 1);
    bwd = 0;
  } else if (lf && lb) {
    fwd = lf;
    bwd = lb;
  } else if (lanes && lanes > 1) {
    fwd = lf ?? (lb ? lanes - lb : Math.ceil(lanes / 2));
    bwd = lb ?? lanes - fwd;
  } else {
    fwd = 1;
    bwd = 1;
  }
  const clampLanes = (n: number, min: number) => Math.max(min, Math.min(MAX_LANES, n));
  const kmh = speedKmh(t.maxspeed) ?? DEFAULT_KMH[cls];
  const edge: WayInfo['edge'] = {
    name: t['name:sr-Latn'] ?? toLatin(t.name ?? ''),
    cls,
    lanesFwd: clampLanes(fwd, 1),
    lanesBwd: oneway ? 0 : clampLanes(bwd, 1),
    speed: Math.round((kmh / 3.6) * 100) / 100,
    layer: int(t.layer) ?? 0,
    osm: id,
  };
  if (link) edge.link = true;
  if (t.tunnel === 'yes') edge.tunnel = true;
  if (t.bridge && t.bridge !== 'no') edge.bridge = true;
  if (roundabout) edge.roundabout = true;
  if (psvOnly) edge.psvOnly = true;
  if ([t.trolley_wire, t['trolley_wire:forward'], t['trolley_wire:backward']].includes('yes')) edge.trolley = true;
  const turnFwd = oneway ? (t['turn:lanes'] ?? t['turn:lanes:forward']) : t['turn:lanes:forward'];
  if (turnFwd) edge.turnFwd = turnFwd;
  if (!oneway && t['turn:lanes:backward']) edge.turnBwd = t['turn:lanes:backward'];
  return { id, nodes: reverse ? [...nodes].reverse() : nodes, edge };
}

function int(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function speedKmh(v: string | undefined): number | undefined {
  if (!v) return undefined;
  if (v in ZONE_KMH) return ZONE_KMH[v];
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Builds the drivable road graph of a district from raw OSM elements. */
export function importRoads(elements: OsmElement[], bbox: BBoxDeg): DistrictRoads {
  const bounds = boundsOfBBox(bbox);
  const osmNodes = new Map<number, OsmElement>();
  // Overpass may list a node twice (tagged, then as an untagged skeleton): keep the tagged copy.
  for (const e of elements) if (e.type === 'node' && (e.tags || !osmNodes.has(e.id))) osmNodes.set(e.id, e);

  const ways: WayInfo[] = [];
  for (const e of elements) {
    if (e.type !== 'way' || !e.nodes || !e.tags) continue;
    if (e.nodes.some((id) => !osmNodes.has(id))) continue;
    const info = wayInfo(e.id, e.nodes, e.tags);
    if (info) ways.push(info);
  }

  // Graph nodes: way ends, nodes shared by several ways, and traffic-control nodes.
  const uses = new Map<number, number>();
  for (const w of ways) {
    w.nodes.forEach((id, i) => uses.set(id, (uses.get(id) ?? 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1)));
  }
  const isControl = (id: number) => ['traffic_signals', 'stop', 'give_way'].includes(osmNodes.get(id)?.tags?.highway ?? '');
  const isSplit = (id: number) => (uses.get(id) ?? 0) >= 2 || isControl(id);

  const xy = new Map<number, Vec2>();
  const pos = (id: number) => {
    let p = xy.get(id);
    if (!p) {
      const n = osmNodes.get(id)!;
      p = project({ lat: n.lat!, lon: n.lon! });
      xy.set(id, p);
    }
    return p;
  };

  // A give way or stop sign with direction=forward / backward faces traffic travelling along / against its way.
  const signDir = new Map<number, Vec2>();
  for (const w of ways) {
    w.nodes.forEach((id, i) => {
      const tags = osmNodes.get(id)?.tags;
      const sense = tags?.direction === 'forward' ? 1 : tags?.direction === 'backward' ? -1 : 0;
      if (!sense || !isControl(id) || tags?.highway === 'traffic_signals' || signDir.has(id)) return;
      const p = pos(w.nodes[Math.max(0, i - 1)]!);
      const q = pos(w.nodes[Math.min(w.nodes.length - 1, i + 1)]!);
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      if (len > 0) signDir.set(id, { x: (sense * (q.x - p.x)) / len, z: (sense * (q.z - p.z)) / len });
    });
  }

  interface RawEdge {
    info: WayInfo;
    pts: RunPoint[];
  }
  const raw: RawEdge[] = [];
  for (const w of ways) {
    let piece: number[] = [w.nodes[0]!];
    for (let i = 1; i < w.nodes.length; i++) {
      const id = w.nodes[i]!;
      piece.push(id);
      if (i === w.nodes.length - 1 || isSplit(id)) {
        const points = piece.map((n, k) => ({ ...pos(n), key: k === 0 || k === piece.length - 1 ? `n${n}` : null }));
        for (const run of clipRuns(points, bounds)) raw.push({ info: w, pts: run });
        piece = [id];
      }
    }
  }

  // Assign node ids to run ends.
  const nodeByKey = new Map<string, RoadNode>();
  const nodeOf = (p: RunPoint): RoadNode => {
    const key = p.key ?? `b${Math.round(p.x * 10)},${Math.round(p.z * 10)}`;
    let n = nodeByKey.get(key);
    if (!n) {
      const osmId = key.startsWith('n') ? Number(key.slice(1)) : 0;
      n = { id: nodeByKey.size, x: round1(p.x), z: round1(p.z), osm: osmId };
      const hw = osmNodes.get(osmId)?.tags?.highway;
      if (hw === 'traffic_signals') n.signals = true;
      if (hw === 'give_way') n.giveWay = true;
      if (hw === 'stop') n.stop = true;
      if (hw === 'stop' && osmNodes.get(osmId)?.tags?.stop === 'all') n.stopAll = true;
      const dir = signDir.get(osmId);
      if (dir) n.signDir = [round2(dir.x), round2(dir.z)];
      if (!key.startsWith('n')) n.boundary = true;
      nodeByKey.set(key, n);
    }
    return n;
  };
  let edges: RoadEdge[] = [];
  for (const r of raw) {
    let length = 0;
    for (let i = 1; i < r.pts.length; i++) length += Math.hypot(r.pts[i]!.x - r.pts[i - 1]!.x, r.pts[i]!.z - r.pts[i - 1]!.z);
    if (length < 1) continue;
    const a = nodeOf(r.pts[0]!);
    const b = nodeOf(r.pts[r.pts.length - 1]!);
    if (a === b) continue;
    edges.push({ id: edges.length, a: a.id, b: b.id, pts: r.pts.flatMap((p) => [round1(p.x), round1(p.z)]), ...r.info.edge });
  }

  // Keep the largest strongly connected part for cars (the outside world is one extra node) and every tram track.
  const nodes = [...nodeByKey.values()];
  const keep = largestScc(nodes, edges);
  const inGraph = (e: RoadEdge) => e.cls === 'tram' || (keep.has(e.a) && keep.has(e.b));
  const dropped = edges.filter((e) => !inGraph(e));
  edges = edges.filter(inGraph);
  const used = new Set(edges.flatMap((e) => [e.a, e.b]));
  const kept = nodes.filter((n) => used.has(n.id));
  const newId = new Map(kept.map((n, i) => [n.id, i]));
  for (const n of kept) n.id = newId.get(n.id)!;
  edges.forEach((e, i) => {
    e.id = i;
    e.a = newId.get(e.a)!;
    e.b = newId.get(e.b)!;
  });

  return {
    nodes: kept,
    edges,
    restrictions: restrictionsOf(elements, kept, edges),
    crossings: crossingsOf(ways, edges, osmNodes, pos, bounds),
    scenery: sceneryTracks(elements, osmNodes, pos, bounds),
    paths: pathsOf(
      elements,
      osmNodes,
      pos,
      bounds,
      edges.filter((e) => e.cls !== 'tram'),
      dropped,
      new Set(ways.map((w) => w.id)),
      streetClass,
    ),
  };
}

/** Tracks at ground level or above that no tram runs on in the model: tram yards, sidings, two-way track and the railway. */
function sceneryTracks(elements: OsmElement[], osmNodes: Map<number, OsmElement>, pos: (id: number) => Vec2, bounds: Rect): number[][] {
  const out: number[][] = [];
  for (const e of elements) {
    const t = e.tags;
    if (e.type !== 'way' || !e.nodes || !t || t.tunnel === 'yes') continue;
    if (t.railway !== 'rail' && (t.railway !== 'tram' || trackInfo(e.id, e.nodes, t))) continue;
    if (e.nodes.some((id) => !osmNodes.has(id))) continue;
    for (const run of clipRuns(e.nodes.map((id) => ({ ...pos(id), key: null })), bounds)) out.push(run.flatMap((p) => [round1(p.x), round1(p.z)]));
  }
  return out;
}

/** Marked pedestrian crossings on the streets kept (tracks left out), inside the frame: x, z pairs. */
function crossingsOf(ways: WayInfo[], edges: RoadEdge[], osmNodes: Map<number, OsmElement>, pos: (id: number) => Vec2, bounds: Rect): number[] {
  const kept = new Set(edges.filter((e) => e.cls !== 'tram').map((e) => e.osm));
  const seen = new Set<number>();
  const out: number[] = [];
  for (const w of ways) {
    if (!kept.has(w.id)) continue;
    for (const id of w.nodes) {
      const t = osmNodes.get(id)?.tags;
      if (!t || seen.has(id)) continue;
      const crossing = t.highway === 'crossing' || (t.highway === 'traffic_signals' && !!t.crossing);
      if (!crossing || UNMARKED.has(t.crossing ?? '') || t['crossing:markings'] === 'no') continue;
      const p = pos(id);
      if (!pointInRect(p, bounds)) continue;
      seen.add(id);
      out.push(round1(p.x), round1(p.z));
    }
  }
  return out;
}

const round1 = (v: number) => Math.round(v * 10) / 10 + 0;
const round2 = (v: number) => Math.round(v * 100) / 100 + 0;

function largestScc(nodes: RoadNode[], edges: RoadEdge[]): Set<number> {
  const outside = nodes.reduce((m, n) => Math.max(m, n.id), -1) + 1;
  const n = outside + 1;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    if (e.psvOnly) continue;
    if (e.lanesFwd > 0) adj[e.a]!.push(e.b);
    if (e.lanesBwd > 0) adj[e.b]!.push(e.a);
  }
  for (const node of nodes) {
    if (!node.boundary) continue;
    adj[node.id]!.push(outside);
    adj[outside]!.push(node.id);
  }
  return new Set(largestStronglyConnected(adj).filter((id) => id !== outside));
}

function restrictionsOf(elements: OsmElement[], nodes: RoadNode[], edges: RoadEdge[]): TurnRestriction[] {
  const byOsmNode = new Map(nodes.filter((n) => n.osm).map((n) => [n.osm, n.id]));
  const out: TurnRestriction[] = [];
  for (const rel of elements) {
    if (rel.type !== 'relation' || rel.tags?.type !== 'restriction' || !rel.members) continue;
    const kind = rel.tags.restriction ?? rel.tags['restriction:motorcar'];
    if (!kind || (!kind.startsWith('no_') && !kind.startsWith('only_'))) continue;
    const from = rel.members.filter((m) => m.role === 'from' && m.type === 'way');
    const via = rel.members.filter((m) => m.role === 'via');
    const to = rel.members.filter((m) => m.role === 'to' && m.type === 'way');
    if (from.length !== 1 || to.length !== 1 || via.length !== 1 || via[0]!.type !== 'node') continue;
    const viaId = byOsmNode.get(via[0]!.ref);
    if (viaId === undefined) continue;
    const touching = (wayId: number) => edges.filter((e) => e.osm === wayId && (e.a === viaId || e.b === viaId));
    const f = touching(from[0]!.ref);
    const t = touching(to[0]!.ref);
    if (f.length !== 1 || t.length !== 1) continue;
    out.push({ from: f[0]!.id, via: viaId, to: t[0]!.id, only: kind.startsWith('only_') });
  }
  return out;
}
