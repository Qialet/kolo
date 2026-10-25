import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isTransitKind } from '@kolo/contracts';
import type { District } from '../city/district.js';
import { buildCityFromDistrict } from '../city/district-build.js';
import { stopPickup } from '../city/transit-places.js';
import { twinPos } from '../city/corridors.js';
import { createRng } from '../rng.js';
import { cycleOf } from './signals.js';
import { Simulation, type FleetVehicleSeed } from './simulation.js';
import { makeVehicle, TrafficSystem, type Vehicle } from './traffic.js';
import { serviceEpoch, Transit } from './transit.js';
import { buildTransitNet } from './transit-net.js';

/** Processor time of this test process in ms: unlike the wall clock it does not grow when other test processes compete for the CPU. */
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

const REAL = new URL('../../../../data/districts/belgrade-center.json', import.meta.url);
const city = buildCityFromDistrict(JSON.parse(readFileSync(REAL, 'utf8')) as District);
const net = buildTransitNet(city, city.transit);

/** Thursday 22 Oct 2026, 15:30 in Belgrade (CEST). */
const WEEKDAY_1530 = Date.UTC(2026, 9, 22, 13, 30);

function fleet(n: number): FleetVehicleSeed[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `T${i + 1}`,
    plate: `BG ${100 + i}-TX`,
    model: 'Škoda Octavia',
    parkId: ['P1', 'P2', 'P3'][i % 3]!,
    parkName: 'Park',
    fleetStatus: i < n * 0.8 ? 'ON_LINE' : 'IN_PARK',
    driverName: 'Test Driver',
    driverRating: 4.8,
  }));
}

const transitVehicles = (sim: Simulation) => sim.traffic.vehicles.filter((v) => isTransitKind(v.kind));
const trams = (sim: Simulation) => sim.traffic.vehicles.filter((v) => v.kind === 'TRAM');
const isRail = (lane: number) => !!city.segments[city.lanes[lane]!.seg]!.rail;
/** Standing or driving in a lane (a tram at its stop stands in its lane too). */
const inLane = (v: Vehicle) => v.mode === 'lane' || (v.mode === 'pulled' && v.pullOffset === 0);

/** Standing where its body lies over a lane cars share. */
const onTwin = (v: Vehicle) => (city.lanes[v.lane]!.twins ?? []).some((t) => v.s >= t.s0 && v.s - v.length <= t.s1);

/** Pairs of vehicles on two lanes lying on top of each other whose bodies overlap there (and pairs checked). */
function twinOverlaps(sim: Simulation): { overlaps: number; checks: number } {
  const byLane = new Map<number, Vehicle[]>();
  for (const v of sim.traffic.vehicles) if (inLane(v)) byLane.set(v.lane, [...(byLane.get(v.lane) ?? []), v]);
  let overlaps = 0;
  let checks = 0;
  for (const [lane, list] of byLane) {
    if (!isRail(lane)) continue;
    for (const t of city.lanes[lane]!.twins ?? []) {
      for (const tram of list) {
        if (tram.s < t.s0 || tram.s - tram.length > t.s1) continue;
        const front = twinPos(t, tram.s);
        const back = twinPos(t, tram.s - tram.length);
        for (const car of byLane.get(t.lane) ?? []) {
          checks++;
          if (car.s - car.length < front - 0.5 && car.s > back + 0.5) overlaps++;
        }
      }
    }
  }
  return { overlaps, checks };
}

