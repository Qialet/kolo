import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { District } from '../city/district.js';
import { buildCityFromDistrict } from '../city/district-build.js';
import { createRng } from '../rng.js';
import { Roaming } from './roaming.js';
import { TrafficSystem } from './traffic.js';

/** Processor time of this test process in ms: unlike the wall clock it does not grow when other test processes compete for the CPU. */
const cpuMs = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

const REAL = new URL('../../../../data/districts/belgrade-center.json', import.meta.url);

describe('background traffic on real Belgrade roads', () => {
  const city = buildCityFromDistrict(JSON.parse(readFileSync(REAL, 'utf8')) as District);

  it('runs ten minutes with 300 cars without collisions, NaNs or gridlock', () => {
    const traffic = new TrafficSystem(city);
    const roaming = new Roaming(traffic, createRng(11));
    roaming.update(300, true);
    expect(roaming.cars.size).toBe(300);

    let overlaps = 0;
    let checks = 0;
    let stepMs = 0;
    let entered = 0;
    let left = 0;
    let vanished = 0;
    roaming.onEnter = () => entered++;
    roaming.onLeave = () => left++;
    roaming.onVanish = () => vanished++;
    for (let i = 0; i < 600 * 20; i++) {
      const t0 = cpuMs();
      traffic.step(0.05);
      roaming.step();
      if (i % 20 === 0) roaming.update(300);
      stepMs += cpuMs() - t0;
      if (i % 100 !== 0) continue;
      const byLane = new Map<number, { s: number; len: number }[]>();
      for (const v of traffic.vehicles) {
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
    const moving = traffic.vehicles.filter((v) => v.mode === 'lane' || v.mode === 'conn');
    const avgKmh = (moving.reduce((a, v) => a + v.speed, 0) / moving.length) * 3.6;
    const congestion = moving.filter((v) => v.stoppedFor > 4).length / moving.length;
    const stuck = moving.filter((v) => v.stoppedFor > 120);
    console.log(
      `roaming: avg ${avgKmh.toFixed(1)} km/h, congestion ${congestion.toFixed(2)}, stuck ${stuck.length}, ` +
        `step ${(stepMs / 12000).toFixed(2)} ms, entered ${entered}, left ${left}, vanished ${vanished}, overlaps ${overlaps}/${checks}`,
    );
    expect(overlaps / Math.max(1, checks)).toBeLessThan(0.002);
    expect(avgKmh).toBeGreaterThan(10);
    expect(congestion).toBeLessThan(0.5);
    expect(stuck).toHaveLength(0);
    expect(stepMs / 12000).toBeLessThan(15);
    expect(entered).toBeGreaterThan(20);
    expect(left).toBeGreaterThan(20);
    // Cars leave through the frame, they do not disappear in the middle of the map.
    expect(vanished).toBeLessThan(left / 10);
    expect(roaming.cars.size).toBeGreaterThan(270);
  });
});
