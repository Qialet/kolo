import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BELGRADE_ANCHOR, BELGRADE_BBOX, project, unproject } from './project.js';
import { importRoads, type OsmElement } from './osm-roads.js';
import { toLatin } from './translit.js';

/** Tiny OSM builder: nodes are placed in local metres around the anchor. */
function osm() {
  const els: OsmElement[] = [];
  let nextId = 1;
  const node = (x: number, z: number, tags?: Record<string, string>) => {
    const { lat, lon } = unproject({ x, z });
    const id = nextId++;
    els.push({ type: 'node', id, lat, lon, tags });
    return id;
  };
  const way = (nodes: number[], tags: Record<string, string>) => {
    const id = 1000 + nextId++;
    els.push({ type: 'way', id, nodes, tags });
    return id;
  };
  return { els, node, way };
}

const box = { s: 44.8015, w: 20.465, n: 44.8035, e: 20.4677 };

describe('projection', () => {
  it('puts the anchor at the origin with x east and z south', () => {
    expect(project(BELGRADE_ANCHOR)).toEqual({ x: 0, z: 0 });
    const ne = project({ lat: BELGRADE_ANCHOR.lat + 0.001, lon: BELGRADE_ANCHOR.lon + 0.001 });
    expect(ne.x).toBeCloseTo(78.9, 0);
    expect(ne.z).toBeCloseTo(-111.2, 0);
    const back = unproject(ne);
    expect(back.lat).toBeCloseTo(BELGRADE_ANCHOR.lat + 0.001, 9);
  });

  it('frames the agreed district', () => {
    expect(BELGRADE_BBOX).toEqual({ s: 44.798, w: 20.447, n: 44.8235, e: 20.473 });
  });
});

describe('toLatin', () => {
  it('transliterates Serbian Cyrillic', () => {
    expect(toLatin('Трг Славија')).toBe('Trg Slavija');
    expect(toLatin('Љубљанска Џорџа Ђурића Њива')).toBe('Ljubljanska Džordža Đurića Njiva');
    expect(toLatin('Kralja Milana 12')).toBe('Kralja Milana 12');
  });
});

