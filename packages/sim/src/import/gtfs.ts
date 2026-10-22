import type { DistrictLine, DistrictPattern, DistrictProfile, DistrictStop, DistrictTransit, TransitMode } from '../city/district.js';
import { pointInRect, polyline, type Rect, type Vec2 } from '../geometry.js';
import type { TransitCalendar } from '../transit/calendar.js';
import { eachRecord } from './csv.js';
import { boundsOfBBox } from './osm-roads.js';
import { simplifyChain } from './polygons.js';
import { project, type BBoxDeg } from './project.js';
import { locateChain, locateOne, rectCrossings, slicePolyline } from './shape.js';
import { toLatin } from './translit.js';

/** Lines run by minibuses (route_short_name); the feed lists them as buses. */
export const MINIBUS_LINES = ['EKO1', 'EKO2'];

/** Shapes keep this much road outside the frame, metres. */
const SHAPE_MARGIN = 50;
const SHAPE_SIMPLIFY = 2;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DEFAULT_COLOR = '#6B7280';
const DEFAULT_TEXT = '#FFFFFF';

/** The transit section of a district built without a feed. */
export function emptyTransit(): DistrictTransit {
  return { feed: null, calendar: { week: [], extra: [] }, stops: [], lines: [], patterns: [] };
}

/** GTFS time H:MM:SS to seconds of the service day (may exceed 86 400); NaN when empty. */
export function gtfsSeconds(t: string): number {
  if (!t) return NaN;
  const [h, m, s] = t.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s ?? 0);
}

interface StopInfo {
  code: string;
  name: string;
  p: Vec2;
  inside: boolean;
}

interface TripInfo {
  route: string;
  service: string;
  dir: number;
  headsign: string;
  shape: string;
}

interface StopTime {
  seq: number;
  stop: string;
  arr: number;
  dep: number;
}

/** Trips of one profile before the frame crossings are known: neighbours outside are kept as stop and time. */
interface RawProfile {
  t: number[];
  prev: { stop: string; t: number } | null;
  next: { stop: string; t: number } | null;
  starts: Map<string, Set<number>>;
}

interface PatternAcc {
  route: string;
  dir: number;
  stops: string[];
  enter: boolean;
  exit: boolean;
  headsigns: Map<string, number>;
  shapes: Map<string, number>;
  raw: Map<string, RawProfile>;
}

/**
 * Cuts a GTFS feed (file name → CSV text) to the frame: bus, trolleybus and tram lines, the in-frame stops
 * they serve, patterns with clipped shapes, and timetables grouped into profiles of equal relative times.
 */
