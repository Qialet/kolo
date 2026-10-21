import type { Rect, Vec2 } from '../geometry.js';

/**
 * Joins open chains of node ids (multipolygon member ways) into closed rings. Each ring is returned
 * without repeating its first node; chains that never close are dropped.
 */
export function joinRings(chains: number[][]): number[][] {
  const rings: number[][] = [];
  const open: number[][] = [];
  for (const c of chains) {
    if (c.length < 2) continue;
    if (c[0] === c[c.length - 1]) rings.push(c.slice(0, -1));
    else open.push([...c]);
  }
  while (open.length) {
    let ring = open.pop()!;
    let grown = true;
    while (ring[0] !== ring[ring.length - 1] && grown) {
      grown = false;
      const end = ring[ring.length - 1]!;
      for (let i = 0; i < open.length; i++) {
        const c = open[i]!;
        if (c[0] === end) ring = [...ring, ...c.slice(1)];
        else if (c[c.length - 1] === end) ring = [...ring, ...[...c].reverse().slice(1)];
        else continue;
        open.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring.length > 3 && ring[0] === ring[ring.length - 1]) rings.push(ring.slice(0, -1));
  }
  return rings.filter((r) => r.length >= 3);
}

/** Absolute area of a simple ring. */
export function ringArea(ring: Vec2[]): number {
  return Math.abs(signedArea(ring));
}

export function signedArea(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

/** Area centroid (falls back to the vertex mean for degenerate rings). */
export function polygonCentroid(ring: Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    const f = p.x * q.z - q.x * p.z;
    a += f;
    cx += (p.x + q.x) * f;
    cz += (p.z + q.z) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = ring.length || 1;
    return { x: ring.reduce((s, p) => s + p.x, 0) / n, z: ring.reduce((s, p) => s + p.z, 0) / n };
  }
  return { x: cx / (3 * a), z: cz / (3 * a) };
}

/** Sutherland–Hodgman clip of a ring against an axis-aligned rectangle. */
export function clipRing(ring: Vec2[], r: Rect): Vec2[] {
  const edges: [(p: Vec2) => number][] = [[(p) => p.x - r.x0], [(p) => r.x1 - p.x], [(p) => p.z - r.z0], [(p) => r.z1 - p.z]];
  let out = ring;
  for (const [inside] of edges) {
    if (!out.length) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const p = input[i]!;
      const q = input[(i + 1) % input.length]!;
      const dp = inside(p);
      const dq = inside(q);
      if (dp >= 0) out.push(p);
      if ((dp >= 0) !== (dq >= 0)) {
        const t = dp / (dp - dq);
        out.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
      }
    }
  }
  return out.length >= 3 && ringArea(out) > 1e-6 ? out : [];
}

/** Douglas–Peucker on a closed ring: drops points closer than `tol` to the simplified outline. */
export function simplifyRing(ring: Vec2[], tol: number): Vec2[] {
  if (ring.length <= 4) return ring;
  // Split at the vertex farthest from the first one so both halves are open chains.
  let far = 1;
  for (let i = 1; i < ring.length; i++) if (d2(ring[i]!, ring[0]!) > d2(ring[far]!, ring[0]!)) far = i;
  const a = simplifyChain(ring.slice(0, far + 1), tol);
  const b = simplifyChain([...ring.slice(far), ring[0]!], tol);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : ring;
}

function simplifyChain(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length <= 2) return pts;
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  let best = -1;
  let bestD = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segmentDistance(pts[i]!, a, b);
    if (d > bestD) {
      bestD = d;
      best = i;
    }
  }
  if (bestD <= tol) return [a, b];
  return [...simplifyChain(pts.slice(0, best + 1), tol).slice(0, -1), ...simplifyChain(pts.slice(best), tol)];
}

const d2 = (p: Vec2, q: Vec2) => (p.x - q.x) ** 2 + (p.z - q.z) ** 2;

/** Distance from p to the segment ab. */
export function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

export function pointInRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(p: Vec2, outer: Vec2[], holes: Vec2[][]): boolean {
  return pointInRing(p, outer) && !holes.some((h) => pointInRing(p, h));
}