describe('importRoads', () => {
  it('splits ways at shared nodes into edges between junctions', () => {
    const o = osm();
    const c = o.node(0, 0);
    o.way([o.node(-60, 0), c, o.node(60, 0)], { highway: 'secondary', name: 'Улица А' });
    o.way([o.node(0, -60), c, o.node(0, 60)], { highway: 'residential', name: 'Улица Б' });
    const roads = importRoads(o.els, box);
    expect(roads.edges).toHaveLength(4);
    const centre = roads.nodes.find((n) => Math.hypot(n.x, n.z) < 0.5)!;
    expect(roads.edges.filter((e) => e.a === centre.id || e.b === centre.id)).toHaveLength(4);
    expect(roads.edges.map((e) => e.name)).toContain('Ulica A');
  });

  it('clips edges at the district bounds and marks boundary nodes', () => {
    const o = osm();
    o.way([o.node(0, 0), o.node(0, 400)], { highway: 'tertiary' });
    const roads = importRoads(o.els, box);
    const bounds = boundsOf(box);
    expect(roads.edges).toHaveLength(1);
    const end = roads.nodes.find((n) => n.boundary)!;
    expect(end.z).toBeCloseTo(bounds.z1, 1);
    for (const e of roads.edges) for (let i = 1; i < e.pts.length; i += 2) expect(e.pts[i]!).toBeLessThanOrEqual(bounds.z1 + 0.05);
  });

  it('reads lanes and direction tags', () => {
    const o = osm();
    const ring = [o.node(-50, -50), o.node(50, -50), o.node(50, 50), o.node(-50, 50)];
    o.way([ring[0]!, ring[1]!], { highway: 'primary', oneway: 'yes', lanes: '2' });
    o.way([ring[2]!, ring[1]!], { highway: 'primary', oneway: '-1' });
    o.way([ring[2]!, ring[3]!], { highway: 'secondary', lanes: '3' });
    o.way([ring[3]!, ring[0]!], { highway: 'secondary', 'lanes:forward': '1', 'lanes:backward': '2' });
    o.way([ring[0]!, ring[2]!], { highway: 'tertiary' });
    const roads = importRoads(o.els, box);
    const at = (x: number, z: number) => roads.nodes.find((n) => Math.hypot(n.x - x, n.z - z) < 0.5)!.id;
    const edge = (a: number, b: number) => roads.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!;
    const north = edge(at(-50, -50), at(50, -50));
    expect([north.lanesFwd, north.lanesBwd]).toEqual([2, 0]);
    const east = edge(at(50, 50), at(50, -50));
    // oneway=-1 is stored reversed: forward runs from (50,-50) to (50,50).
    expect([east.a, east.b, east.lanesFwd, east.lanesBwd]).toEqual([at(50, -50), at(50, 50), 1, 0]);
    expect([edge(at(50, 50), at(-50, 50)).lanesFwd, edge(at(50, 50), at(-50, 50)).lanesBwd]).toEqual([2, 1]);
    const west = edge(at(-50, 50), at(-50, -50));
    expect([west.lanesFwd, west.lanesBwd]).toEqual([1, 2]);
    expect(north.speed).toBeCloseTo(13.89, 2);
  });

  it('converts speed limits', () => {
    const o = osm();
    // Each street leaves the district on both sides, so all of them stay connected through the outside.
    o.way([o.node(-400, 0), o.node(400, 0)], { highway: 'secondary', maxspeed: 'RS:urban' });
    o.way([o.node(-400, 30), o.node(400, 30)], { highway: 'secondary', maxspeed: '30' });
    o.way([o.node(-400, 60), o.node(400, 60)], { highway: 'living_street' });
    const speeds = importRoads(o.els, box).edges.map((e) => Math.round(e.speed * 100) / 100).sort((a, b) => a - b);
    expect(speeds).toEqual([2.78, 8.33, 13.89]);
  });

  it('skips paths, service roads and construction, and flags bus-only streets', () => {
    const o = osm();
    const a = o.node(-50, 0);
    const b = o.node(50, 0);
    o.way([a, b], { highway: 'secondary' });
    o.way([o.node(-50, 20), o.node(50, 20)], { highway: 'footway' });
    o.way([o.node(-50, 40), o.node(50, 40)], { highway: 'service' });
    o.way([o.node(-50, 60), o.node(50, 60)], { highway: 'construction' });
    o.way([b, o.node(50, 80), a], { highway: 'secondary', access: 'no', bus: 'yes' });
    const roads = importRoads(o.els, box);
    expect(roads.edges).toHaveLength(2);
    expect(roads.edges.filter((e) => e.psvOnly)).toHaveLength(1);
  });

  it('keeps only the strongly connected network (with the outside world as one node)', () => {
    const o = osm();
    const a = o.node(-50, 0);
    const b = o.node(50, 0);
    o.way([o.node(-400, 0), a, b, o.node(400, 0)], { highway: 'secondary' });
    // A one-way stub into a dead end can never be left again.
    o.way([b, o.node(50, 50)], { highway: 'residential', oneway: 'yes' });
    const roads = importRoads(o.els, box);
    // `a` is not shared, so the street is two edges: frame → b → frame.
    expect(roads.edges).toHaveLength(2);
    expect(roads.edges.every((e) => e.cls === 'secondary')).toBe(true);
    expect(roads.nodes.filter((n) => n.boundary)).toHaveLength(2);
  });

  it('does not join a bridge to the street it passes over', () => {
    const o = osm();
    o.way([o.node(-400, 0), o.node(400, 0)], { highway: 'secondary' });
    o.way([o.node(0, -400), o.node(0, 400)], { highway: 'primary', bridge: 'yes', layer: '1' });
    const roads = importRoads(o.els, box);
    expect(roads.edges).toHaveLength(2);
    expect(roads.edges.find((e) => e.bridge)!.layer).toBe(1);
  });

  it('imports one-way tram tracks and splits the street they cross at the shared node', () => {
    const o = osm();
    const c = o.node(0, 0);
    o.way([o.node(-400, 0), c, o.node(400, 0)], { highway: 'secondary' });
    o.way([o.node(0, -400), c, o.node(0, 400)], { railway: 'tram', oneway: 'yes' });
    const roads = importRoads(o.els, box);
    const centre = roads.nodes.find((n) => Math.hypot(n.x, n.z) < 0.5)!;
    const streets = roads.edges.filter((e) => e.cls === 'secondary');
    const tracks = roads.edges.filter((e) => e.cls === 'tram');
    expect(streets).toHaveLength(2);
    expect(tracks).toHaveLength(2);
    for (const e of [...streets, ...tracks]) expect([e.a, e.b]).toContain(centre.id);
    for (const t of tracks) {
      expect([t.lanesFwd, t.lanesBwd, t.psvOnly, t.name]).toEqual([1, 0, true, '']);
      expect(t.speed).toBeCloseTo(11.11, 2);
    }
  });

  it('skips yard and siding tracks and two-way tracks', () => {
    const o = osm();
    o.way([o.node(-400, 0), o.node(400, 0)], { highway: 'secondary' });
    o.way([o.node(-400, 20), o.node(400, 20)], { railway: 'tram', oneway: 'yes', service: 'yard' });
    o.way([o.node(-400, 40), o.node(400, 40)], { railway: 'tram', oneway: 'yes', service: 'siding' });
    o.way([o.node(-400, 60), o.node(400, 60)], { railway: 'tram' });
    o.way([o.node(-400, 80), o.node(400, 80)], { railway: 'tram', oneway: 'yes', maxspeed: '30' });
    const tracks = importRoads(o.els, box).edges.filter((e) => e.cls === 'tram');
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.speed).toBeCloseTo(8.33, 2);
  });

  it('keeps node tags when Overpass repeats a node as an untagged skeleton', () => {
    const o = osm();
    const c = o.node(0, 0, { highway: 'traffic_signals' });
    o.way([o.node(-400, 0), c, o.node(400, 0)], { highway: 'secondary' });
    const dup = o.els.find((e) => e.id === c)!;
    o.els.push({ type: 'node', id: c, lat: dup.lat, lon: dup.lon });
    const roads = importRoads(o.els, box);
    expect(roads.nodes.filter((n) => n.signals)).toHaveLength(1);
  });

  it('keeps the travel direction a give way or stop sign applies to', () => {
    const o = osm();
    const c = o.node(0, 0);
    const fwd = o.node(-30, 0, { highway: 'give_way', direction: 'forward' });
    const bwd = o.node(30, 0, { highway: 'give_way', direction: 'backward' });
    const plain = o.node(0, -30, { highway: 'give_way' });
    const all = o.node(0, 30, { highway: 'stop', stop: 'all', direction: 'forward' });
    o.way([o.node(-60, 0), fwd, c, bwd, o.node(60, 0)], { highway: 'residential' });
    o.way([o.node(0, -60), plain, c, o.node(0, 60)], { highway: 'residential' });
    o.way([o.node(0, 60), all, c], { highway: 'residential' });
    const roads = importRoads(o.els, box);
    const at = (x: number, z: number) => roads.nodes.find((n) => Math.hypot(n.x - x, n.z - z) < 0.5)!;
    expect(at(-30, 0)).toMatchObject({ giveWay: true, signDir: [1, 0] });
    expect(at(30, 0)).toMatchObject({ giveWay: true, signDir: [-1, 0] });
    expect(at(0, -30).giveWay).toBe(true);
    expect(at(0, -30).signDir).toBeUndefined();
    expect(at(0, 30)).toMatchObject({ stop: true, stopAll: true, signDir: [0, -1] });
    expect(at(0, 30).giveWay).toBeUndefined();
  });

  it('maps turn restrictions onto the edges around the via node', () => {
    const o = osm();
    const c = o.node(0, 0);
    const w1 = o.way([o.node(-60, 0), c], { highway: 'secondary' });
    o.way([c, o.node(60, 0)], { highway: 'secondary' });
    const w2 = o.way([c, o.node(0, 60)], { highway: 'secondary' });
    o.els.push({ type: 'relation', id: 9, tags: { type: 'restriction', restriction: 'no_right_turn' }, members: [
      { type: 'way', ref: w1, role: 'from' },
      { type: 'node', ref: c, role: 'via' },
      { type: 'way', ref: w2, role: 'to' },
    ] });
    const roads = importRoads(o.els, box);
    expect(roads.restrictions).toHaveLength(1);
    const r = roads.restrictions[0]!;
    const via = roads.nodes.find((n) => n.id === r.via)!;
    expect(Math.hypot(via.x, via.z)).toBeLessThan(0.5);
    expect(r.only).toBe(false);
    expect(roads.edges.find((e) => e.id === r.from)!.osm).toBe(w1);
    expect(roads.edges.find((e) => e.id === r.to)!.osm).toBe(w2);
  });

  it('drops restrictions whose from or to way passes through the via node', () => {
    const o = osm();
    const c = o.node(0, 0);
    const w1 = o.way([o.node(-60, 0), c, o.node(60, 0)], { highway: 'secondary' });
    const w2 = o.way([c, o.node(0, 60)], { highway: 'secondary' });
    o.els.push({ type: 'relation', id: 9, tags: { type: 'restriction', restriction: 'only_straight_on' }, members: [
      { type: 'way', ref: w1, role: 'from' },
      { type: 'node', ref: c, role: 'via' },
      { type: 'way', ref: w2, role: 'to' },
    ] });
    expect(importRoads(o.els, box).restrictions).toHaveLength(0);
  });
});

