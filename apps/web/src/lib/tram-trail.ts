/**
 * Trams arrive as their front point only; the sections behind it follow the path that point
 * took. Every tram keeps a trail of past front positions (oldest first) to lay its sections on.
 * Plain module without imports so Node runs its tests directly.
 */

export interface TrailPose {
  x: number;
  z: number;
  /** Same convention as vehicle poses: forward is (sin, cos). */
  heading: number;
}

/** Distance between stored points. */
const STEP = 0.5;
/** Trail kept beyond the tram's length. */
const SPARE = 5;
/** A front that moves further than this between feeds was moved (clock sync): start over. */
const JUMP = 20;

interface Trail {
  /** x, z pairs, oldest first; the last pair is the newest stored point. */
  xz: number[];
  front: TrailPose;
  fed: boolean;
}

export class TramTrails {
  private trails = new Map<string, Trail>();

  get size() {
    return this.trails.size;
  }

  /** Stored points of one tram (0 when unknown). */
  points(id: string) {
    return (this.trails.get(id)?.xz.length ?? 0) / 2;
  }

  /** Takes the latest front pose of a tram of `length` metres. */
  feed(id: string, x: number, z: number, heading: number, length: number) {
    const keep = Math.ceil((length + SPARE) / STEP) + 1;
    let t = this.trails.get(id);
    const last = t ? t.xz.length - 2 : -1;
    if (!t || Math.hypot(x - t.xz[last]!, z - t.xz[last + 1]!) > JUMP) {
      // Lay the trail straight back along the heading.
      const xz: number[] = [];
      for (let k = keep - 1; k >= 0; k--) xz.push(x - Math.sin(heading) * k * STEP, z - Math.cos(heading) * k * STEP);
      t = { xz, front: { x, z, heading }, fed: true };
      this.trails.set(id, t);
      return;
    }
    const xz = t.xz;
    for (;;) {
      const px = xz[xz.length - 2]!;
      const pz = xz[xz.length - 1]!;
      const d = Math.hypot(x - px, z - pz);
      if (d < STEP) break;
      xz.push(px + ((x - px) * STEP) / d, pz + ((z - pz) * STEP) / d);
    }
    if (xz.length > keep * 2) xz.splice(0, xz.length - keep * 2);
    t.front = { x, z, heading };
    t.fed = true;
  }

  /** Centre poses of `count` equal sections of a tram of `length` metres, front section first. */
  sections(id: string, length: number, count: number, out: TrailPose[] = []): TrailPose[] {
    const t = this.trails.get(id);
    out.length = 0;
    if (!t) return out;
    const walk = new Walk(t);
    const part = length / count;
    let a = walk.at(0);
    for (let i = 1; i <= count; i++) {
      const b = walk.at(i * part);
      out.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, heading: Math.atan2(a.x - b.x, a.z - b.z) });
      a = b;
    }
    return out;
  }

  /** Forgets trams not fed since the previous prune. */
  prune() {
    for (const [id, t] of this.trails) {
      if (!t.fed) this.trails.delete(id);
      else t.fed = false;
    }
  }
}

/** Walks back from the front along the trail; distances must be asked in increasing order. */
class Walk {
  private xz: number[];
  /** Index (pair) of the point ending the current piece, walking backwards. */
  private i: number;
  private ax: number;
  private az: number;
  private done = 0;
  private heading: number;

  constructor(t: Trail) {
    this.xz = t.xz;
    this.i = t.xz.length / 2 - 1;
    this.ax = t.front.x;
    this.az = t.front.z;
    this.heading = t.front.heading;
  }

  at(s: number): { x: number; z: number } {
    for (;;) {
      if (this.i < 0) {
        // Past the oldest point: carry on straight.
        const k = s - this.done;
        return { x: this.ax - Math.sin(this.heading) * k, z: this.az - Math.cos(this.heading) * k };
      }
      const bx = this.xz[this.i * 2]!;
      const bz = this.xz[this.i * 2 + 1]!;
      const d = Math.hypot(bx - this.ax, bz - this.az);
      if (this.done + d >= s && d > 0) {
        const k = (s - this.done) / d;
        return { x: this.ax + (bx - this.ax) * k, z: this.az + (bz - this.az) * k };
      }
      if (d > 0) this.heading = Math.atan2(this.ax - bx, this.az - bz);
      this.done += d;
      this.ax = bx;
      this.az = bz;
      this.i--;
    }
  }
}
