import { poseAlong, projectOnPolyline, type Polyline, type Vec2 } from '../geometry.js';
import { segmentDistance } from '../import/polygons.js';
import { SegmentGrid } from './places.js';
import type { City, Lane } from './types.js';

/** Height of a bridge deck per OSM layer. */
export const DECK_STEP = 6;
/** Grade of a ramp from where a deck leaves the level below. */
export const RAMP_GRADE = 0.08;
/** Steepest a ramp gets to clear a lane passing under it close to its foot. */
export const RAMP_GRADE_MAX = 0.3;
/** Headroom a deck keeps over a lane of a lower level. */
export const DECK_CLEARANCE = 5;
/** Spacing of the stored heights along segments and lanes. */
export const DECK_SAMPLE = 4;
/** A vehicle is out of sight this far into a tunnel from either portal. */
export const TUNNEL_HIDE = 3;
/** A deck point within this of a lower lane (horizontally) passes over it. */
const OVER = 3;
/** Spacing of the deck points checked for headroom. */
const PROBE = 2;

/** Height at `s` of something sampled every DECK_SAMPLE metres from 0, the last sample at `length`. */
function sampled(ys: number[] | undefined, length: number, s: number): number {
  if (!ys) return 0;
  const n = ys.length;
  if (n === 1) return ys[0]!;
  const t = Math.max(0, Math.min(length, s));
  const i = Math.min(n - 2, Math.floor(t / DECK_SAMPLE));
  const s0 = i * DECK_SAMPLE;
  const s1 = i === n - 2 ? length : s0 + DECK_SAMPLE;
  return ys[i]! + (ys[i + 1]! - ys[i]!) * (s1 > s0 ? (t - s0) / (s1 - s0) : 0);
}

const samplesOf = (length: number, at: (s: number) => number) => {
  const ys: number[] = [];
  for (let s = 0; s < length - 0.01; s += DECK_SAMPLE) ys.push(round2(at(s)));
  ys.push(round2(at(length)));
  return ys;
};
const round2 = (x: number) => Math.round(x * 100) / 100;

export const nodeY = (city: City, node: number) => city.nodes[node]!.y ?? 0;
/** Height at arc length `s` along a segment's centre line (node to node). */
export const segmentY = (city: City, seg: number, s: number) => {
  const g = city.segments[seg]!;
  return sampled(g.y, g.length, s);
};
export const laneY = (city: City, lane: number, s: number) => {
  const l = city.lanes[lane]!;
  return sampled(l.y, l.length, s);
};
/** Height along a connector: straight from the end of the lane it leaves to the start of the one it joins. */
export const connectorY = (city: City, conn: number, s: number) => {
  const c = city.connectors[conn]!;
  const a = laneY(city, c.from, city.lanes[c.from]!.length);
  const b = laneY(city, c.to, 0);
  return a + (b - a) * (c.line.length > 0 ? Math.max(0, Math.min(1, s / c.line.length)) : 0);
};
/** A vehicle at `s` on the lane is underground, past the portal of its tunnel. */
export const inTunnel = (city: City, lane: number, s: number) => {
  const l = city.lanes[lane]!;
  return city.segments[l.seg]!.layer < 0 && s > TUNNEL_HIDE && s < l.length - TUNNEL_HIDE;
};

interface Overpass {
  deck: Lane;
  /** Arc length along the deck lane. */
  s: number;
  at: Vec2;
  lower: Lane;
  /** Arc length along the lower lane. */
  t: number;
}

/** Bounding boxes of the lanes grown by OVER: x0, x1, z0, z1 per lane. */
function laneBoxes(city: City): Float64Array {
  const boxes = new Float64Array(4 * city.lanes.length);
  for (const l of city.lanes) {
    let [x0, x1, z0, z1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const p of l.line.points) [x0, x1, z0, z1] = [Math.min(x0, p.x), Math.max(x1, p.x), Math.min(z0, p.z), Math.max(z1, p.z)];
    boxes.set([x0 - OVER, x1 + OVER, z0 - OVER, z1 + OVER], 4 * l.id);
  }
  return boxes;
}

