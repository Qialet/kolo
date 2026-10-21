import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DistrictRoads } from '../city/district.js';
import { boundsOfBBox, importRoads, type OsmElement } from './osm-roads.js';
import { DEPOT_SITES, importPlaces } from './osm-places.js';
import { ringArea } from './polygons.js';
import { BELGRADE_BBOX, unproject } from './project.js';

/** Tiny OSM builder in local metres (as in osm-roads.test). */
function osm() {
  const els: OsmElement[] = [];
  let nextId = 1;
  const node = (x: number, z: number, tags?: Record<string, string>) => {
    const { lat, lon } = unproject({ x, z });
    const id = nextId++;
    els.push({ type: 'node', id, lat, lon, tags });
    return id;
  };
  const way = (nodes: number[], tags?: Record<string, string>) => {
    const id = 1000 + nextId++;
    els.push({ type: 'way', id, nodes, tags });
    return id;
  };
  /** Closed rectangle way. */
  const rect = (x0: number, z0: number, x1: number, z1: number, tags?: Record<string, string>) => {
    const ids = [node(x0, z0), node(x1, z0), node(x1, z1), node(x0, z1)];
    return way([...ids, ids[0]!], tags);
  };
  return { els, node, way, rect };
}

const box = { s: 44.8015, w: 20.465, n: 44.8035, e: 20.4677 };
const bounds = boundsOfBBox(box);
const noRoads: DistrictRoads = { nodes: [], edges: [], restrictions: [] };
const pts = (flat: number[]) => Array.from({ length: flat.length / 2 }, (_, i) => ({ x: flat[2 * i]!, z: flat[2 * i + 1]! }));

describe('importPlaces', () => {
  it('assembles a multipolygon from two outer ways and a hole', () => {
    const o = osm();
    const a = o.node(-50, -50);
    const b = o.node(50, -50);
    const c = o.node(50, 50);
    const d = o.node(-50, 50);
    const w1 = o.way([a, b, c]);
    const w2 = o.way([c, d, a]);
    const hole = o.rect(-10, -10, 10, 10);
    o.els.push({
      type: 'relation',
      id: 77,
      tags: { type: 'multipolygon', leisure: 'park' },
      members: [
        { type: 'way', ref: w1, role: 'outer' },
        { type: 'way', ref: w2, role: 'outer' },
        { type: 'way', ref: hole, role: 'inner' },
      ],
    });
    const { areas } = importPlaces(o.els, box, noRoads, []);
    expect(areas).toHaveLength(1);
    expect(areas[0]!.kind).toBe('park');
    expect(areas[0]!.rings).toHaveLength(2);
    expect(ringArea(pts(areas[0]!.rings[0]!)) - ringArea(pts(areas[0]!.rings[1]!))).toBeCloseTo(9600, -1);
  });

  it('clips land cover at the frame', () => {
    const o = osm();
    o.rect(60, -50, bounds.x1 + 100, 50, { landuse: 'grass' });
    const { areas } = importPlaces(o.els, box, noRoads, []);
    expect(areas[0]!.kind).toBe('grass');
    expect(ringArea(pts(areas[0]!.rings[0]!))).toBeCloseTo((bounds.x1 - 60) * 100, -1);
  });

  it('derives building heights from height, levels or the building type', () => {
    const o = osm();
    o.rect(0, 0, 20, 20, { building: 'apartments', 'building:levels': '6' });
    o.rect(30, 0, 50, 20, { building: 'office', height: '21 m' });
    o.rect(60, 0, 80, 20, { building: 'apartments' });
    o.rect(-40, 0, -20, 20, { building: 'roof' });
    const { buildings } = importPlaces(o.els, box, noRoads, []);
    expect(buildings.map((b) => b.h)).toEqual([19.2, 21, 16]);
    expect(buildings.map((b) => b.levels)).toEqual([6, 7, 5]);
    expect(buildings[0]!.use).toBe('residential');
    expect(buildings[1]!.use).toBe('office');
  });

  it('drops buildings whose centre is outside the frame instead of cutting them', () => {
    const o = osm();
    o.rect(bounds.x1 - 5, 0, bounds.x1 + 25, 20, { building: 'yes' });
    expect(importPlaces(o.els, box, noRoads, []).buildings).toHaveLength(0);
  });

  it('reads Latin addresses and keeps one per street and number', () => {
    const o = osm();
    o.rect(0, 0, 20, 20, { building: 'yes', 'addr:street': 'Кнеза Михаила', 'addr:housenumber': '12а' });
    o.node(10, 10, { 'addr:street': 'Кнеза Михаила', 'addr:housenumber': '12а' });
    o.node(10, 5, { 'addr:street': 'Кнеза Михаила', 'addr:housenumber': '14' });
    const { addresses, buildings } = importPlaces(o.els, box, noRoads, []);
    expect(addresses.map((a) => `${a.street} ${a.number}`).sort()).toEqual(['Kneza Mihaila 12a', 'Kneza Mihaila 14']);
    const id = buildings[0]!.id;
    expect(addresses.every((a) => a.building === id)).toBe(true);
    expect(buildings[0]!.addr).toEqual({ street: 'Kneza Mihaila', number: '12a' });
  });

  it('puts an area POI at the outline vertex nearest to a road', () => {
    const o = osm();
    o.way([o.node(-100, 80), o.node(100, 80)], { highway: 'residential' });
    o.rect(-30, -60, 30, 40, { leisure: 'park', name: 'Пионирски парк' });
    const roads = importRoads(o.els, box);
    const { pois } = importPlaces(o.els, box, roads, []);
    expect(pois).toHaveLength(1);
    expect(pois[0]).toMatchObject({ name: 'Pionirski park', kind: 'park', weight: 1 });
    expect(pois[0]!.z).toBeCloseTo(40, 0);
    expect(pois[0]!.outline).toHaveLength(8);
  });
});

const RAW = new URL('../../../../data/raw/osm/district.json', import.meta.url);

describe.skipIf(!existsSync(RAW))('importPlaces on the real snapshot', () => {
  const elements = (JSON.parse(readFileSync(RAW, 'utf8')) as { elements: OsmElement[] }).elements;
  const roads = importRoads(elements, BELGRADE_BBOX);
  const places = importPlaces(elements, BELGRADE_BBOX, roads, DEPOT_SITES);

  it('has the buildings, water, addresses, landmarks and depot lots of the centre', () => {
    expect(places.buildings.length).toBeGreaterThan(4800);
    expect(places.buildings.filter((b) => b.levels && b.h).length).toBe(places.buildings.length);
    const water = places.areas.filter((a) => a.kind === 'water').map((a) => ringArea(pts(a.rings[0]!)));
    expect(Math.max(...water)).toBeGreaterThan(50_000);
    expect(places.addresses.length).toBeGreaterThan(4000);
    const names = places.pois.map((p) => p.name);
    for (const n of ['Kalemegdan', 'Pijaca Zeleni venac', 'Univerzitetski klinički centar Srbije']) expect(names).toContain(n);
    expect(places.depotSites.map((d) => d.id)).toEqual(['P1', 'P2', 'P3']);
    expect(JSON.stringify({ roads, ...places }).length).toBeLessThan(4 * 1024 * 1024);
  });

  it('reads building:levels for most buildings', () => {
    const tagged = elements.filter((e) => e.type === 'way' && e.tags?.building && e.tags['building:levels']).length;
    const all = elements.filter((e) => e.type === 'way' && e.tags?.building).length;
    expect(tagged / all).toBeGreaterThan(0.8);
  });
});
