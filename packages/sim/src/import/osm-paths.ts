import type { DistrictPath, PathKind, RoadClass, RoadEdge } from '../city/district.js';
import { SegmentGrid } from '../city/places.js';
import { dist, dot, type Rect, type Vec2 } from '../geometry.js';
import { clipRuns } from './clip.js';
import type { OsmElement } from './osm-roads.js';
import { segmentDistance } from './polygons.js';

type Tags = Record<string, string>;

const FOOT_WIDTH: Record<string, number> = { footway: 2, path: 1.6, cycleway: 2.5, steps: 2, bridleway: 2 };
const SERVICE_WIDTH: Record<string, number> = { driveway: 3, alley: 3, 'drive-through': 3, emergency_access: 3, parking_aisle: 5 };
const SERVICE_DEFAULT = 4;
const PEDESTRIAN_DEFAULT = 6;
/** Footways that are part of a street: its sidewalks, the crossings over it and the islands in it. */
const STREET_FOOTWAY = new Set(['sidewalk', 'crossing', 'traffic_island', 'access_aisle']);
/** A footway piece within this distance beyond a street's paved half width, running along it, is an untagged sidewalk. */
const ALONG_REACH = 4;
const ALONG_COS = Math.cos((25 * Math.PI) / 180);
/** Footways are tested against the streets in pieces of at most this length. */
const PIECE = 5;
/** Shorter leftovers are dropped. */
const MIN_RUN = 3;

/** Lane width by road class, as the city lays the lanes (laneWidthOf). */
const laneWidth = (cls: RoadClass) => (cls === 'residential' || cls === 'living_street' ? 3.0 : 3.2);
const halfWidth = (e: RoadEdge) => ((e.lanesFwd + e.lanesBwd) * laneWidth(e.cls)) / 2;

/** Paved kind and width of a way drawn only, or null when it is not drawn (street ways are classified by the caller). */
function pathOf(t: Tags): { kind: PathKind; w: number } | null {
  if (hidden(t)) return null;
  const tagged = widthTag(t.width);
  if (t.highway === 'service') return { kind: 'service', w: tagged ?? SERVICE_WIDTH[t.service ?? ''] ?? SERVICE_DEFAULT };
  if (t.highway === 'pedestrian') return { kind: 'pedestrian', w: tagged ?? PEDESTRIAN_DEFAULT };
  const foot = FOOT_WIDTH[t.highway ?? ''];
  if (foot === undefined || STREET_FOOTWAY.has(t.footway ?? '') || STREET_FOOTWAY.has(t.cycleway ?? '')) return null;
  return { kind: 'footway', w: tagged ?? foot };
}

/** Areas, ways underground, under a roof or indoors: the ground does not show them. */
function hidden(t: Tags): boolean {
  return t.area === 'yes' || (!!t.tunnel && t.tunnel !== 'no') || t.covered === 'yes' || t.indoor === 'yes' || Number.parseInt(t.layer ?? '0', 10) < 0;
}

function widthTag(v: string | undefined): number | undefined {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) && n >= 1 && n <= 30 ? n : undefined;
}

/**
 * Paved ways no vehicle drives in the model, inside the frame: street pieces the graph left out (`dropped`),
 * street ways closed to cars, service roads, pedestrian streets and paths. Untagged sidewalks along the
 * `streets` are cut out of the paths.
 */
