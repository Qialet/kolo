import type { DistrictTransit } from '../city/district.js';
import type { BusStop, City } from '../city/types.js';
import { ringArea } from '../import/polygons.js';
import type { Rng } from '../rng.js';
import { belgradeTime, serviceFor, type TransitCalendar } from '../transit/calendar.js';
import { prevDate, serviceEpoch } from './transit.js';

/** Floor area (m²) of an address without a building, and the least any address weighs. */
export const MIN_ADDRESS_AREA = 300;
/** Hour buckets of a service day: GTFS times run past 24:00 into the next calendar day. */
const BUCKETS = 48;

/** Running sums of the weights. */
export function cumulative(weights: ArrayLike<number>): Float64Array {
  const cum = new Float64Array(weights.length);
  let sum = 0;
  for (let i = 0; i < weights.length; i++) cum[i] = sum += weights[i]!;
  return cum;
}

/** Index i with probability weight[i] / total for u uniform in [0, 1): binary search; −1 when all weights are zero. */
export function pickWeighted(cum: Float64Array, u: number): number {
  const total = cum.length ? cum[cum.length - 1]! : 0;
  if (!(total > 0)) return -1;
  const x = u * total;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! > x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Floor area behind each address: its building's footprint × storeys, shared by the building's addresses. */
export function addressWeights(city: City): Float64Array {
  const share = new Map<string, number>();
  for (const a of city.addresses) if (a.buildingId) share.set(a.buildingId, (share.get(a.buildingId) ?? 0) + 1);
  const byId = new Map(city.buildings.map((b) => [b.id, b]));
  return Float64Array.from(city.addresses, (a) => {
    const b = a.buildingId ? byId.get(a.buildingId) : undefined;
    if (!b) return MIN_ADDRESS_AREA;
    const footprint = ringArea(b.outline) - b.holes.reduce((s, h) => s + ringArea(h), 0);
    return Math.max(MIN_ADDRESS_AREA, (footprint * b.levels) / share.get(b.id)!);
  });
}

/** Trip departures from each of `stopIds` per service and hour of the service day (48 buckets). */
export function stopCalls(transit: DistrictTransit, stopIds: string[]): Map<string, Float64Array[]> {
  const index = new Map(stopIds.map((id, i) => [id, i]));
  const calls = new Map<string, Float64Array[]>();
  for (const pattern of transit.patterns) {
    const at = pattern.stops.map((s) => index.get(transit.stops[s]!.id) ?? -1);
    for (const profile of pattern.profiles) {
      for (const [service, deltas] of Object.entries(profile.starts)) {
        let hours = calls.get(service);
        if (!hours) calls.set(service, (hours = Array.from({ length: BUCKETS }, () => new Float64Array(stopIds.length))));
        let start = 0;
        for (const d of deltas) {
          start += d;
          for (let k = 0; k < at.length; k++) {
            if (at[k]! < 0) continue;
            const h = Math.min(BUCKETS - 1, Math.floor((start + profile.t[2 * k + 1]!) / 3600));
            hours[h]![at[k]!]!++;
          }
        }
      }
    }
  }
  return calls;
}

/**
 * Departures per stop in the current hour on the Belgrade clock: today's service plus yesterday's trips
 * past 24:00; the whole service day when that hour has none.
 */
export function hourWeights(calls: Map<string, Float64Array[]>, calendar: TransitCalendar, clockMs: number): Float64Array {
  const date = belgradeTime(clockMs).date;
  const h = Math.min(23, Math.max(0, Math.floor((clockMs - serviceEpoch(date, 0)) / 3_600_000)));
  const today = calls.get(serviceFor(date, calendar));
  const yesterday = calls.get(serviceFor(prevDate(date), calendar));
  const n = calls.values().next().value?.[0]!.length ?? 0;
  const w = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) total += w[i] = (today?.[h]![i] ?? 0) + (yesterday?.[h + 24]![i] ?? 0);
  if (total > 0 || !today) return w;
  for (const hour of today) for (let i = 0; i < n; i++) w[i] = w[i]! + hour[i]!;
  return w;
}

