export interface Vec2 {
  x: number;
  z: number;
}

export const v = (x: number, z: number): Vec2 => ({ x, z });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, z: a.z + b.z });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, z: a.z * k });
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.z * b.z;
export const cross = (a: Vec2, b: Vec2) => a.x * b.z - a.z * b.x;
export const len = (a: Vec2) => Math.hypot(a.x, a.z);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
/** Point at fraction t of the way from a to b. */
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
export const norm = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return { x: a.x / l, z: a.z / l };
};
/** Right-hand normal for right-hand traffic in a world where +x is east and +z is south. */
export const rightOf = (d: Vec2): Vec2 => ({ x: -d.z, z: d.x });
/** Heading used by the renderer: rotation around Y that points a model's +Z axis along d. */
export const headingOf = (d: Vec2) => Math.atan2(d.x, d.z);

export interface Polyline {
  points: Vec2[];
  /** Cumulative length at each point. */
  cum: number[];
  length: number;
}

export function polyline(points: Vec2[]): Polyline {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push((cum[i - 1] as number) + dist(points[i - 1] as Vec2, points[i] as Vec2));
  }
  return { points, cum, length: cum[cum.length - 1] as number };
}

export interface Pose {
  x: number;
  z: number;
  heading: number;
}

export function poseAt(line: Polyline, s: number): Pose {
  const { points, cum } = line;
  const clamped = Math.max(0, Math.min(line.length, s));
  let i = 1;
  while (i < points.length - 1 && (cum[i] as number) < clamped) i++;
  const a = points[i - 1] as Vec2;
  const b = points[i] as Vec2;
  const segLen = (cum[i] as number) - (cum[i - 1] as number) || 1;
  const t = (clamped - (cum[i - 1] as number)) / segLen;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, heading: Math.atan2(b.x - a.x, b.z - a.z) };
}

/**
 * Pose at arc length `s`, shifted `lateral` metres to the right of the local direction.
 * Past either end the first / last piece is extended straight (vehicles straddling a lane end).
 */
export function poseAlong(line: Polyline, s: number, lateral = 0): Pose {
  const { points, cum } = line;
  let i = 1;
  while (i < points.length - 1 && (cum[i] as number) < s) i++;
  const a = points[i - 1] as Vec2;
  const b = points[i] as Vec2;
  const segLen = (cum[i] as number) - (cum[i - 1] as number) || 1;
  const d = { x: (b.x - a.x) / segLen, z: (b.z - a.z) / segLen };
  const t = s - (cum[i - 1] as number);
  return { x: a.x + d.x * t - d.z * lateral, z: a.z + d.z * t + d.x * lateral, heading: Math.atan2(d.x, d.z) };
}

/** Unit direction of a polyline at its start / end. */
export const startTangent = (line: Polyline): Vec2 => norm(sub(line.points[1]!, line.points[0]!));
export const endTangent = (line: Polyline): Vec2 => norm(sub(line.points[line.points.length - 1]!, line.points[line.points.length - 2]!));

export function quadBezier(p0: Vec2, c: Vec2, p1: Vec2, steps = 10): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, z: u * u * p0.z + 2 * u * t * c.z + t * t * p1.z });
  }
  return out;
}

/** Intersection point of two infinite lines p + t·d. */
export function lineIntersection(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 | null {
  const den = cross(d, e);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(q, p), e) / den;
  return add(p, scale(d, t));
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2, eps: number): boolean {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-9) return false;
  const t = cross(sub(c, a), s) / den;
  const u = cross(sub(c, a), r) / den;
  return t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps;
}

/** Whether two polylines come closer than `clearance` metres (sampled check). */
export function polylinesConflict(a: Polyline, b: Polyline, clearance: number): boolean {
  for (let i = 1; i < a.points.length; i++) {
    for (let j = 1; j < b.points.length; j++) {
      if (segmentsIntersect(a.points[i - 1]!, a.points[i]!, b.points[j - 1]!, b.points[j]!, 0.02)) return true;
    }
  }
  for (const p of a.points) for (const q of b.points) if (dist(p, q) < clearance) return true;
  return false;
}

export function pointInRect(p: Vec2, r: Rect, pad = 0) {
  return p.x >= r.x0 - pad && p.x <= r.x1 + pad && p.z >= r.z0 - pad && p.z <= r.z1 + pad;
}

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}
