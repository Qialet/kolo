import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TramTrails } from './tram-trail.ts';

const EAST = Math.PI / 2;
const SOUTH = 0;
const near = (a, b, eps = 0.3) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

/** Drives a tram along straight legs in 0.1 m steps, feeding every step. */
function drive(trails, id, length, legs) {
  let { x, z } = legs[0];
  for (const leg of legs.slice(1)) {
    const d = Math.hypot(leg.x - x, leg.z - z);
    const heading = Math.atan2(leg.x - x, leg.z - z);
    const n = Math.round(d / 0.1);
    const x0 = x;
    const z0 = z;
    for (let k = 1; k <= n; k++) trails.feed(id, x0 + ((leg.x - x0) * k) / n, z0 + ((leg.z - z0) * k) / n, heading, length);
    x = leg.x;
    z = leg.z;
  }
}

test('a new tram lays its trail back along its heading', () => {
  const trails = new TramTrails();
  trails.feed('t', 100, 0, EAST, 19);
  const [front, rear] = trails.sections('t', 19, 2);
  near(front.x, 95.25);
  near(front.z, 0);
  near(front.heading, EAST, 0.01);
  near(rear.x, 85.75);
  near(rear.z, 0);
});

test('rear sections follow the path the front took round a corner', () => {
  const trails = new TramTrails();
  drive(trails, 't', 33, [{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 40, z: 10 }]);
  const parts = trails.sections('t', 33, 5);
  assert.equal(parts.length, 5);
  // Front section [0, 6.6] runs south along x = 40.
  near(parts[0].x, 40);
  near(parts[0].z, 6.7);
  near(parts[0].heading, SOUTH, 0.05);
  // Middle [13.2, 19.8] and rear [26.4, 33] are still on the east-bound leg.
  near(parts[2].x, 33.5);
  near(parts[2].z, 0);
  near(parts[2].heading, EAST, 0.05);
  near(parts[4].x, 20.3);
  near(parts[4].z, 0);
});

test('the trail keeps only the length plus 5 m', () => {
  const trails = new TramTrails();
  drive(trails, 't', 19, [{ x: 0, z: 0 }, { x: 500, z: 0 }]);
  assert.ok(trails.points('t') <= (19 + 5) / 0.5 + 2, `${trails.points('t')} points`);
  near(trails.sections('t', 19, 2)[1].x, 500 - 14.25);
});

test('a jump (clock sync) lays a fresh trail instead of a 300 m section', () => {
  const trails = new TramTrails();
  drive(trails, 't', 19, [{ x: 0, z: 0 }, { x: 50, z: 0 }]);
  trails.feed('t', 50, 300, SOUTH, 19);
  const [, rear] = trails.sections('t', 19, 2);
  near(rear.x, 50);
  near(rear.z, 300 - 14.25);
  near(rear.heading, SOUTH, 0.01);
});

test('trams gone from the frame are pruned', () => {
  const trails = new TramTrails();
  trails.feed('a', 0, 0, EAST, 19);
  trails.feed('b', 0, 50, EAST, 19);
  trails.prune();
  trails.feed('a', 0.2, 0, EAST, 19);
  trails.prune();
  assert.equal(trails.size, 1);
  assert.ok(trails.points('a') > 0);
  assert.equal(trails.points('b'), 0);
});