export function pathsOf(
  elements: OsmElement[],
  osmNodes: Map<number, OsmElement>,
  pos: (id: number) => Vec2,
  bounds: Rect,
  streets: RoadEdge[],
  dropped: RoadEdge[],
  graphWays: Set<number>,
  isStreet: (t: Tags) => RoadClass | null,
): DistrictPath[] {
  const out: DistrictPath[] = [];
  const push = (kind: PathKind, w: number, line: Vec2[]) => {
    const pts: number[] = [];
    for (const p of line) {
      const x = round1(p.x);
      const z = round1(p.z);
      if (pts.length && pts[pts.length - 2] === x && pts[pts.length - 1] === z) continue;
      pts.push(x, z);
    }
    if (pts.length >= 4 && length(line) >= MIN_RUN) out.push({ kind, w: round1(w), pts });
  };

  for (const e of dropped) {
    if (e.tunnel || e.layer < 0) continue;
    push('road', 2 * halfWidth(e), Array.from({ length: e.pts.length / 2 }, (_, i) => ({ x: e.pts[2 * i]!, z: e.pts[2 * i + 1]! })));
  }

  const grid = new SegmentGrid<number>();
  for (const e of streets) {
    for (let i = 2; i < e.pts.length; i += 2) grid.add({ x: e.pts[i - 2]!, z: e.pts[i - 1]! }, { x: e.pts[i]!, z: e.pts[i + 1]! }, halfWidth(e));
  }
  const alongStreet = (m: Vec2, d: Vec2) => {
    for (const { a, b, item: half } of grid.near(m, 8 + ALONG_REACH)) {
      const gap = segmentDistance(m, a, b);
      if (gap > half + ALONG_REACH) continue;
      // On the asphalt the street hides it anyway.
      if (gap < half) return true;
      const len = dist(a, b);
      if (len > 0 && Math.abs(dot(d, { x: (b.x - a.x) / len, z: (b.z - a.z) / len })) >= ALONG_COS) return true;
    }
    return false;
  };

  for (const el of elements) {
    const t = el.tags;
    if (el.type !== 'way' || !el.nodes || !t?.highway || graphWays.has(el.id)) continue;
    if (el.nodes.some((id) => !osmNodes.has(id))) continue;
    const cls = isStreet(t);
    let path: { kind: PathKind; w: number } | null;
    if (cls) {
      // A street closed to cars.
      const oneway = ['yes', '-1', 'true', '1'].includes(t.oneway ?? '') || t.junction === 'roundabout';
      path = hidden(t) ? null : { kind: 'road', w: (Number.parseInt(t.lanes ?? '', 10) || (oneway ? 1 : 2)) * laneWidth(cls) };
    } else path = pathOf(t);
    if (!path) continue;
    for (const run of clipRuns(el.nodes.map((id) => ({ ...pos(id), key: null })), bounds)) {
      if (path.kind !== 'footway') push(path.kind, path.w, run);
      else for (const part of offStreet(run, alongStreet)) push(path.kind, path.w, part);
    }
  }
  return out;
}

/** Parts of a path that do not run along a street. */
function offStreet(line: Vec2[], alongStreet: (m: Vec2, d: Vec2) => boolean): Vec2[][] {
  const out: Vec2[][] = [];
  let cur: Vec2[] = [];
  const flush = () => {
    if (cur.length > 1) out.push(cur);
    cur = [];
  };
  for (let i = 1; i < line.length; i++) {
    const p = line[i - 1]!;
    const q = line[i]!;
    const len = dist(p, q);
    if (len === 0) continue;
    const d = { x: (q.x - p.x) / len, z: (q.z - p.z) / len };
    const n = Math.ceil(len / PIECE);
    const at = (k: number) => ({ x: p.x + ((q.x - p.x) * k) / n, z: p.z + ((q.z - p.z) * k) / n });
    for (let k = 0; k < n; k++) {
      const a = at(k);
      const b = at(k + 1);
      if (alongStreet({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }, d)) {
        flush();
        continue;
      }
      if (!cur.length) cur.push(a);
      // `a` is an inner point of this piece of the line: the run goes straight on through it.
      else if (k > 0) cur.pop();
      cur.push(b);
    }
  }
  flush();
  return out;
}

function length(line: Vec2[]): number {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += dist(line[i - 1]!, line[i]!);
  return s;
}

const round1 = (v: number) => Math.round(v * 10) / 10 + 0;
