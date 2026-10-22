import { lerp, pointInRect, poseAt, type Polyline, type Rect, type Vec2 } from '../geometry.js';

/** Points of a line farther than this from a stop are not candidates for its position (unless nothing is closer). */
const STOP_MATCH = 150;

/** A position on a polyline: arc length, segment index and distance from the matched point. */
export interface ShapeHit {
  along: number;
  seg: number;
  dist: number;
}

/** Candidate positions of a point on a polyline: local distance minima within STOP_MATCH (or the closest one). */
export function shapeHits(line: Polyline, p: Vec2): ShapeHit[] {
  const { points: pts, cum } = line;
  if (pts.length < 2) return [{ along: 0, seg: 0, dist: Math.hypot(p.x - pts[0]!.x, p.z - pts[0]!.z) }];
  const all: ShapeHit[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    all.push({ along: cum[i]! + t * (cum[i + 1]! - cum[i]!), seg: i, dist: Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t) });
  }
  const best = Math.min(...all.map((h) => h.dist));
  return all.filter((h, i) => h.dist <= Math.max(STOP_MATCH, best) && h.dist <= (all[i - 1]?.dist ?? Infinity) && h.dist <= (all[i + 1]?.dist ?? Infinity));
}

/** Positions of stops on a polyline in travel order: the order-preserving choice of candidates with the least total distance. */
export function locateChain(line: Polyline, stops: Vec2[]): ShapeHit[] {
  const cands = stops.map((p) => shapeHits(line, p));
  const cost: number[][] = [];
  const back: number[][] = [];
  cands.forEach((list, i) => {
    cost.push([]);
    back.push([]);
    list.forEach((h, c) => {
      if (i === 0) {
        cost[0]!.push(h.dist);
        back[0]!.push(-1);
        return;
      }
      let bestK = -1;
      let bestCost = Infinity;
      cands[i - 1]!.forEach((prev, k) => {
        const cc = cost[i - 1]![k]! + (prev.along <= h.along + 1e-6 ? 0 : 1e6);
        if (cc < bestCost) {
          bestCost = cc;
          bestK = k;
        }
      });
      cost[i]!.push(bestCost + h.dist);
      back[i]![c] = bestK;
    });
  });
  const last = cost[cost.length - 1]!;
  let c = last.indexOf(Math.min(...last));
  const out: ShapeHit[] = [];
  for (let i = cands.length - 1; i >= 0; i--) {
    out[i] = cands[i]![c]!;
    c = back[i]![c]!;
  }
  return out;
}

/** Arc length of a single stop on the polyline, preferring candidates within [from, to]. */
export function locateOne(line: Polyline, p: Vec2, from: number, to: number): number {
  const list = shapeHits(line, p);
  const within = list.filter((h) => h.along >= from - 1e-6 && h.along <= to + 1e-6);
  const pool = within.length ? within : list;
  return pool.reduce((a, b) => (b.dist < a.dist ? b : a)).along;
}

/** Arc lengths within [from, to] where the polyline crosses the border of r, and whether inwards. */
export function rectCrossings(line: Polyline, from: number, to: number, r: Rect): { d: number; inward: boolean }[] {
  const { points: pts, cum } = line;
  const out: { d: number; inward: boolean }[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const s0 = cum[i]!;
    const len = cum[i + 1]! - s0;
    if (len <= 0 || cum[i + 1]! < from || s0 > to) continue;
    const ta = Math.max(0, (from - s0) / len);
    const tb = Math.min(1, (to - s0) / len);
    const a = lerp(pts[i]!, pts[i + 1]!, ta);
    const b = lerp(pts[i]!, pts[i + 1]!, tb);
    const ia = pointInRect(a, r);
    if (ia === pointInRect(b, r)) continue;
    const clip = clipParams(a, b, r);
    if (!clip) continue;
    out.push({ d: s0 + len * (ta + (tb - ta) * (ia ? clip[1] : clip[0])), inward: !ia });
  }
  return out;
}

/** Liang–Barsky: the parameter range of segment ab inside r. */
export function clipParams(a: Vec2, b: Vec2, r: Rect): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const [p, q] of [
    [-dx, a.x - r.x0],
    [dx, r.x1 - a.x],
    [-dz, a.z - r.z0],
    [dz, r.z1 - a.z],
  ] as const) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      t0 = Math.max(t0, t);
    } else {
      if (t < t0) return null;
      t1 = Math.min(t1, t);
    }
  }
  return [t0, t1];
}

/** The part of the polyline between two arc lengths, end points interpolated. */
export function slicePolyline(line: Polyline, from: number, to: number): Vec2[] {
  const { points: pts, cum } = line;
  if (pts.length < 2) return [pts[0]!, pts[0]!];
  const at = (s: number): Vec2 => {
    const { x, z } = poseAt(line, s);
    return { x, z };
  };
  const out = [at(from)];
  for (let i = 0; i < pts.length; i++) if (cum[i]! > from && cum[i]! < to) out.push(pts[i]!);
  out.push(at(to));
  return out;
}
