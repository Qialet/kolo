import { add, cubicBezier, dist, dot, lineIntersection, norm, polyline, poseAlong, projectOnPolyline, quadBezier, rightOf, scale, sub, type Polyline, type Vec2 } from '../geometry.js';
import { segmentDistance } from '../import/polygons.js';
import { segmentY } from './decks.js';
import { SegmentGrid } from './places.js';
import type { City, CityNode, Crossing, JunctionPad, RoadStrip } from './types.js';

/** Length over which a mouth's outward direction is measured: robust to tiny kinks at the cut. */
const MOUTH_SPAN = 5;
/** A kerb return turns round the kerbs' corner unless the corner lies this many times further off than the two kerbs are apart (nearly parallel kerbs). */
const FILLET_REACH = 3;
const FILLET_STEPS = 8;
/** Length of a zebra's stripes along the road, and its clearance from the junction pad. */
const ZEBRA_DEPTH = 2.8;
const ZEBRA_CLEAR = 0.6;
/** A crossing this far off a road's axis beyond its paved width belongs to no road. */
const CROSSING_REACH = 2;
/** Crossings of one road closer than this are one zebra (OSM maps some on both carriageway edges). */
const CROSSING_MERGE = 4;

/** One road between junctions, as the surface sees it: its centre line and paved width on each side. */
export interface SurfaceRoad {
  /** The segment whose centre line `base` is: its deck heights lift the strip. */
  seg: number;
  /** Centre line from the `from` node to the `to` node. */
  base: Polyline;
  from: CityNode;
  to: CityNode;
  /** Metres to the left / right of the centre line in its point order. */
  left: number;
  right: number;
  layer: number;
  /** Arc lengths along the base where the lanes meet the `from` / `to` junction: the ends of those running in, else the starts of those leaving. */
  stopFrom: number;
  stopTo: number;
  /** Distance from the `from` / `to` junction's centre at which the strip ends (where that junction gets a pad). */
  cutFrom: number;
  cutTo: number;
}

/** Where a road meets its junction pad: the cut across the asphalt, looking out of the junction. */
interface Mouth {
  at: Vec2;
  /** Where the left / right kerb enters the junction circle: the kerb returns start there, by the lane ends (null: at the mouth's corner). */
  innerLeft: Vec2 | null;
  innerRight: Vec2 | null;
  /** Unit direction from the junction into the road. */
  out: Vec2;
  /** Paved width to the left / right when looking out along `out`. */
  left: number;
  right: number;
  layer: number;
}

/**
 * Asphalt of the road network: every road is a strip cut where its junction pad takes over, and
 * every junction a pad joining the mouths of its roads by kerb returns. Nodes in `padded` get a pad;
 * roads end at the junction circle there and run on to the node elsewhere. A strip on a bridge deck
 * takes its heights from `deckY` along its segment.
 */
export function laySurface(city: City, roads: SurfaceRoad[], padded: (node: CityNode) => boolean, deckY: (seg: number, s: number) => number = (seg, s) => segmentY(city, seg, s)) {
  const mouths = new Map<number, Mouth[]>();
  const addMouth = (node: CityNode, m: Mouth) => {
    const list = mouths.get(node.id) ?? [];
    list.push(m);
    mouths.set(node.id, list);
  };
  const strips: RoadStrip[] = [];
  /** Span of every road's base that its strip covers. */
  const spans: [number, number][] = [];
  for (const r of roads) {
    const r0 = padded(r.from) ? r.cutFrom : 0;
    const r1 = padded(r.to) ? r.cutTo : 0;
    const from = { ...r.from, radius: r0 };
    const to = { ...r.to, radius: r1 };
    const line = trimToJunctions(r.base, from, to);
    const strip: RoadStrip = { points: line.points, left: r.left, right: r.right, layer: r.layer };
    if (city.segments[r.seg]!.y) strip.y = line.points.map((p) => Math.round(deckY(r.seg, projectOnPolyline(r.base, p)) * 100) / 100);
    strips.push(strip);
    spans.push([projectOnPolyline(r.base, line.points[0]!), projectOnPolyline(r.base, line.points[line.points.length - 1]!)]);
    const kerbL = polyline(offsetPoints(r.base.points, -r.left));
    const kerbR = polyline(offsetPoints(r.base.points, r.right));
    const enter = (kerb: Polyline, atStart: boolean) => {
      const node = atStart ? from : to;
      // A kerb further out than the circle (a wide ring through a small cut) never enters it: the mouth is cut square there.
      if (dist(pointAt(kerb, atStart ? 0 : kerb.length), node) >= node.radius) return null;
      const s = exitArc(kerb, node, node.radius, atStart);
      return pointAt(kerb, atStart ? s : kerb.length - s);
    };
    const { layer } = r;
    if (r0 > 0) addMouth(r.from, { at: line.points[0]!, out: outward(line, true), left: r.left, right: r.right, innerLeft: enter(kerbL, true), innerRight: enter(kerbR, true), layer });
    if (r1 > 0) {
      const end = line.points[line.points.length - 1]!;
      addMouth(r.to, { at: end, out: outward(line, false), left: r.right, right: r.left, innerLeft: enter(kerbR, false), innerRight: enter(kerbL, false), layer });
    }
  }
  const pads: JunctionPad[] = [];
  for (const [id, list] of mouths) {
    if (list.length < 2 || list.every((m) => m.layer < 0)) continue;
    const pad: JunctionPad = { node: id, outline: padOutline(city.nodes[id]!, list), layer: Math.max(...list.map((m) => m.layer)) };
    if (city.nodes[id]!.y) pad.y = city.nodes[id]!.y;
    pads.push(pad);
  }
  return { strips, pads, spans };
}