describe('timetable transit', () => {
  it('runs a weekday afternoon on the timetable', () => {
    const sim = new Simulation(city, fleet(30), { startAt: WEEKDAY_1530, demand: 0.5 });
    expect(sim.clock).toBe(WEEKDAY_1530);
    let overlaps = 0;
    let checks = 0;
    let ms = 0;
    let maxTrams = 0;
    let maxSharedDwell = 0;
    for (let i = 0; i < 600 * 20; i++) {
      const t0 = cpuMs();
      sim.step(0.05);
      ms += cpuMs() - t0;
      if (i % 100 !== 0) continue;
      const shared = twinOverlaps(sim);
      overlaps += shared.overlaps;
      checks += shared.checks;
      maxTrams = Math.max(maxTrams, trams(sim).length);
      // An early tram does not wait for its time on a lane cars share: it would hold the street up.
      for (const trip of sim.transit.trips.values()) {
        const v = trip.v;
        if (v.kind !== 'TRAM' || trip.phase !== 'dwell' || !onTwin(v)) continue;
        maxSharedDwell = Math.max(maxSharedDwell, trip.dwellUntil - sim.clock);
      }
      const byLane = new Map<number, { s: number; len: number }[]>();
      for (const v of sim.traffic.vehicles) {
        expect(Number.isFinite(v.pose.x) && Number.isFinite(v.pose.z), v.id).toBe(true);
        if (isTransitKind(v.kind) && (v.mode === 'lane' || v.mode === 'conn')) expect(v.stoppedFor, v.id).toBeLessThan(180);
        if (v.kind === 'TRAM') {
          const lanes = v.mode === 'conn' ? [sim.traffic.city.connectors[v.conn]!.from, sim.traffic.city.connectors[v.conn]!.to] : [v.lane];
          for (const l of lanes) expect(isRail(l), v.id).toBe(true);
          // At a red light a tram waits at most one cycle and a half minute.
          if (v.mode === 'lane') {
            const lane = city.lanes[v.lane]!;
            const node = city.nodes[city.segments[lane.seg]!.to]!;
            if (node.signal && lane.length - v.s < 10) expect(v.stoppedFor, v.id).toBeLessThanOrEqual(cycleOf(node.signal) + 30);
          }
        }
        // Nobody waits past the limit anywhere (a cycle and a half minute when first at a red light).
        if (v.mode === 'lane' || v.mode === 'conn') expect(v.stoppedFor, v.id).toBeLessThanOrEqual(sim.traffic.waitLimit(v));
        // Nobody is stuck on a lane shared with a track.
        if (v.mode === 'lane' && city.lanes[v.lane]!.twins) expect(v.stoppedFor, v.id).toBeLessThan(120);
        if (!inLane(v)) continue;
        const list = byLane.get(v.lane) ?? [];
        list.push({ s: v.s, len: v.length });
        byLane.set(v.lane, list);
      }
      for (const list of byLane.values()) {
        list.sort((a, b) => a.s - b.s);
        for (let k = 1; k < list.length; k++) {
          checks++;
          if (list[k]!.s - list[k]!.len < list[k - 1]!.s - 0.5) overlaps++;
        }
      }
    }
    expect(maxSharedDwell).toBeLessThanOrEqual(30_000);
    expect(sim.clock).toBe(WEEKDAY_1530 + 600_000);
    expect(transitVehicles(sim).length).toBeGreaterThanOrEqual(100);
    const { servedStops, missedStops, byMode } = sim.transit.stats;
    expect(servedStops / (servedStops + missedStops)).toBeGreaterThanOrEqual(0.9);
    expect(byMode.tram.served / (byMode.tram.served + byMode.tram.missed)).toBeGreaterThanOrEqual(0.85);
    expect(maxTrams).toBeGreaterThanOrEqual(20);
    expect(overlaps / Math.max(1, checks)).toBeLessThan(0.002);
    expect(ms).toBeLessThan(7000);
    // Trolleybuses, minibuses and trams run as their own kinds; trams are CAF and Tatra.
    expect(new Set(transitVehicles(sim).map((v) => v.kind))).toEqual(new Set(['BUS', 'TROLLEY', 'MINIBUS', 'TRAM']));
    expect(new Set(trams(sim).map((v) => v.length))).toEqual(new Set([19, 33]));
    expect(transitVehicles(sim).every((v) => /^B\d+$/.test(v.id))).toBe(true);
  });

  it('is nearly empty at three in the morning', () => {
    const sim = new Simulation(city, fleet(4), { startAt: Date.UTC(2026, 9, 22, 1, 0) });
    for (let i = 0; i < 60 * 20; i++) sim.step(0.05);
    expect(transitVehicles(sim).length).toBeLessThan(20);
  });

  it('runs the Sunday night service past midnight into Monday', () => {
    // 00:30 on Monday 26 Oct 2026 (CET, the day after the clocks went back).
    const sim = new Simulation(city, fleet(4), { startAt: Date.UTC(2026, 9, 25, 23, 30) });
    const trips = [...sim.transit.trips.values()];
    expect(trips.some((t) => t.date === '20261025' && t.service === 'N')).toBe(true);
  });

  it('runs the Sunday service on a public holiday', () => {
    const sim = new Simulation(city, fleet(4), { startAt: Date.UTC(2026, 10, 11, 14, 30) });
    const trips = [...sim.transit.trips.values()];
    expect(trips.length).toBeGreaterThan(20);
    expect(trips.every((t) => t.service === 'N')).toBe(true);
  });

  it('pulls buses into bays and keeps them in their lane elsewhere, one per bay', () => {
    const traffic = new TrafficSystem(city);
    const transit = new Transit(traffic, net, createRng(9));
    transit.rebuild(WEEKDAY_1530);
    let inBay = 0;
    let inLane = 0;
    for (let ms = WEEKDAY_1530; ms < WEEKDAY_1530 + 600_000; ms += 50) {
      traffic.step(0.05);
      transit.step(ms);
      if ((ms - WEEKDAY_1530) % 1000) continue;
      transit.update(ms);
      const bays = new Map<number, Vehicle[]>();
      for (const trip of transit.trips.values()) {
        const v = trip.v;
        if (trip.phase !== 'dwell' || v.mode !== 'pulled' || v.kind === 'TRAM') continue;
        const stop = trip.pattern.stops[trip.next - 1]!;
        if (v.pullOffset > 0) {
          inBay++;
          expect(stop.bay, v.id).toBe(true);
          bays.set(v.lane, [...(bays.get(v.lane) ?? []), v]);
        } else inLane++;
      }
      for (const list of bays.values()) {
        list.sort((a, b) => a.s - b.s);
        for (let k = 1; k < list.length; k++) expect(list[k]!.s - list[k]!.length, list[k]!.id).toBeGreaterThan(list[k - 1]!.s);
      }
    }
    // Both kinds of stop are busy at a weekday afternoon.
    expect(inBay).toBeGreaterThan(500);
    expect(inLane).toBeGreaterThan(500);
  });

  it('holds a trip at a blocked frame entry, then gives it up after 120 s', () => {
    const traffic = new TrafficSystem(city);
    const transit = new Transit(traffic, net, createRng(3));
    const at = WEEKDAY_1530;
    transit.rebuild(at);
    // The next trip entering through the frame after a minute.
    const next = transit.tripsBetween(at + 60_000, at + 600_000).find((t) => t.pattern.entryLane >= 0)!;
    expect(next).toBeDefined();
    const blocker = makeVehicle('X1', 'CAR', createRng(1));
    traffic.placeOnLane(blocker, next.pattern.entryLane, 5);
    traffic.add(blocker);
    const spawned = () => [...transit.trips.values()].some((t) => t.key === next.key);
    for (let ms = at; ms <= next.spawnAt + 60_000; ms += 1000) transit.update(ms);
    expect(spawned()).toBe(false);
    traffic.remove(blocker);
    transit.update(next.spawnAt + 61_000);
    expect(spawned()).toBe(true);

    const traffic2 = new TrafficSystem(city);
    const transit2 = new Transit(traffic2, net, createRng(3));
    transit2.rebuild(at);
    traffic2.placeOnLane(blocker, next.pattern.entryLane, 5);
    traffic2.add(blocker);
    const missed = transit2.stats.missedTrips;
    for (let ms = at; ms <= next.spawnAt + 125_000; ms += 1000) transit2.update(ms);
    traffic2.remove(blocker);
    transit2.update(next.spawnAt + 126_000);
    expect([...transit2.trips.values()].some((t) => t.key === next.key)).toBe(false);
    expect(transit2.stats.missedTrips).toBeGreaterThan(missed);
  });

  it('puts the buses back on the timetable when the clock is synced after running fast', () => {
    const sim = new Simulation(city, fleet(20), { startAt: WEEKDAY_1530 });
    for (let i = 0; i < 300 * 20; i++) sim.step(0.05);
    const taxis = [...sim.taxis.keys()];
    const orders = [...sim.orders.keys()];
    const wall = WEEKDAY_1530 + 75_000;
    sim.syncClock(wall);
    expect(sim.clock).toBe(wall);
    const fresh = new Simulation(city, fleet(20), { startAt: wall });
    const n = transitVehicles(sim).length;
    const m = transitVehicles(fresh).length;
    expect(Math.abs(n - m) / m).toBeLessThanOrEqual(0.15);
    const ids = transitVehicles(sim).map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(trams(sim).length).toBeGreaterThan(0);
    expect(Math.abs(trams(sim).length - trams(fresh).length) / trams(fresh).length).toBeLessThanOrEqual(0.15);
    for (const v of trams(sim)) expect(isRail(v.lane), v.id).toBe(true);
    expect(twinOverlaps(sim).overlaps).toBe(0);
    expect([...sim.taxis.keys()]).toEqual(taxis);
    expect([...sim.orders.keys()]).toEqual(orders);
    // Nothing stands on top of anything after the rebuild.
    const byLane = new Map<number, number[]>();
    for (const v of transitVehicles(sim)) if (v.mode === 'lane' || v.mode === 'pulled') byLane.set(v.lane, [...(byLane.get(v.lane) ?? []), v.s]);
    for (const list of byLane.values()) {
      list.sort((a, b) => a - b);
      for (let k = 1; k < list.length; k++) expect(list[k]! - list[k - 1]!).toBeGreaterThan(7);
    }
    // Long trams included: no body reaches into the one behind.
    const bodies = new Map<number, Vehicle[]>();
    for (const v of transitVehicles(sim)) if (inLane(v)) bodies.set(v.lane, [...(bodies.get(v.lane) ?? []), v]);
    for (const list of bodies.values()) {
      list.sort((a, b) => a.s - b.s);
      for (let k = 1; k < list.length; k++) expect(list[k]!.s - list[k]!.length, list[k]!.id).toBeGreaterThanOrEqual(list[k - 1]!.s - 0.5);
    }
  });

  it('counts service seconds from noon minus twelve hours across clock changes', () => {
    // 25 Oct 2026 is 25 hours long in Belgrade and 29 Mar 23: noon sets the offset for the whole service day.
    expect(serviceEpoch('20261022', 0)).toBe(Date.UTC(2026, 9, 21, 22, 0));
    expect(serviceEpoch('20261025', 12 * 3600)).toBe(Date.UTC(2026, 9, 25, 11, 0));
    expect(serviceEpoch('20261025', 25 * 3600)).toBe(Date.UTC(2026, 9, 26, 0, 0));
    expect(serviceEpoch('20260329', 12 * 3600)).toBe(Date.UTC(2026, 2, 29, 10, 0));
  });
});

