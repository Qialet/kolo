import { dist, poseAlong, type Vec2 } from '../geometry.js';
import { pointInPolygon, segmentDistance } from '../import/polygons.js';
import type { District } from './district.js';
import { roadSurface } from './places.js';
import type { City } from './types.js';

/** A defect found by the road audit: where it is and what it is. */
export interface RoadDefect {
  x: number;
  z: number;
  /** Size of the defect in the check's unit (degrees, metres or a count). */
  size: number;
  note: string;
}

export type RoadAudit = Record<RoadCheck, RoadDefect[]>;

export type RoadCheck =
  | 'stripSharpBends'
  | 'stripEndsOffJunction'
  | 'buildingsUnderPads'
  | 'stubLanes'
  | 'connectorKinks'
  | 'backwardConnectors'
  | 'longConnectors'
  | 'connectorsOffAsphalt'
  | 'railOffTrack'
  | 'railDeadEnds';

/** Bend of a road strip at one of its points, above which the mitred asphalt pinches or spikes. */
const SHARP_BEND = 60;
/** Strip end further than this beyond its junction circle: asphalt sticking out of a junction. */
const OFF_JUNCTION = 4;
/** Shortest street lane that still reads as a road piece. */
const STUB_LANE = 3;
/** Turn between a lane and its connector above which a vehicle visibly snaps. */
const KINK = 25;
const BACKWARD = 150;
const LONG_CONNECTOR = 45;
/** Furthest a track curve may stray from the OSM track it stands for. */
const RAIL_STRAY = 0.6;

const angleBetween = (u: Vec2, v: Vec2) => {
  const l = Math.hypot(u.x, u.z) * Math.hypot(v.x, v.z) || 1;
  return (Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.z * v.z) / l))) * 180) / Math.PI;
};
const dir = (a: Vec2, b: Vec2): Vec2 => ({ x: b.x - a.x, z: b.z - a.z });
const at = (p: Vec2, size: number, note: string): RoadDefect => ({ x: Math.round(p.x), z: Math.round(p.z), size: Math.round(size * 10) / 10, note });