/** Share of pick-ups at stops, and at stops or places of interest together; the rest are at addresses. */
const ORIGIN_STOP = 0.4;
const ORIGIN_POI = 0.7;
/** Share of drop-offs at places of interest; the rest are at addresses. */
const DEST_POI = 0.25;
/** Places where free taxis wait for orders. */
export const DUTY_SPOTS = 40;

/** A demand point; `id` is the simulation place (stop id, the address of a place of interest, address id), `index` its position in its list. */
export interface DemandPick {
  kind: 'stop' | 'poi' | 'address';
  id: string;
  index: number;
}

/**
 * Where orders start and end: stops by their departures this hour, places of interest by weight,
 * addresses by floor area. Tables are built once; every pick is a binary search.
 */
export class Demand {
  private readonly calls: Map<string, Float64Array[]>;
  private readonly poiCum: Float64Array;
  private readonly addressCum: Float64Array;
  private readonly hours = new Map<number, { weights: Float64Array; cum: Float64Array }>();

  constructor(
    private readonly city: City,
    private readonly stops: readonly BusStop[],
  ) {
    this.calls = stopCalls(city.transit, stops.map((s) => s.id));
    this.poiCum = cumulative(city.pois.map((p) => p.weight));
    this.addressCum = cumulative(addressWeights(city));
  }

  get cachedHours(): number {
    return this.hours.size;
  }

  /** Departures from each stop in the current hour (by the order of `stops`). */
  stopWeights(clockMs: number): Float64Array {
    return this.hour(clockMs).weights;
  }

  origin(rng: Rng, clockMs: number): DemandPick {
    const r = rng.next();
    const u = rng.next();
    if (r < ORIGIN_STOP) {
      const i = pickWeighted(this.hour(clockMs).cum, u);
      if (i >= 0) return { kind: 'stop', id: this.stops[i]!.id, index: i };
    }
    if (r < ORIGIN_POI) return this.poi(u);
    return this.address(u);
  }

  destination(rng: Rng): DemandPick {
    const r = rng.next();
    const u = rng.next();
    return r < DEST_POI ? this.poi(u) : this.address(u);
  }

  /** Stops and places of interest with the most pick-ups over a day, most first; one per place. */
  spots(n = DUTY_SPOTS): DemandPick[] {
    const daily = new Float64Array(this.stops.length);
    for (const hours of this.calls.values()) for (const h of hours) for (let i = 0; i < daily.length; i++) daily[i] = daily[i]! + h[i]!;
    const stopTotal = daily.reduce((s, x) => s + x, 0);
    const poiTotal = this.poiCum.length ? this.poiCum[this.poiCum.length - 1]! : 0;
    const all: (DemandPick & { p: number })[] = [];
    if (stopTotal > 0) this.stops.forEach((s, i) => all.push({ kind: 'stop', id: s.id, index: i, p: (ORIGIN_STOP * daily[i]!) / stopTotal }));
    if (poiTotal > 0) this.city.pois.forEach((p, i) => all.push({ kind: 'poi', id: p.addressId, index: i, p: ((ORIGIN_POI - ORIGIN_STOP) * p.weight) / poiTotal }));
    all.sort((a, b) => b.p - a.p || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const seen = new Set<string>();
    const out: DemandPick[] = [];
    for (const { kind, id, index } of all) {
      if (out.length >= n) break;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ kind, id, index });
    }
    return out;
  }

  private poi(u: number): DemandPick {
    const i = pickWeighted(this.poiCum, u);
    return i >= 0 ? { kind: 'poi', id: this.city.pois[i]!.addressId, index: i } : this.address(u);
  }

  private address(u: number): DemandPick {
    const i = pickWeighted(this.addressCum, u);
    return { kind: 'address', id: this.city.addresses[i]!.id, index: i };
  }

  /** Weights of the clock hour: Belgrade is a whole number of hours off UTC, so the UTC hour is the key. */
  private hour(clockMs: number) {
    const key = Math.floor(clockMs / 3_600_000);
    let table = this.hours.get(key);
    if (!table) {
      if (this.hours.size >= 48) this.hours.clear();
      const weights = hourWeights(this.calls, this.city.transit.calendar, clockMs);
      table = { weights, cum: cumulative(weights) };
      this.hours.set(key, table);
    }
    return table;
  }
}