describe('transit details for the console', () => {
  const sim = new Simulation(city, fleet(4), { startAt: WEEKDAY_1530 });
  for (let i = 0; i < 30 * 20; i++) sim.step(0.05);

  it('puts the Belgrade clock into every frame and syncs it on command', () => {
    expect(sim.frame().clock).toBe(sim.clock);
    const fast = new Simulation(city, fleet(2), { startAt: Date.now() - 3_600_000 });
    fast.control({ sync: true });
    expect(Math.abs(fast.clock - Date.now())).toBeLessThan(2000);
  });

  it('describes a bus on its line', () => {
    const trip = [...sim.transit.trips.values()].find((t) => t.phase === 'drive' && t.next < t.pattern.stops.length)!;
    const d = sim.busDetail(trip.id)!;
    const line = city.busLines[trip.pattern.line]!;
    expect(d.lineId).toBe(line.id);
    expect(d.lineName).toBe(line.name);
    expect(d.color).toBe(line.color);
    expect(d.kind).toBe(trip.v.kind);
    expect(d.headsign).toBe(trip.pattern.headsign);
    expect(d.delaySec).toBe(trip.delaySec);
    expect(d.nextStop).toBe(city.busStops[trip.pattern.stops[trip.next]!.stop]!.name);
    expect(d.nextStopAt).toBeGreaterThan(sim.clock - 600_000);
    expect(sim.busDetail('nope')).toBeNull();
  });

  it('gives the length of the vehicle, telling a CAF tram from a Tatra', () => {
    const lengths = trams(sim).map((v) => sim.busDetail(v.id)!.length);
    expect(new Set(lengths)).toEqual(new Set([19, 33]));
    const bus = transitVehicles(sim).find((v) => v.kind === 'BUS')!;
    expect(sim.busDetail(bus.id)!.length).toBe(bus.length);
  });

  it('lists the next departures at a stop', () => {
    const busy = [...city.busStops].sort((a, b) => b.lines.length - a.lines.length)[0]!;
    const d = sim.stopDetail(busy.id)!;
    expect(d.name).toBe(busy.name);
    expect(d.code).toBe(busy.code);
    expect(d.lines.length).toBe(busy.lines.length);
    expect(d.departures.length).toBeGreaterThan(0);
    expect(d.departures.length).toBeLessThanOrEqual(8);
    let prev = 0;
    for (const dep of d.departures) {
      expect(dep.expectedAt).toBeGreaterThanOrEqual(prev);
      expect(dep.expectedAt).toBeGreaterThanOrEqual(sim.clock - 1000);
      expect(dep.expectedAt).toBeLessThanOrEqual(sim.clock + 3_600_000 + 600_000);
      expect(busy.lines).toContain(dep.lineId);
      if (dep.vehicleId) expect(sim.transit.byVehicle.has(dep.vehicleId)).toBe(true);
      prev = dep.expectedAt;
    }
    expect(d.departures.some((x) => x.vehicleId)).toBe(true);
    expect(sim.stopDetail('nope')).toBeNull();
  });

  it('offers a taxi pick-up only at stops taxis can reach', () => {
    const flags = city.busStops.map((st) => sim.stopDetail(st.id)!.pickup);
    expect(flags.filter(Boolean).length).toBeGreaterThan(50);
    expect(flags.some((x) => !x)).toBe(true);
    city.busStops.forEach((st, i) => {
      expect(flags[i]).toBe(sim.place(st.id) !== undefined);
      expect(stopPickup(city, st)).toBe(flags[i]);
    });
  });

  it('lists only trips that leave a terminus, not those ending there', () => {
    let checked = 0;
    for (const stop of city.busStops) {
      const d = sim.stopDetail(stop.id)!;
      for (const dep of d.departures) {
        if (!dep.vehicleId) continue;
        const trip = sim.transit.byVehicle.get(dep.vehicleId)!;
        const k = trip.pattern.stops.findIndex((st) => city.busStops[st.stop]!.id === stop.id);
        expect(k < trip.pattern.stops.length - 1 || trip.pattern.exitSeg >= 0, `${stop.name} ${dep.vehicleId}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('names the terminus of a bus standing at its last stop', () => {
    const run = new Simulation(city, fleet(2), { startAt: WEEKDAY_1530 });
    let found = false;
    for (let i = 0; i < 120 * 20 && !found; i++) {
      run.step(0.05);
      if (i % 20) continue;
      const trip = [...run.transit.trips.values()].find((t) => t.phase === 'dwell' && t.next >= t.pattern.stops.length);
      if (!trip) continue;
      const d = run.busDetail(trip.id)!;
      expect(d.nextStop).toBe(city.busStops[trip.pattern.stops[trip.pattern.stops.length - 1]!.stop]!.name);
      expect(d.nextStopAt).toBeNull();
      found = true;
    }
    expect(found).toBe(true);
  });

  it('describes a line by direction', () => {
    const id = city.busLines.find((l) => l.name === '26')!.id;
    const d = sim.lineDetail(id)!;
    expect(d.name).toBe('26');
    expect(d.directions.length).toBe(2);
    for (const dir of d.directions) {
      expect(dir.stops.length).toBeGreaterThan(1);
      expect(dir.route.length).toBeGreaterThan(10);
      expect(dir.headwayMin).toBeGreaterThan(0);
      expect(dir.headwayMin).toBeLessThan(30);
      expect(dir.nextDepartureAt).toBeGreaterThanOrEqual(sim.clock - 1000);
    }
    expect(d.vehicles.length).toBeGreaterThan(0);
    for (const v of d.vehicles) expect(sim.transit.byVehicle.get(v.id)?.pattern.line).toBe(city.busLines.findIndex((l) => l.id === id));
    expect(sim.lineDetail('nope')).toBeNull();
  });
});