export function importGtfs(files: Record<string, string>, bbox: BBoxDeg): DistrictTransit {
  const bounds = boundsOfBBox(bbox);

  const routes = new Map<string, Omit<DistrictLine, 'id'>>();
  eachRecord(files['routes.txt'], (get) => {
    const type = get('route_type');
    const name = toLatin(get('route_short_name'));
    const mode: TransitMode | null = type === '0' ? 'tram' : type === '11' ? 'trolley' : type === '3' ? (MINIBUS_LINES.includes(name) ? 'minibus' : 'bus') : null;
    if (!mode) return;
    routes.set(get('route_id'), {
      name,
      longName: toLatin(get('route_long_name')),
      mode,
      color: hex(get('route_color'), DEFAULT_COLOR),
      text: hex(get('route_text_color'), DEFAULT_TEXT),
    });
  });

  const trips = new Map<string, TripInfo>();
  eachRecord(files['trips.txt'], (get) => {
    const route = get('route_id');
    if (!routes.has(route)) return;
    trips.set(get('trip_id'), { route, service: get('service_id'), dir: Number(get('direction_id')) || 0, headsign: toLatin(get('trip_headsign')), shape: get('shape_id') });
  });

  const stops = new Map<string, StopInfo>();
  eachRecord(files['stops.txt'], (get) => {
    const p = project({ lat: Number(get('stop_lat')), lon: Number(get('stop_lon')) });
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
    stops.set(get('stop_id'), { code: get('stop_code'), name: toLatin(get('stop_name')), p, inside: pointInRect(p, bounds) });
  });

  // stop_times: one trip at a time, rows of a trip must be contiguous (they are in GTFS exports).
  const patterns = new Map<string, PatternAcc>();
  const seen = new Set<string>();
  let curTrip = '';
  let rows: StopTime[] = [];
  const flush = () => {
    const trip = trips.get(curTrip);
    if (trip && rows.length) addTrip(trip, rows, stops, patterns);
    rows = [];
  };
  eachRecord(files['stop_times.txt'], (get) => {
    const id = get('trip_id');
    if (id !== curTrip) {
      flush();
      if (seen.has(id)) throw new Error(`stop_times.txt: rows of trip ${id} are not contiguous`);
      seen.add(id);
      curTrip = id;
    }
    if (!trips.has(id)) return;
    const stop = get('stop_id');
    if (!stops.has(stop)) return;
    let arr = gtfsSeconds(get('arrival_time'));
    let dep = gtfsSeconds(get('departure_time'));
    if (Number.isNaN(arr)) arr = dep;
    if (Number.isNaN(dep)) dep = arr;
    if (Number.isNaN(arr)) return;
    rows.push({ seq: Number(get('stop_sequence')), stop, arr, dep });
  });
  flush();

  // Shapes: the most common one of each pattern.
  const chosen = new Map<PatternAcc, string>();
  for (const acc of patterns.values()) {
    const shape = mostCommon(acc.shapes);
    if (shape) chosen.set(acc, shape);
  }
  const needed = new Set(chosen.values());
  const rawShapes = new Map<string, [number, Vec2][]>();
  eachRecord(files['shapes.txt'], (get) => {
    const id = get('shape_id');
    if (!needed.has(id)) return;
    let list = rawShapes.get(id);
    if (!list) rawShapes.set(id, (list = []));
    list.push([Number(get('shape_pt_sequence')), project({ lat: Number(get('shape_pt_lat')), lon: Number(get('shape_pt_lon')) })]);
  });
  const shapes = new Map<string, Vec2[]>();
  for (const [id, list] of rawShapes) shapes.set(id, list.sort((a, b) => a[0] - b[0]).map(([, p]) => p));

  // Ordering: lines by route id, stops by stop id, patterns by line, direction and stops.
  const accs = [...patterns.values()];
  const lineIds = [...new Set(accs.map((a) => a.route))].sort(cmp);
  const lineIndex = new Map(lineIds.map((id, i) => [id, i]));
  const stopIds = [...new Set(accs.flatMap((a) => a.stops))].sort(cmp);
  const stopIndex = new Map(stopIds.map((id, i) => [id, i]));
  accs.sort((a, b) => lineIndex.get(a.route)! - lineIndex.get(b.route)! || a.dir - b.dir || cmp(a.stops.join(' '), b.stops.join(' ')) || +a.enter - +b.enter || +a.exit - +b.exit);

  const expanded: Rect = { x0: bounds.x0 - SHAPE_MARGIN, z0: bounds.z0 - SHAPE_MARGIN, x1: bounds.x1 + SHAPE_MARGIN, z1: bounds.z1 + SHAPE_MARGIN };
  const dirSum = new Map<string, Vec2>();
  const out: DistrictPattern[] = accs.map((acc) => {
    const pos = (id: string) => stops.get(id)!.p;
    const first = acc.raw.values().next().value!;
    const fallback = [...(first.prev ? [first.prev.stop] : []), ...acc.stops, ...(first.next ? [first.next.stop] : [])].map(pos);
    const line = polyline(dedupe(shapes.get(chosen.get(acc) ?? '') ?? fallback));
    const pts = line.points;
    const located = locateChain(line, acc.stops.map(pos));
    const dFirst = located[0]!.along;
    const dLast = located[located.length - 1]!.along;

    acc.stops.forEach((id, i) => {
      const s = located[i]!.seg;
      const a = pts[s]!;
      const b = pts[Math.min(s + 1, pts.length - 1)]!;
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      if (l < 1e-9) return;
      const sum = dirSum.get(id) ?? { x: 0, z: 0 };
      dirSum.set(id, { x: sum.x + (b.x - a.x) / l, z: sum.z + (b.z - a.z) / l });
    });

    const profiles = new Map<string, { p: Omit<DistrictProfile, 'starts'>; starts: Map<string, Set<number>> }>();
    for (const raw of acc.raw.values()) {
      const p: Omit<DistrictProfile, 'starts'> = { t: raw.t };
      if (raw.prev) {
        const dOut = locateOne(line, pos(raw.prev.stop), -Infinity, dFirst);
        const cross = rectCrossings(line, dOut, dFirst, bounds).filter((c) => c.inward);
        const f = fraction(cross.length ? cross[cross.length - 1]!.d : dOut, dOut, dFirst);
        p.enter = Math.round(raw.prev.t + (raw.t[0]! - raw.prev.t) * f);
      }
      if (raw.next) {
        const dNext = locateOne(line, pos(raw.next.stop), dLast, Infinity);
        const cross = rectCrossings(line, dLast, dNext, bounds).filter((c) => !c.inward);
        const tLast = raw.t[raw.t.length - 1]!;
        p.exit = Math.round(tLast + (raw.next.t - tLast) * fraction(cross.length ? cross[0]!.d : dNext, dLast, dNext));
      }
      const key = `${p.t.join(',')}|${p.enter ?? ''}|${p.exit ?? ''}`;
      let prof = profiles.get(key);
      if (!prof) profiles.set(key, (prof = { p, starts: new Map() }));
      for (const [service, set] of raw.starts) {
        let into = prof.starts.get(service);
        if (!into) prof.starts.set(service, (into = new Set()));
        for (const s of set) into.add(s);
      }
    }

    const ins = rectCrossings(line, 0, dFirst, expanded).filter((c) => c.inward);
    const outs = rectCrossings(line, dLast, line.length, expanded).filter((c) => !c.inward);
    const cut = slicePolyline(line, ins.length ? ins[ins.length - 1]!.d : 0, outs.length ? outs[0]!.d : line.length);

    return {
      line: lineIndex.get(acc.route)!,
      dir: acc.dir,
      headsign: mostCommon(acc.headsigns) ?? '',
      stops: acc.stops.map((id) => stopIndex.get(id)!),
      shape: simplifyChain(cut, SHAPE_SIMPLIFY).flatMap((q) => [round1(q.x), round1(q.z)]),
      enter: acc.enter,
      exit: acc.exit,
      profiles: [...profiles.values()]
        .map(({ p, starts }) => ({ min: Math.min(...[...starts.values()].flatMap((s) => [...s])), key: p.t.join(','), prof: { ...p, starts: encodeStarts(starts) } }))
        .sort((a, b) => a.min - b.min || cmp(a.key, b.key))
        .map((x) => x.prof),
    };
  });

  const outStops: DistrictStop[] = stopIds.map((id) => {
    const s = stops.get(id)!;
    const d = dirSum.get(id) ?? { x: 0, z: 0 };
    const l = Math.hypot(d.x, d.z);
    const dir: [number, number] = l > 1e-9 ? [round2(d.x / l), round2(d.z / l)] : [0, 0];
    return { id, code: s.code, name: s.name, x: round1(s.p.x), z: round1(s.p.z), dir };
  });

  return {
    feed: readFeed(files['feed_info.txt']),
    calendar: readCalendar(files['calendar.txt'], files['calendar_dates.txt']),
    stops: outStops,
    lines: lineIds.map((id) => ({ id, ...routes.get(id)! })),
    patterns: out,
  };
}