const RAW = new URL('../../../../data/raw/osm/district.json', import.meta.url);

describe.runIf(existsSync(RAW))('importRoads on the real Belgrade extract', () => {
  it('produces a connected right-bank network with the Slavija roundabout', () => {
    const els = (JSON.parse(readFileSync(RAW, 'utf8')) as { elements: OsmElement[] }).elements;
    const roads = importRoads(els, BELGRADE_BBOX);
    const bounds = boundsOf(BELGRADE_BBOX);
    expect(roads.edges.length).toBeGreaterThan(500);
    expect(roads.edges.filter((e) => e.roundabout && e.name === 'Trg Slavija').length).toBeGreaterThan(3);
    expect(roads.nodes.filter((n) => n.signals).length).toBeGreaterThan(150);
    const tracks = roads.edges.filter((e) => e.cls === 'tram');
    expect(tracks.length).toBeGreaterThanOrEqual(40);
    let trackLength = 0;
    for (const e of tracks) for (let i = 2; i < e.pts.length; i += 2) trackLength += Math.hypot(e.pts[i]! - e.pts[i - 2]!, e.pts[i + 1]! - e.pts[i - 1]!);
    expect(trackLength).toBeGreaterThan(8000);
    for (const e of roads.edges) {
      for (let i = 0; i < e.pts.length; i += 2) {
        expect(e.pts[i]!).toBeGreaterThanOrEqual(bounds.x0 - 0.05);
        expect(e.pts[i]!).toBeLessThanOrEqual(bounds.x1 + 0.05);
        expect(e.pts[i + 1]!).toBeGreaterThanOrEqual(bounds.z0 - 0.05);
        expect(e.pts[i + 1]!).toBeLessThanOrEqual(bounds.z1 + 0.05);
      }
    }
  });
});

function boundsOf(b: { s: number; w: number; n: number; e: number }) {
  const nw = project({ lat: b.n, lon: b.w });
  const se = project({ lat: b.s, lon: b.e });
  return { x0: nw.x, z0: nw.z, x1: se.x, z1: se.z };
}
