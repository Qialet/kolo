import type { Rect, Vec2 } from '../geometry.js';

export interface RunPoint extends Vec2 {
  /** Graph node key when this point is a node of the graph (an OSM split node or a frame cut). */
  key: string | null;
}

/**
 * Parts of a polyline inside the rectangle (Liang–Barsky per piece). Cut points get a boundary key;
 * original points keep the key supplied by `keyOf`.
 */
export function clipRuns(points: (Vec2 & { key: string | null })[], r: Rect): RunPoint[][] {
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