/** Points of the deck lanes of `layer` passing over a lane of a lower level (tunnels aside) that is not on a segment joined to theirs. */
function overpasses(city: City, layer: number, boxes: Float64Array): Overpass[] {
  const box = (l: Lane) => [boxes[4 * l.id]!, boxes[4 * l.id + 1]!, boxes[4 * l.id + 2]!, boxes[4 * l.id + 3]!] as const;
  const decks = city.lanes.filter((l) => city.segments[l.seg]!.layer === layer).map((l) => {
    const probes: { s: number; at: Vec2 }[] = [];
    for (let s = 0; s <= l.length; s += PROBE) probes.push({ s, at: poseAlong(l.line, s) });
    return { l, b: box(l), probes };
  });
  if (!decks.length) return [];
  const out: Overpass[] = [];
  for (const lower of city.lanes) {
    const lg = city.segments[lower.seg]!;
    if (lg.layer < 0 || lg.layer >= layer) continue;
    const lb = box(lower);
    for (const { l, b, probes } of decks) {
      if (b[0] > lb[1] || b[1] < lb[0] || b[2] > lb[3] || b[3] < lb[2]) continue;
      const g = city.segments[l.seg]!;
      if (g.from === lg.from || g.from === lg.to || g.to === lg.from || g.to === lg.to) continue;
      const p = lower.line.points;
      for (const { s, at } of probes) {
        if (at.x < lb[0] || at.x > lb[1] || at.z < lb[2] || at.z > lb[3]) continue;
        let near = Infinity;
        for (let i = 1; i < p.length && near > OVER; i++) near = Math.min(near, segmentDistance(at, p[i - 1]!, p[i]!));
        if (near <= OVER) out.push({ deck: l, s, at, lower, t: projectOnPolyline(lower.line, at) });
      }
    }
  }
  return out;
}

/**
 * Heights of the bridge decks: a deck of layer L stands DECK_STEP × L high and ramps down to every
 * node where it meets a lower level (its joints) at RAMP_GRADE, steeper up to RAMP_GRADE_MAX where a
 * lane passing under it would lack DECK_CLEARANCE. Within a junction's circle the height is the node's.
 * Levels go up in order, so a joint stands as high as the level below it there. Tunnels stay at 0.
 * Returns the exact height along a segment's centre line (the stored samples are 4 m apart and cut
 * the corner where a ramp leaves a junction's circle).
 */
export function layDecks(city: City, baseOf: (seg: number) => Polyline): (seg: number, s: number) => number {
  const exact = new Map<number, (s: number) => number>();
  const { segments, nodes } = city;
  const layersAt = nodes.map((n) => [...n.in, ...n.out].map((s) => segments[s]!.layer));
  const levels = [...new Set(segments.map((s) => s.layer).filter((l) => l > 0))].sort((a, b) => a - b);
  const boxes = levels.length ? laneBoxes(city) : new Float64Array(0);
  for (const layer of levels) {
    const top = layer * DECK_STEP;
    const span = (seg: number) => {
      const g = segments[seg]!;
      return Math.max(0, g.length - nodes[g.from]!.radius - nodes[g.to]!.radius);
    };
    const isJoint = (n: number) => layersAt[n]!.includes(layer) && layersAt[n]!.some((l) => l < layer);
    // Every joint ramps on its own: distances from it over the deck, not through another joint.
    const joints = nodes
      .filter((n) => isJoint(n.id))
      .map((n) => {
        const d = new Map<number, number>([[n.id, 0]]);
        const queue: [number, number][] = [[n.id, 0]];
        while (queue.length) {
          let k = 0;
          for (let i = 1; i < queue.length; i++) if (queue[i]![1] < queue[k]![1]) k = i;
          const [m, dm] = queue.splice(k, 1)[0]!;
          if (dm > d.get(m)! || (m !== n.id && isJoint(m))) continue;
          for (const s of [...nodes[m]!.in, ...nodes[m]!.out]) {
            const g = segments[s]!;
            if (g.layer !== layer) continue;
            const o = g.from === m ? g.to : g.from;
            const dd = dm + span(s);
            if (dd < (d.get(o) ?? Infinity)) {
              d.set(o, dd);
              queue.push([o, dd]);
            }
          }
        }
        return { h: n.y ?? 0, grade: RAMP_GRADE, d };
      });
    const heightAt = (seg: number, s: number) => {
      const g = segments[seg]!;
      const ra = nodes[g.from]!.radius;
      const rb = nodes[g.to]!.radius;
      let h = top;
      for (const j of joints) {
        const da = j.d.get(g.from);
        const db = j.d.get(g.to);
        if (da !== undefined) h = Math.min(h, j.h + j.grade * (da + Math.max(0, s - ra)));
        if (db !== undefined) h = Math.min(h, j.h + j.grade * (db + Math.max(0, g.length - rb - s)));
      }
      return h;
    };
    const distOf = (j: (typeof joints)[number], seg: number, s: number) => {
      const g = segments[seg]!;
      const da = j.d.get(g.from);
      const db = j.d.get(g.to);
      return Math.min(da === undefined ? Infinity : da + Math.max(0, s - nodes[g.from]!.radius), db === undefined ? Infinity : db + Math.max(0, g.length - nodes[g.to]!.radius - s));
    };
    for (const o of overpasses(city, layer, boxes)) {
      const need = laneY(city, o.lower.id, o.t) + DECK_CLEARANCE;
      const s = projectOnPolyline(baseOf(o.deck.seg), o.at);
      if (heightAt(o.deck.seg, s) >= need) continue;
      for (const j of joints) {
        const dj = distOf(j, o.deck.seg, s);
        if (dj > 0 && dj < Infinity && j.h + j.grade * dj < need) j.grade = Math.min(RAMP_GRADE_MAX, (need - j.h) / dj);
      }
    }
    for (const g of segments) {
      if (g.layer !== layer) continue;
      exact.set(g.id, (s) => heightAt(g.id, s));
      g.y = samplesOf(g.length, (s) => heightAt(g.id, s));
      const base = baseOf(g.id);
      for (const id of g.lanes) {
        const l = city.lanes[id]!;
        l.y = samplesOf(l.length, (s) => heightAt(g.id, projectOnPolyline(base, poseAlong(l.line, s))));
      }
    }
    for (const n of nodes) {
      if (!layersAt[n.id]!.includes(layer) || isJoint(n.id)) continue;
      const g = [...n.in, ...n.out].find((s) => segments[s]!.layer === layer)!;
      const h = round2(heightAt(g, segments[g]!.from === n.id ? 0 : segments[g]!.length));
      if (h > 0) n.y = h;
    }
  }
  return (seg, s) => exact.get(seg)?.(s) ?? 0;
}