/** Geometry checks of the road network as drawn and driven; every list is sorted worst first. */
export function auditRoads(city: City, district: District): RoadAudit {
  const street = (seg: number) => city.streets[city.segments[seg]!.street]!.name || '—';
  const rail = (lane: number) => !!city.segments[city.lanes[lane]!.seg]!.rail;
  const audit: RoadAudit = {
    stripSharpBends: [],
    stripEndsOffJunction: [],
    buildingsUnderPads: [],
    stubLanes: [],
    connectorKinks: [],
    backwardConnectors: [],
    longConnectors: [],
    connectorsOffAsphalt: [],
    railOffTrack: [],
    railDeadEnds: [],
  };

  for (const r of city.roads) {
    if (r.layer < 0) continue;
    const p = r.points;
    for (let i = 1; i < p.length - 1; i++) {
      const a = angleBetween(dir(p[i - 1]!, p[i]!), dir(p[i]!, p[i + 1]!));
      if (a > SHARP_BEND) audit.stripSharpBends.push(at(p[i]!, a, `bend, ${(r.left + r.right).toFixed(1)} m wide`));
    }
    for (const end of [p[0]!, p[p.length - 1]!]) {
      // The junction whose circle the end lies nearest to (a big junction may sit next to a small one).
      let best = city.nodes[0]!;
      for (const n of city.nodes) if (dist(n, end) - n.radius < dist(best, end) - best.radius) best = n;
      const over = dist(best, end) - best.radius;
      const inFrame = end.x > city.bounds.x0 && end.x < city.bounds.x1 && end.z > city.bounds.z0 && end.z < city.bounds.z1;
      if (inFrame && !best.boundary && over > OFF_JUNCTION) audit.stripEndsOffJunction.push(at(end, over, `beyond ${best.name}`));
    }
  }

  for (const pad of city.pads) {
    if (pad.layer < 0) continue;
    const xs = pad.outline.map((q) => q.x);
    const zs = pad.outline.map((q) => q.z);
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    for (const b of city.buildings) {
      // A wall vertex well inside the pad: asphalt over the house (touching the kerb line is fine).
      const inside = b.outline.filter((q) => q.x > x0 && q.x < x1 && q.z > z0 && q.z < z1 && pointInPolygon(q, pad.outline, []));
      const deep = inside.filter((q) => pad.outline.every((a, k) => segmentDistance(q, a, pad.outline[(k + 1) % pad.outline.length]!) > 0.5));
      if (deep.length) audit.buildingsUnderPads.push(at(deep[0]!, deep.length, `under ${city.nodes[pad.node]!.name}`));
    }
  }

  for (const l of city.lanes) {
    const seg = city.segments[l.seg]!;
    if (!seg.rail && l.length < STUB_LANE) audit.stubLanes.push(at(l.start, l.length, street(l.seg)));
    if (seg.rail && !l.out.length && !city.nodes[seg.to]!.boundary) audit.railDeadEnds.push(at(l.end, 0, 'track ends'));
    if (seg.rail && !l.in.length && !city.nodes[seg.from]!.boundary) audit.railDeadEnds.push(at(l.start, 0, 'track starts'));
  }

  for (const c of city.connectors) {
    const from = city.lanes[c.from]!;
    const to = city.lanes[c.to]!;
    const cp = c.line.points;
    const lp = from.line.points;
    const tp = to.line.points;
    const k = Math.max(angleBetween(dir(lp[lp.length - 2]!, lp[lp.length - 1]!), dir(cp[0]!, cp[1]!)), angleBetween(dir(cp[cp.length - 2]!, cp[cp.length - 1]!), dir(tp[0]!, tp[1]!)));
    const note = `${rail(c.from) ? 'track ' : ''}${c.turn} ${street(from.seg)} → ${street(to.seg)}`;
    if (k > BACKWARD) audit.backwardConnectors.push(at(cp[0]!, k, note));
    else if (k > KINK) audit.connectorKinks.push(at(cp[0]!, k, note));
    if (c.line.length > LONG_CONNECTOR) audit.longConnectors.push(at(cp[0]!, c.line.length, note));
  }

  // A road connector whose axis leaves the asphalt: a vehicle drives over the sidewalk there.
  const onRoad = roadSurface(city);
  for (const c of city.connectors) {
    if (rail(c.from) || city.segments[city.lanes[c.from]!.seg]!.layer < 0) continue;
    let off = 0;
    let where: Vec2 = c.line.points[0]!;
    for (let s = 0; s <= c.line.length; s += 1) {
      const q = poseAlong(c.line, s);
      if (!onRoad(q)) [off, where] = [off + 1, q];
    }
    if (off) audit.connectorsOffAsphalt.push(at(where, off, `${c.turn} ${street(city.lanes[c.from]!.seg)} → ${street(city.lanes[c.to]!.seg)}`));
  }

  const tracks = district.roads.edges
    .filter((e) => e.cls === 'tram')
    .map((e) => Array.from({ length: e.pts.length / 2 }, (_, i) => ({ x: e.pts[2 * i]!, z: e.pts[2 * i + 1]! })));
  const offTrack = (q: Vec2) => {
    let d = Infinity;
    for (const t of tracks) for (let i = 1; i < t.length; i++) d = Math.min(d, segmentDistance(q, t[i - 1]!, t[i]!));
    return d;
  };
  for (const c of city.connectors) {
    if (!rail(c.from)) continue;
    let worst = 0;
    let where: Vec2 = c.line.points[0]!;
    for (let s = 0; s <= c.line.length; s += 1) {
      const q = poseAlong(c.line, s);
      const d = offTrack(q);
      if (d > worst) [worst, where] = [d, q];
    }
    if (worst > RAIL_STRAY) audit.railOffTrack.push(at(where, worst, `node ${c.node}`));
  }

  for (const list of Object.values(audit)) list.sort((a, b) => b.size - a.size);
  return audit;
}
