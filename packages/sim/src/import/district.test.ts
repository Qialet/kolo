import { describe, expect, it } from 'vitest';
import { buildDistrict } from './district.js';
import type { OsmElement } from './osm-roads.js';
import { unproject } from './project.js';

const box = { s: 44.8015, w: 20.465, n: 44.8035, e: 20.4677 };

function street(name: string): OsmElement[] {
  const a = unproject({ x: -400, z: 0 });
  const b = unproject({ x: 400, z: 0 });
  return [
    { type: 'node', id: 1, ...a },
    { type: 'node', id: 2, ...b },
    { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'secondary', name } },
  ];
}

describe('buildDistrict', () => {
  const opts = { id: 'test', name: 'Test', bbox: box, osmTimestamp: '2026-10-21T21:26:46Z' };

  it('fills the meta block and a content hash', () => {
    const d = buildDistrict(street('Kralja Milana'), opts);
    expect(d.meta).toMatchObject({ id: 'test', name: 'Test', bboxDeg: box, osmTimestamp: '2026-10-21T21:26:46Z', gtfsVersion: null });
    expect(d.meta.anchor).toEqual({ lat: 44.80248, lon: 20.46632 });
    expect(d.meta.bounds.x0).toBeLessThan(0);
    expect(d.meta.version).toMatch(/^[0-9a-f]{8}$/);
    expect(d.roads.edges).toHaveLength(1);
  });

  it('keeps the hash stable for the same data and changes it for different data', () => {
    expect(buildDistrict(street('A'), opts).meta.version).toBe(buildDistrict(street('A'), opts).meta.version);
    expect(buildDistrict(street('A'), opts).meta.version).not.toBe(buildDistrict(street('B'), opts).meta.version);
  });
});