/** Adds one trip (its kept stop_times rows) to its pattern and raw profile. */
function addTrip(trip: TripInfo, rows: StopTime[], stops: Map<string, StopInfo>, patterns: Map<string, PatternAcc>): void {
  rows.sort((a, b) => a.seq - b.seq);
  let fi = -1;
  let li = -1;
  rows.forEach((r, i) => {
    if (!stops.get(r.stop)!.inside) return;
    if (fi < 0) fi = i;
    li = i;
  });
  if (fi < 0) return;
  const inside = rows.slice(fi, li + 1).filter((r) => stops.get(r.stop)!.inside);
  const dep0 = rows[fi]!.dep;
  const enter = fi > 0;
  const exit = li < rows.length - 1;
  const ids = inside.map((r) => r.stop);
  const key = `${trip.route}|${trip.dir}|${ids.join(' ')}|${+enter}|${+exit}`;
  let acc = patterns.get(key);
  if (!acc) {
    acc = { route: trip.route, dir: trip.dir, stops: ids, enter, exit, headsigns: new Map(), shapes: new Map(), raw: new Map() };
    patterns.set(key, acc);
  }
  bump(acc.headsigns, trip.headsign);
  if (trip.shape) bump(acc.shapes, trip.shape);

  const t = inside.flatMap((r) => [r.arr - dep0, r.dep - dep0]);
  const prev = enter ? { stop: rows[fi - 1]!.stop, t: rows[fi - 1]!.dep - dep0 } : null;
  const next = exit ? { stop: rows[li + 1]!.stop, t: rows[li + 1]!.arr - dep0 } : null;
  const rawKey = `${t.join(',')}|${prev ? `${prev.stop}@${prev.t}` : ''}|${next ? `${next.stop}@${next.t}` : ''}`;
  let raw = acc.raw.get(rawKey);
  if (!raw) acc.raw.set(rawKey, (raw = { t, prev, next, starts: new Map() }));
  let set = raw.starts.get(trip.service);
  if (!set) raw.starts.set(trip.service, (set = new Set()));
  set.add(dep0);
}

