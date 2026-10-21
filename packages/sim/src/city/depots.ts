import { headingOf, type Vec2 } from '../geometry.js';
import { minAreaRect, pointInPolygon } from '../import/polygons.js';
import type { DistrictDepotSite } from './district.js';
import { lanePoint } from './lanes.js';
import { buildingIndex, CurbIndex, type CurbHit } from './places.js';
import type { Address, City, Depot, Slot } from './types.js';

/** Service boxes per partner depot (agreed with the user). */
const BOXES: Record<string, number> = { P1: 4, P2: 3, P3: 2 };
const BOX_PITCH = 9;
const GARAGE_DEPTH = 16;
const OFFICE_ALONG = 13;
const OFFICE_DEEP = 11;
const SLOT_W = 2.6;
const SLOT_L = 5;
const AISLE = 6.5;
/** Clear corridor from the gate into the yard. */
const GATE_HALF = 4;
const GATE_DEEP = 10;
const GATE_REACH = 45;
/** Gate candidates along the lot outline. */
const GATE_STEP = 2;
const GARAGE_SLIDE = 2;

/** Axis-aligned rectangle in the lot's own frame (s along the long side, t across). */
interface Box {
  s0: number;
  s1: number;
  t0: number;
  t1: number;
}

const overlaps = (a: Box, b: Box, pad = 0) => a.s0 < b.s1 + pad && a.s1 > b.s0 - pad && a.t0 < b.t1 + pad && a.t1 > b.t0 - pad;

/**
 * Lays out partner yards on real lots: the gate on the side of the lot nearest to a core curb lane,
 * a service garage at the far end, an office by the gate and double rows of slots in between.
 */
export function layoutDepots(city: City, sites: DistrictDepotSite[]) {
  const curbs = new CurbIndex(city);
  const osmBuilding = buildingIndex([...city.buildings]);
  for (const site of sites) {
    const depot = layoutDepot(city, site, curbs, osmBuilding);
    if (depot) city.depots.push(depot);
  }
}

