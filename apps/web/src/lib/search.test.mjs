import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineSearchText, searchItems } from './search.ts';

const lines = [
  { name: '2', longName: 'Pristanište - Vukov spomenik - Pristanište', mode: 'tram' },
  { name: '26', longName: 'Dorćol - Braće Jerković', mode: 'bus' },
  { name: '40', longName: 'Banjica 2 - Zvezdara', mode: 'trolley' },
];

test('finds tram lines by the word tram', () => {
  const found = searchItems(lines, 'трамвай 2', lineSearchText, 10);
  assert.deepEqual(found.map((l) => l.name), ['2']);
  assert.deepEqual(searchItems(lines, 'трамвайная', lineSearchText, 10).map((l) => l.name), ['2']);
});

test('finds lines by number and name whatever their mode', () => {
  assert.deepEqual(searchItems(lines, 'линия 26', lineSearchText, 10).map((l) => l.name), ['26']);
  assert.deepEqual(searchItems(lines, 'троллейбус', lineSearchText, 10).map((l) => l.name), ['40']);
  assert.deepEqual(searchItems(lines, 'pristaniste', lineSearchText, 10).map((l) => l.name), ['2']);
});
