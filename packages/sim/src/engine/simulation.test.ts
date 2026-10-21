import { describe, expect, it } from 'vitest';
import { buildCity } from '../city/build.js';
import { Simulation, type FleetVehicleSeed } from './simulation.js';

function fleet(n: number): FleetVehicleSeed[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `T${i + 1}`,
    plate: `BG ${100 + i}-TX`,
    model: 'Škoda Octavia',
    parkId: ['P1', 'P2', 'P3'][i % 3]!,
    parkName: 'Park',
    fleetStatus: i < n - 4 ? 'ON_LINE' : i < n - 1 ? 'IN_PARK' : 'MAINTENANCE',
    driverName: 'Test Driver',
    driverRating: 4.8,
  }));
}

describe('Simulation', () => {
  it('runs ten minutes of city life without collisions, NaNs or gridlock', () => {
    const city = buildCity();
    const events: string[] = [];
    const sim = new Simulation(city, fleet(30), { hooks: { onOrderEvent: (_o, e) => events.push(e.type) } });
    let overlaps = 0;
    let checks = 0;
    for (let i = 0; i < 600 * 20; i++) {
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
    expect(overlaps / Math.max(1, checks)).toBeLessThan(0.002);
    expect(kpi.avgSpeedKmh).toBeGreaterThan(8);
    expect(kpi.congestion).toBeLessThan(0.5);
    expect(events).toContain('CREATED');
    expect(events).toContain('PICKED_UP');
    expect(kpi.orders.completed).toBeGreaterThan(3);
    const frame = sim.frame();
    expect(frame.vehicles.length).toBeGreaterThan(80);
  });

  it('sends a taxi to the service box and back on line on admin command', () => {
    const city = buildCity();
    const sim = new Simulation(city, fleet(6), { trafficDensity: 0.2, demand: 0 });
    sim.setFleetStatus('T1', 'MAINTENANCE');
    let reached = false;
    for (let i = 0; i < 20 * 400 && !reached; i++) {
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
});