/** Places where a deck passes over a lane of a lower level with less than DECK_CLEARANCE of headroom, the lowest per 20 m. */
export function deckClearances(city: City): { x: number; z: number; clearance: number }[] {
  const worst = new Map<string, { x: number; z: number; clearance: number }>();
  const levels = [...new Set(city.segments.map((s) => s.layer).filter((l) => l > 0))];
  const boxes = laneBoxes(city);
  for (const layer of levels) {
    for (const o of overpasses(city, layer, boxes)) {
      const clearance = laneY(city, o.deck.id, o.s) - laneY(city, o.lower.id, o.t);
      if (clearance >= DECK_CLEARANCE - 0.05) continue;
      const key = `${Math.round(o.at.x / 20)},${Math.round(o.at.z / 20)}`;
      if ((worst.get(key)?.clearance ?? Infinity) > clearance) worst.set(key, { x: Math.round(o.at.x), z: Math.round(o.at.z), clearance: round2(clearance) });
    }
  }
  return [...worst.values()].sort((a, b) => a.clearance - b.clearance);
}

/** Height below a deck under which a lane counts as passing beneath it, not running on it. */
const BENEATH = 2;

/**
 * A test for a bridge pier of half-width `half` standing at `p` under a deck `y` high: false when a
 * lane or junction curve of a lower level runs there (its centre line nearer than half its width
 * plus `half`), so piers never stand in a carriageway or on a track below.
 */
export function pierClearance(city: City): (p: Vec2, half: number, y: number) => boolean {
  const grid = new SegmentGrid<{ line: Polyline; s0: number; at: (s: number) => number; half: number }>();
  const add = (line: Polyline, at: (s: number) => number, half: number) => {
    const p = line.points;
    for (let i = 1; i < p.length; i++) grid.add(p[i - 1]!, p[i]!, { line, s0: line.cum[i - 1]!, at, half });
  };
  const halfOf = (lane: number) => {
    const seg = city.segments[city.lanes[lane]!.seg]!;
    return seg.rail ? 1.3 : city.streets[seg.street]!.laneWidth / 2;
  };
  for (const l of city.lanes) if (city.segments[l.seg]!.layer >= 0) add(l.line, (s) => laneY(city, l.id, s), halfOf(l.id));
  for (const c of city.connectors) if (city.segments[city.lanes[c.from]!.seg]!.layer >= 0) add(c.line, (s) => connectorY(city, c.id, s), halfOf(c.from));
  return (p, half, y) => {
    for (const { a, b, item } of grid.near(p, half + 4)) {
      if (segmentDistance(p, a, b) > half + item.half) continue;
      const t = Math.hypot(b.x - a.x, b.z - a.z);
      const along = t > 0 ? Math.max(0, Math.min(t, ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / t)) : 0;
      if (item.at(item.s0 + along) < y - BENEATH) return false;
    }
    return true;
  };
}