function layoutDepot(city: City, site: DistrictDepotSite, curbs: CurbIndex, osmBuilding: (p: Vec2) => string | undefined): Depot | null {
  const lot: Vec2[] = Array.from({ length: site.pts.length / 2 }, (_, i) => ({ x: site.pts[2 * i]!, z: site.pts[2 * i + 1]! }));
  const box = minAreaRect(lot);
  const { u, len: L, wid: W } = box;
  const n = { x: -u.z, z: u.x };
  const P = (s: number, t: number): Vec2 => ({ x: box.center.x + u.x * s + n.x * t, z: box.center.z + u.z * s + n.z * t });
  const dir = (s: number, t: number): Vec2 => ({ x: u.x * s + n.x * t, z: u.z * s + n.z * t });

  // Gate: the point of the outline nearest to a curb whose straight driveway crosses no building.
  let gateHit: { gate: Vec2; hit: CurbHit; d: number } | null = null;
  for (let i = 0; i < lot.length; i++) {
    const a = lot[i]!;
    const b = lot[(i + 1) % lot.length]!;
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    for (let k = 1; k < l / GATE_STEP; k++) {
      const q = { x: a.x + ((b.x - a.x) * k * GATE_STEP) / l, z: a.z + ((b.z - a.z) * k * GATE_STEP) / l };
      const driveway = (hit: CurbHit) => {
        const c = lanePoint(city, hit.lane.id, curbs.curb(hit).s);
        for (let j = 0; j <= 20; j++) if (osmBuilding({ x: c.x + ((q.x - c.x) * j) / 20, z: c.z + ((q.z - c.z) * j) / 20 })) return Infinity;
        return Math.hypot(c.x - q.x, c.z - q.z);
      };
      const hit = curbs.nearest(q, GATE_REACH, (h) => driveway(h) < (gateHit?.d ?? Infinity));
      if (hit) gateHit = { gate: q, hit, d: driveway(hit) };
    }
  }
  if (!gateHit) return null;
  const gate = gateHit.gate;
  const gs = (gate.x - box.center.x) * u.x + (gate.z - box.center.z) * u.z;
  const gt = (gate.x - box.center.x) * n.x + (gate.z - box.center.z) * n.z;
  const axis: 's' | 't' = L / 2 - Math.abs(gs) < W / 2 - Math.abs(gt) ? 's' : 't';
  const sign = Math.sign(axis === 's' ? gs : gt) || 1;
  /** Position of the gate along its side. */
  const along = axis === 's' ? gt : gs;
  const inward = axis === 's' ? dir(-sign, 0) : dir(0, -sign);
  const yard = { x: gate.x + inward.x * 8, z: gate.z + inward.z * 8 };
  const corridor: Box =
    axis === 's'
      ? { s0: sign > 0 ? L / 2 - GATE_DEEP : -L / 2, s1: sign > 0 ? L / 2 : -L / 2 + GATE_DEEP, t0: along - GATE_HALF, t1: along + GATE_HALF }
      : { s0: along - GATE_HALF, s1: along + GATE_HALF, t0: sign > 0 ? W / 2 - GATE_DEEP : -W / 2, t1: sign > 0 ? W / 2 : -W / 2 + GATE_DEEP };
  const corners = (b: Box) => [P(b.s0, b.t0), P(b.s1, b.t0), P(b.s1, b.t1), P(b.s0, b.t1)];
  const clearOf = (pts: Vec2[]) => pts.every((p) => pointInPolygon(p, lot, []) && !osmBuilding(p));

  // Garage with service boxes across one end of the long axis (the far one first), boxes nose in.
  const boxes = BOXES[site.id] ?? 2;
  const gw = Math.min(boxes * BOX_PITCH, W - 2);
  const pitch = gw / boxes;
  const gateEnd = axis === 's' ? sign : Math.sign(gs) || 1;
  let garage: Box | null = null;
  let boxSlots: Slot[] = [];
  // An irregular lot may not reach the corner of its bounding box: slide the garage inwards until it fits.
  const options = [-gateEnd, gateEnd].flatMap((end) => Array.from({ length: Math.floor(L / 3 / GARAGE_SLIDE) + 1 }, (_, k) => ({ end, shift: k * GARAGE_SLIDE })));
  for (const { end, shift } of options) {
    const g: Box =
      end > 0
        ? { s0: L / 2 - GARAGE_DEPTH - shift, s1: L / 2 - shift, t0: -gw / 2, t1: gw / 2 }
        : { s0: -L / 2 + shift, s1: -L / 2 + GARAGE_DEPTH + shift, t0: -gw / 2, t1: gw / 2 };
    const sMid = (g.s0 + g.s1) / 2;
    const slotsHere = Array.from({ length: boxes }, (_, i) => {
      const p = P(sMid, -gw / 2 + pitch * (i + 0.5));
      return { x: p.x, z: p.z, heading: headingOf(dir(end, 0)) };
    });
    if (overlaps(g, corridor) || !clearOf([...slotsHere, ...corners(g)])) continue;
    garage = g;
    boxSlots = slotsHere;
    break;
  }
  if (!garage) return null;

  // Office in a corner of the gate side, clear of the gate corridor and the garage.
  const officeOptions: Box[] =
    axis === 's'
      ? [-1, 1].map((e) => {
          const s0 = sign > 0 ? L / 2 - OFFICE_DEEP : -L / 2;
          return e > 0 ? { s0, s1: s0 + OFFICE_DEEP, t0: W / 2 - OFFICE_ALONG, t1: W / 2 } : { s0, s1: s0 + OFFICE_DEEP, t0: -W / 2, t1: -W / 2 + OFFICE_ALONG };
        })
      : [-1, 1].map((e) => {
          const t0 = sign > 0 ? W / 2 - OFFICE_DEEP : -W / 2;
          return e > 0 ? { s0: L / 2 - OFFICE_ALONG, s1: L / 2, t0, t1: t0 + OFFICE_DEEP } : { s0: -L / 2, s1: -L / 2 + OFFICE_ALONG, t0, t1: t0 + OFFICE_DEEP };
        });
  const office = officeOptions.find((o) => !overlaps(o, corridor) && !overlaps(o, garage!, 1)) ?? officeOptions[0]!;

  // Double rows of slots along the long axis, facing a shared aisle.
  const slots: Slot[] = [];
  const fits = (b: Box) => {
    const pts = [...corners(b), P((b.s0 + b.s1) / 2, (b.t0 + b.t1) / 2)];
    return pts.every((p) => pointInPolygon(p, lot, []) && !osmBuilding(p)) && !overlaps(b, garage, 1) && !overlaps(b, office, 1) && !overlaps(b, corridor);
  };
  const row = (tc: number, facing: number) => {
    for (let s = -L / 2 + SLOT_W / 2 + 0.5; s <= L / 2 - SLOT_W / 2 - 0.5; s += SLOT_W) {
      const b = { s0: s - SLOT_W / 2, s1: s + SLOT_W / 2, t0: tc - SLOT_L / 2, t1: tc + SLOT_L / 2 };
      if (!fits(b)) continue;
      const p = P(s, tc);
      slots.push({ x: p.x, z: p.z, heading: headingOf(dir(0, facing)) });
    }
  };
  for (let t0 = -W / 2 + 0.5; t0 + SLOT_L + AISLE <= W / 2 - 0.5; t0 += 2 * SLOT_L + AISLE + 0.5) {
    row(t0 + SLOT_L / 2, 1);
    if (t0 + 2 * SLOT_L + AISLE <= W / 2 - 0.5) row(t0 + SLOT_L + AISLE + SLOT_L / 2, -1);
  }

  const garageBuilding = { id: `${site.id}-garage`, outline: corners(garage), holes: [], h: 7, levels: 2, kind: 'garage' as const, name: `${site.name} servis` };
  const officeBuilding = { id: `${site.id}-office`, outline: corners(office), holes: [], h: 6, levels: 2, kind: 'depot-office' as const, name: site.name };
  for (const b of [garageBuilding, officeBuilding]) {
    const c = b.outline.reduce((a, p) => ({ x: a.x + p.x / 4, z: a.z + p.z / 4 }), { x: 0, z: 0 });
    city.buildings.push({ ...b, x: c.x, z: c.z, tint: 0, addressId: null });
  }

  const { street, ...curb } = curbs.curb(gateHit.hit);
  const address: Address = {
    id: `A${site.id}`,
    label: city.streets[street]!.name ? `${site.name}, ${city.streets[street]!.name}` : site.name,
    street,
    number: '',
    ...curb,
    buildingId: officeBuilding.id,
    poi: null,
  };
  city.addresses.push(address);
  city.addressById.set(address.id, address);
  city.buildings[city.buildings.length - 1]!.addressId = address.id;

  return {
    id: site.id,
    name: site.name,
    lot,
    garage: corners(garage),
    gate,
    yard,
    curb: { lane: curb.lane, s: curb.s },
    addressId: address.id,
    slots,
    boxes: boxSlots,
  };
}
