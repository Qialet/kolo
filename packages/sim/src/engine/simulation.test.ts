import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { District } from '../city/district.js';
import { buildCityFromDistrict } from '../city/district-build.js';
import { Simulation, type FleetVehicleSeed } from './simulation.js';

function fleet(n: number): FleetVehicleSeed[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `T${i + 1}`,
    plate: `BG ${100 + i}-TX`,
    model: 'Škoda Octavia',
    parkId: ['P1', 'P2', 'P3'][i % 3]!,
    parkName: 'Park',
    fleetStatus: i < n * 0.8 ? 'ON_LINE' : i < n * 0.95 ? 'IN_PARK' : 'MAINTENANCE',
    driverName: 'Test Driver',
    driverRating: 4.8,
  }));
}

const REAL = new URL('../../../../data/districts/belgrade-center.json', import.meta.url);
const city = buildCityFromDistrict(JSON.parse(readFileSync(REAL, 'utf8')) as District);
const buildCity = () => city;
/** Thursday 22 Oct 2026, 15:30 in Belgrade: the timetable runs at full weekday strength. */
const AFTERNOON = Date.UTC(2026, 9, 22, 13, 30);

describe('Simulation', () => {
  it('runs fifteen minutes of city life without collisions, NaNs or gridlock', () => {
    const city = buildCity();
    const events: string[] = [];
    expect(city.busStops.length).toBeGreaterThan(100);
    const sim = new Simulation(city, fleet(60), { startAt: AFTERNOON, hooks: { onOrderEvent: (_o, e) => events.push(e.type) } });
    let overlaps = 0;
    let checks = 0;
    for (let i = 0; i < 900 * 20; i++) {
      sim.step(0.05);
      if (i % 100 !== 0) continue;
      const byLane = new Map<number, { s: number; len: number }[]>();
      for (const v of sim.traffic.vehicles) {
        expect(Number.isFinite(v.pose.x) && Number.isFinite(v.pose.z)).toBe(true);
        if (v.mode !== 'lane') continue;
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
    const kpi = sim.kpi();
    const stuck = sim.traffic.vehicles.filter((v) => (v.mode === 'lane' || v.mode === 'conn') && v.stoppedFor > sim.traffic.waitLimit(v));
    expect(stuck.map((v) => v.id)).toEqual([]);
    expect(overlaps / Math.max(1, checks)).toBeLessThan(0.002);
    expect(kpi.avgSpeedKmh).toBeGreaterThan(8);
    expect(kpi.congestion).toBeLessThan(0.5);
    expect(events).toContain('CREATED');
    expect(events).toContain('PICKED_UP');
    expect(kpi.orders.completed).toBeGreaterThan(5);
    const frame = sim.frame();
    expect(frame.vehicles.length).toBeGreaterThan(200);
  });

  it('prices orders by road distance and reports trip progress along the driven route', () => {
    const city = buildCity();
    let completedMeters = 0;
    const sim = new Simulation(city, fleet(8), {
      startAt: AFTERNOON,
      trafficDensity: 0.2,
      demand: 0,
      hooks: { onOrderEvent: (o, e) => e.type === 'COMPLETED' && (completedMeters = o.distanceMeters) },
    });
    const pickup = city.addresses[5]!;
    const dropoff = [...city.addresses].sort((a, b) => Math.hypot(b.x - pickup.x, b.z - pickup.z) - Math.hypot(a.x - pickup.x, a.z - pickup.z))[40]!;
    const order = sim.createOrder({ pickupId: pickup.id, dropoffId: dropoff.id })!;
    const straight = Math.hypot(dropoff.x - pickup.x, dropoff.z - pickup.z);
    expect(order.distanceMeters).toBeGreaterThan(straight);
    expect(order.distanceMeters).toBeLessThan(straight * 2);

    const progress: number[] = [];
    for (let i = 0; i < 20 * 900 && !completedMeters; i++) {
      // This passenger never changes their mind: a random cancellation is not what the test is about.
      const live = sim.orders.get(order.id);
      if (live) live.cancelAt = 0;
      sim.step(0.05);
      if (i % 20 !== 0) continue;
      const taxi = sim.orders.get(order.id)?.vehicleId;
      const detail = taxi ? sim.taxiDetail(taxi) : null;
      if (detail?.activity === 'ON_TRIP' && detail.route.length) progress.push(detail.progress);
    }
    expect(completedMeters).toBeGreaterThan(0);
    expect(progress.length).toBeGreaterThan(10);
    expect(progress[0]!).toBeLessThan(0.1);
    expect(progress[progress.length - 1]!).toBeGreaterThan(0.85);
    for (let k = 1; k < progress.length; k++) expect(progress[k]!).toBeGreaterThanOrEqual(progress[k - 1]! - 0.02);
    // The planned road distance matches what the taxi actually drove.
    expect(Math.abs(completedMeters - order.distanceMeters) / order.distanceMeters).toBeLessThan(0.2);
  });

  it('sends a taxi to the service box and back on line on admin command', () => {
    const city = buildCity();
    const sim = new Simulation(city, fleet(6), { startAt: AFTERNOON, trafficDensity: 0.2, demand: 0 });
    sim.setFleetStatus('T1', 'MAINTENANCE');
    let reached = false;
    for (let i = 0; i < 20 * 900 && !reached; i++) {
      sim.step(0.05);
      reached = sim.taxiDetail('T1')!.activity === 'IN_SERVICE';
    }
    expect(reached).toBe(true);
    sim.setFleetStatus('T1', 'ON_LINE');
    let back = false;
    for (let i = 0; i < 20 * 120 && !back; i++) {
      sim.step(0.05);
      back = sim.taxiDetail('T1')!.activity === 'FREE';
    }
    expect(back).toBe(true);
  });

  it('takes orders from bus stops in the core network', () => {
    const city = buildCity();
    const pickups: string[] = [];
    const sim = new Simulation(city, fleet(20), { startAt: AFTERNOON, trafficDensity: 0.1, demand: 40, hooks: { onOrderCreated: (o, src) => src === 'BUS_STOP' && pickups.push(o.pickup.addressId) } });
    for (let i = 0; i < 20 * 120; i++) sim.step(0.05);
    expect(pickups.length).toBeGreaterThan(5);
    const stopIds = new Set(city.busStops.map((s) => s.id));
    for (const id of pickups) {
      expect(stopIds.has(id)).toBe(true);
      const place = sim.place(id)!;
      const seg = city.segments[city.lanes[place.lane]!.seg]!;
      expect(seg.core && !seg.psvOnly && seg.layer === 0).toBe(true);
    }
  });

  it('keeps the server step within a third of the 50 ms tick at the morning peak', () => {
    /** Thursday 22 Oct 2026, 08:00 in Belgrade. */
    const sim = new Simulation(buildCity(), fleet(60), { startAt: Date.UTC(2026, 9, 22, 6, 0) });
    const steps: number[] = [];
    let frameBytes = 0;
    let blinking = 0;
    let both = 0;
    for (let i = 0; i < 120 * 20; i++) {
      // Wall time: process.cpuUsage ticks in 15.6 ms quanta on Windows; the budget leaves room for busy cores.
      const t0 = performance.now();
      sim.tick(0.05);
      steps.push(performance.now() - t0);
      if (i % 20 === 0) {
        const frame = sim.frame();
        frameBytes = Math.max(frameBytes, JSON.stringify(frame).length);
        // Turn signals: bit 4 left, bit 5 right, never both.
        for (const t of frame.vehicles) {
          if (t[7] & 48) blinking++;
          if ((t[7] & 48) === 48) both++;
        }
      }
    }
    steps.sort((a, b) => a - b);
    expect(steps[Math.floor(steps.length * 0.99)]).toBeLessThan(16);
    expect(frameBytes).toBeLessThan(32 * 1024);
    expect(blinking).toBeGreaterThan(100);
    expect(both).toBe(0);
  });
});

describe('weighted demand', () => {
  /** Pick-up, drop-off and source of every order created in three minutes. */
  function orders(seed: number) {
    const list: string[] = [];
    const sim = new Simulation(city, fleet(20), {
      seed,
      startAt: AFTERNOON,
      demand: 6,
      hooks: { onOrderCreated: (o, source) => list.push(`${o.pickup.addressId}>${o.dropoff.addressId}:${source}`) },
    });
    for (let i = 0; i < 180 * 20; i++) sim.step(0.05);
    return { list, sim };
  }

  it('creates the same orders from the same seed and other orders from another', () => {
    const a = orders(11);
    const b = orders(11);
    expect(a.list.length).toBeGreaterThan(30);
    expect(b.list).toEqual(a.list);
    expect(orders(12).list).not.toEqual(a.list);
    const stopIds = new Set(city.busStops.map((s) => s.id));
    for (const o of a.list) expect(o.endsWith(':BUS_STOP')).toBe(stopIds.has(o.split('>')[0]!));
  });

  it('keeps free taxis on duty at the busiest places', () => {
    const sim = new Simulation(city, fleet(60), { startAt: AFTERNOON });
    const spots = new Set(sim.demandPoints.spots().map((s) => s.id));
    for (let i = 0; i < 120 * 20; i++) sim.step(0.05);
    const free = [...sim.taxis.values()].filter((t) => t.activity === 'FREE' && t.target);
    expect(free.length).toBeGreaterThan(5);
    for (const t of free) expect(spots.has(t.target!.id)).toBe(true);
  });
});
