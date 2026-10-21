import type { DistrictRoads, RoadClass, RoadEdge, RoadNode, TurnRestriction } from '../city/district.js';
import type { Rect, Vec2 } from '../geometry.js';
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
};
const ZONE_KMH: Record<string, number> = { 'RS:urban': 50, 'RS:living_street': 10, 'RS:rural': 80, 'RS:motorway': 130 };
const YES = new Set(['yes', 'true', '1']);
const MAX_LANES = 5;

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

/** Road attributes of a drivable OSM way, or null when cars and buses cannot use it. */
function wayInfo(id: number, nodes: number[], t: Tags): WayInfo | null {
  if (!t.highway || t.area === 'yes') return null;
  const link = LINKS.has(t.highway);
  const cls = (link ? t.highway.replace('_link', '') : t.highway) as RoadClass;
  if (!CLASSES.has(cls)) return null;
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

interface RunPoint extends Vec2 {
  /** Graph node key when this point is a node of the graph (an OSM split node or a frame cut). */
  key: string | null;
}

/**
 * Parts of a polyline inside the rectangle (Liang–Barsky per piece). Cut points get a boundary key;
 * original points keep the key supplied by `keyOf`.
 */
function clipRuns(points: (Vec2 & { key: string | null })[], r: Rect): RunPoint[][] {
  const runs: RunPoint[][] = [];
  let run: RunPoint[] | null = null;
  const cut = (p: Vec2): RunPoint => ({ x: p.x, z: p.z, key: `b${Math.round(p.x * 10)},${Math.round(p.z * 10)}` });
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!;
    const q = points[i]!;
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    let t0 = 0;
    let t1 = 1;
    let empty = false;
    for (const [den, num] of [
      [-dx, p.x - r.x0],
      [dx, r.x1 - p.x],
      [-dz, p.z - r.z0],
      [dz, r.z1 - p.z],
    ] as const) {
      if (den === 0) {
        if (num < 0) empty = true;
        continue;
      }
      const t = num / den;
      if (den < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (empty || t0 > t1) {
      run = null;
      continue;
    }
    if (t0 > 0 || !run) {
      run = [t0 > 0 ? cut({ x: p.x + dx * t0, z: p.z + dz * t0 }) : { ...p }];
      runs.push(run);
    }
    if (t1 < 1) {
      run.push(cut({ x: p.x + dx * t1, z: p.z + dz * t1 }));
      run = null;
    } else run.push({ ...q });
  }
  // Runs were pushed when opened; drop degenerate ones.
  return runs.filter((r2) => r2.length > 1);
}

/** Builds the drivable road graph of a district from raw OSM elements. */
export function importRoads(elements: OsmElement[], bbox: BBoxDeg): DistrictRoads {
  const bounds = boundsOfBBox(bbox);
  const osmNodes = new Map<number, OsmElement>();
  for (const e of elements) if (e.type === 'node') osmNodes.set(e.id, e);

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

  // Keep the largest strongly connected part for cars; the outside world is one extra node.
  const nodes = [...nodeByKey.values()];
  const keep = largestScc(nodes, edges);
  edges = edges.filter((e) => keep.has(e.a) && keep.has(e.b));
  const used = new Set(edges.flatMap((e) => [e.a, e.b]));
  const kept = nodes.filter((n) => used.has(n.id));
  const newId = new Map(kept.map((n, i) => [n.id, i]));
  for (const n of kept) n.id = newId.get(n.id)!;
  edges.forEach((e, i) => {
    e.id = i;
    e.a = newId.get(e.a)!;
    e.b = newId.get(e.b)!;
  });

  return { nodes: kept, edges, restrictions: restrictionsOf(elements, kept, edges) };
}

const round1 = (v: number) => Math.round(v * 10) / 10 + 0;

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
  // Iterative Tarjan.
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  let counter = 0;
  let best: number[] = [];
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work: [number, number][] = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = 1;
    while (work.length) {
      const top = work[work.length - 1]!;
      const [v, i] = top;
      if (i < adj[v]!.length) {
        top[1]++;
        const w = adj[v]![i]!;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1]![0];
        low[parent] = Math.min(low[parent]!, low[v]!);
      }
      if (low[v] === index[v]) {
        const comp: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          comp.push(w);
        } while (w !== v);
        if (comp.length > best.length) best = comp;
      }
    }
  }
  return new Set(best.filter((id) => id !== outside));
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
