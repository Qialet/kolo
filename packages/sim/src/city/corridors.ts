import { poseAlong, type Vec2 } from '../geometry.js';
import { segmentDistance } from '../import/polygons.js';
import { SegmentGrid } from './places.js';
import type { City, Lane, Twin } from './types.js';

/** A tram and a car closer than this side by side would touch: the track lies on the car lane. */
const SHARE_GAP = 2.2;
const SHARE_ALIGN = Math.cos((25 * Math.PI) / 180);
const STEP = 2;
const MIN_RUN = 6;

interface Hit {
  lane: number;
  t: number;
}

/** Linear map of a position on a twin's own lane onto its partner lane. */
export function twinPos(t: Twin, s: number): number {
  return t.t0 + ((s - t.s0) * (t.t1 - t.t0)) / (t.s1 - t.s0);
}

/**
 * Pairs every tram track lane with the street lanes it lies on (same layer, within 2.2 m, running the
 * same way within 25°) and stores each stretch on both lanes as Lane.twins. Returns the shared length and
 * the length of track lying on a lane of the opposite direction (not modelled).
 */
export function buildTwins(city: City): { sharedM: number; oppositeM: number } {
  for (const lane of city.lanes) delete lane.twins;
  const grid = new SegmentGrid<{ lane: Lane; s0: number }>();
  for (const lane of city.lanes) {
    if (city.segments[lane.seg]!.rail) continue;
    const { points, cum } = lane.line;
    for (let i = 1; i < points.length; i++) grid.add(points[i - 1]!, points[i]!, { lane, s0: cum[i - 1]! });
  }
  let sharedM = 0;
  let oppositeM = 0;
  for (const rail of city.lanes) {
    const seg = city.segments[rail.seg]!;
    if (!seg.rail) continue;
    let run: { hit: Hit; s0: number; t0: number; s1: number; t1: number } | null = null;
    const close = () => {
      if (run && run.s1 - run.s0 >= MIN_RUN) {
        const own: Twin = { lane: run.hit.lane, s0: run.s0, s1: run.s1, t0: run.t0, t1: run.t1 };
        const back: Twin = { lane: rail.id, s0: run.t0, s1: run.t1, t0: run.s0, t1: run.s1 };
        (rail.twins ??= []).push(own);
        (city.lanes[run.hit.lane]!.twins ??= []).push(back);
        sharedM += run.s1 - run.s0;
      }
      run = null;
    };
    for (let s = 0; s <= rail.length; s += STEP) {
      const p = poseAlong(rail.line, s);
      const dir = { x: Math.sin(p.heading), z: Math.cos(p.heading) };
      let best: (Hit & { d: number }) | null = null;
      let against = false;
      for (const { a, b, item } of grid.near(p, SHARE_GAP)) {
        if (city.segments[item.lane.seg]!.layer !== seg.layer) continue;
        const d = segmentDistance(p, a, b);
        if (d > SHARE_GAP) continue;
        const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const u: Vec2 = { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
        const align = u.x * dir.x + u.z * dir.z;
        if (align <= -SHARE_ALIGN) against = true;
        if (align < SHARE_ALIGN || (best && d >= best.d)) continue;
        const along = Math.max(0, Math.min(l, (p.x - a.x) * u.x + (p.z - a.z) * u.z));
        best = { lane: item.lane.id, t: item.s0 + along, d };
      }
      if (against && !best) oppositeM += STEP;
      if (best && run && run.hit.lane === best.lane && best.t >= run.t1) {
        run.s1 = s;
        run.t1 = best.t;
        continue;
      }
      close();
      if (best) run = { hit: best, s0: s, t0: best.t, s1: s, t1: best.t };
    }
    close();
  }
  return { sharedM, oppositeM };
}