function readFeed(text: string | undefined): DistrictTransit['feed'] {
  let feed: DistrictTransit['feed'] = null;
  eachRecord(text, (get) => {
    feed ??= { version: get('feed_version') || 'unknown', start: get('feed_start_date'), end: get('feed_end_date') };
  });
  return feed ?? { version: 'unknown', start: '', end: '' };
}

/** Weekday services from calendar.txt (first listed wins) and added dates from calendar_dates.txt. */
function readCalendar(calendar: string | undefined, dates: string | undefined): TransitCalendar {
  const week: string[] = [];
  eachRecord(calendar, (get) => {
    DAYS.forEach((day, i) => {
      if (get(day) === '1' && !week[i]) week[i] = get('service_id');
    });
  });
  const extra: [string, string][] = [];
  eachRecord(dates, (get) => {
    if (get('exception_type') === '1') extra.push([get('date'), get('service_id')]);
  });
  extra.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  return { week: week.length ? Array.from({ length: 7 }, (_, i) => week[i] ?? '') : [], extra };
}

function encodeStarts(starts: Map<string, Set<number>>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const service of [...starts.keys()].sort(cmp)) {
    const sorted = [...starts.get(service)!].sort((a, b) => a - b);
    out[service] = sorted.map((s, i) => (i ? s - sorted[i - 1]! : s));
  }
  return out;
}

function dedupe(pts: Vec2[]): Vec2[] {
  const out = pts.filter((p, i) => i === 0 || p.x !== pts[i - 1]!.x || p.z !== pts[i - 1]!.z);
  return out.length ? out : [{ x: 0, z: 0 }];
}

const fraction = (d: number, a: number, b: number) => (b - a > 1e-9 ? Math.max(0, Math.min(1, (d - a) / (b - a))) : 0);
const round1 = (v: number) => Math.round(v * 10) / 10 + 0;
const round2 = (v: number) => Math.round(v * 100) / 100 + 0;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const hex = (c: string, fallback: string) => (/^[0-9a-f]{6}$/i.test(c) ? `#${c.toUpperCase()}` : fallback);

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

/** Most frequent key, ties broken by the smaller key. */
function mostCommon(m: Map<string, number>): string | undefined {
  let best: string | undefined;
  for (const [k, n] of m) if (best === undefined || n > m.get(best)! || (n === m.get(best)! && k < best)) best = k;
  return best;
}
