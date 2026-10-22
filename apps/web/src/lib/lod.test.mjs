import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkCells, nextLod, shadowExtent } from './lod.ts';

test('the level holds between the two thresholds', () => {
  assert.equal(nextLod(2.4, 'far'), 'far');
  assert.equal(nextLod(2.4, 'near'), 'near');
  assert.equal(nextLod(2.7, 'far'), 'near');
  assert.equal(nextLod(2.1, 'near'), 'far');
});

test('points fall into 400 m cells from the origin', () => {
  const cells = chunkCells([
    { x: 10, z: 10 },
    { x: -1, z: 0 },
    { x: 399, z: 0 },
  ]);
  assert.deepEqual(
    cells.map((c) => [c.key, c.items]),
    [
      ['-1:0', [1]],
      ['0:0', [0, 2]],
    ],
  );
  assert.deepEqual([cells[0].cx, cells[0].cz], [-1, 0]);
});

test('the shadow square follows the view and stays within limits', () => {
  assert.equal(shadowExtent(1600, 1000, 0.8), 1400);
  assert.ok(Math.abs(shadowExtent(1600, 1000, 4.6) - 260.9) < 0.1);
  assert.equal(shadowExtent(1600, 1000, 12), 200);
});
