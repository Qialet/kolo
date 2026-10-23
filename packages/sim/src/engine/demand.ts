import type { DistrictTransit } from '../city/district.js';
import type { City } from '../city/types.js';
import { ringArea } from '../import/polygons.js';
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