/**
 * Zebras at the marked crossings (x, z pairs) of streets at ground level, across the nearest road.
 * A crossing at a junction mouth lies just inside the junction past where the lanes meet it, so
 * vehicles stop before it; one along the road stays put.
 */
export function placeCrossings(points: number[], roads: SurfaceRoad[], spans: [number, number][]): Crossing[] {
  const grid = new SegmentGrid<number>();
  roads.forEach((r, i) => {
    if (r.layer !== 0) return;
    const p = r.base.points;
    for (let k = 1; k < p.length; k++) grid.add(p[k - 1]!, p[k]!, i);
  });
  const placed: { road: number; s: number }[] = [];
  const out: Crossing[] = [];
  for (let k = 0; k < points.length; k += 2) {
    const p = { x: points[k]!, z: points[k + 1]! };
    let road = -1;
    let gap = Infinity;
    for (const { a, b, item } of grid.near(p, 30)) {
      const r = roads[item]!;
      const d = segmentDistance(p, a, b) - Math.max(r.left, r.right);
      if (d < gap) [gap, road] = [d, item];
    }
    if (road < 0 || gap > CROSSING_REACH) continue;
    const r = roads[road]!;
    const [s0, s1] = spans[road]!;
    const edge = ZEBRA_DEPTH / 2 + ZEBRA_CLEAR;
    if (s1 - s0 < 2 * edge) continue;
    const at = projectOnPolyline(r.base, p);
    // Within a zebra's reach of the strip's ends it belongs to the junction.
    const s = at < s0 + 2 * edge ? r.stopFrom - edge : at > s1 - 2 * edge ? r.stopTo + edge : at;
    if (placed.some((q) => q.road === road && Math.abs(q.s - s) < CROSSING_MERGE)) continue;
    placed.push({ road, s });
    const pose = poseAlong(r.base, s);
    out.push({ x: pose.x, z: pose.z, heading: pose.heading, left: r.left, right: r.right });
  }
  return out;
}

/** Direction from the junction into the road at the start (or end) of a cut line. */
function outward(line: Polyline, atStart: boolean): Vec2 {
  const span = Math.min(MOUTH_SPAN, line.length);
  const a = atStart ? pointAt(line, 0) : pointAt(line, line.length);
  const b = atStart ? pointAt(line, span) : pointAt(line, line.length - span);
  return norm(sub(b, a));
}

/**
 * Pad outline: the mouths in turning order around the junction, the kerbs of each running in to the
 * junction circle, and each kerb joined to the next mouth's by a kerb return (a curve inside the
 * corner the two kerb lines make); where the kerbs never meet in front of the mouths (opposite
 * roads, a narrowing, the outside of a bend) the return leaves and joins them along their own lines.
 */
function padOutline(centre: Vec2, mouths: Mouth[]): Vec2[] {
  const legs = mouths
    .map((m) => {
      const side = rightOf(m.out);
      const left = sub(m.at, scale(side, m.left));
      const right = add(m.at, scale(side, m.right));
      const innerLeft = m.innerLeft ?? left;
      const innerRight = m.innerRight ?? right;
      // Turning order by where the mouth lies (the two carriageways of a road point the same way).
      // rightOf turns the way atan2(z, x) grows: the left corner comes first in turning order.
      const corners = [...(m.innerLeft ? [m.innerLeft] : []), left, right, ...(m.innerRight ? [m.innerRight] : [])];
      return { m, innerLeft, innerRight, angle: Math.atan2(m.at.z - centre.z, m.at.x - centre.x), corners };
    })
    .sort((a, b) => a.angle - b.angle);
  const out: Vec2[] = [];
  legs.forEach((leg, i) => {
    const next = legs[(i + 1) % legs.length]!;
    out.push(...leg.corners);
    const a = leg.innerRight;
    const b = next.innerLeft;
    const c = lineIntersection(a, leg.m.out, b, next.m.out);
    if (c && dot(sub(c, a), leg.m.out) < 0 && dot(sub(c, b), next.m.out) < 0 && dist(c, a) + dist(c, b) < FILLET_REACH * dist(a, b) + 10) {
      out.push(...quadBezier(a, c, b, FILLET_STEPS).slice(1, -1));
    } else {
      const k = dist(a, b) / 3;
      out.push(...cubicBezier(a, sub(a, scale(leg.m.out, k)), add(b, scale(next.m.out, k)), b, FILLET_STEPS).slice(1, -1));
    }
  });
  return out;
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

/** Point at arc length s (clamped to the line). */
export function pointAt(line: Polyline, s: number): Vec2 {
  const { points, cum } = line;
  let i = 1;
  while (i < points.length - 1 && cum[i]! < s) i++;
  const a = points[i - 1]!;
  const b = points[i]!;
  const len = cum[i]! - cum[i - 1]! || 1;
  const t = Math.max(0, Math.min(1, (s - cum[i - 1]!) / len));
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/** Cuts a line where it leaves the start junction's circle and enters the end junction's. */
export function trimToJunctions(line: Polyline, from: Vec2 & { radius: number }, to: Vec2 & { radius: number }): Polyline {
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

/** The part of a line between arc lengths s0 and s1. */
export function slice(line: Polyline, s0: number, s1: number): Polyline {
  const pts: Vec2[] = [pointAt(line, s0)];
  for (let i = 1; i < line.points.length - 1; i++) if (line.cum[i]! > s0 + 0.05 && line.cum[i]! < s1 - 0.05) pts.push(line.points[i]!);
  pts.push(pointAt(line, s1));
  return polyline(pts);
}
