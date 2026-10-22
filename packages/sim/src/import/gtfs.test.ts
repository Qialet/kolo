import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { District } from '../city/district.js';
import { buildDistrict } from './district.js';
import { gtfsSeconds, importGtfs } from './gtfs.js';
import { boundsOfBBox } from './osm-roads.js';
import { BELGRADE_BBOX, unproject } from './project.js';

const box = { s: 44.8015, w: 20.465, n: 44.8035, e: 20.4677 };
const b = boundsOfBBox(box);

const stop = (id: string, name: string, x: number, z = 0) => {
  const p = unproject({ x, z });
  return `${id},${id.slice(1)},${name},${p.lat.toFixed(10)},${p.lon.toFixed(10)},1,0,`;
};
const shapeRow = (id: string, x: number, seq: number) => {
  const p = unproject({ x, z: 0 });
  return `${id},${p.lat.toFixed(8)},${p.lon.toFixed(8)},${seq},`;
};
const hms = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((v) => String(v).padStart(2, '0')).join(':');
/** stop_times rows of one trip: [stop, arrival, departure] in seconds. */
const times = (trip: string, rows: [string, number, number][]) => rows.map(([s, a, d], i) => `${trip},${hms(a)},${hms(d)},${s},${i + 1},0,0,0`);

// Line 26: five stops along z = 0, the first two west of the frame; it ends inside.
const T = 8 * 3600;
const line26 = (trip: string, start: number, prevGap: number) =>
  times(trip, [
    ['S1', start - prevGap - 120, start - prevGap - 120],
    ['S2', start - prevGap, start - prevGap],
    ['S3', start, start],
    ['S4', start + 60, start + 90],
    ['S5', start + 150, start + 150],
  ]);
// Line 27, mirrored: starts inside and leaves the frame east, two stops past it.
const line27 = (trip: string, start: number, nextGap: number) =>
  times(trip, [
    ['S3', start, start],
    ['S4', start + 60, start + 90],
    ['S5', start + 150, start + 150],
    ['S6', start + 150 + nextGap, start + 150 + nextGap],
    ['S7', start + 270 + nextGap, start + 270 + nextGap],
  ]);

function feed(): Record<string, string> {
  return {
    'feed_info.txt': 'feed_publisher_name,feed_start_date,feed_end_date,feed_version\nGrad,20250902,20261231,24\n',
    'calendar.txt':
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\r\n' +
      'N,0,0,0,0,0,0,1,20230901,20291231\r\nS,0,0,0,0,0,1,0,20230901,20291231\r\nRD,1,1,1,1,1,0,0,20230901,20291231\r\n',
    'calendar_dates.txt': 'service_id,date,exception_type\nN,20250502,1\nRD,20250502,2\n',
    'routes.txt':
      '﻿route_id,agency_id,route_short_name,route_long_name,route_type,route_url,route_color,route_text_color\n' +
      'R26,A,26,"Dorćol - Braće Jerković, preko centra",3,,0098DA,FFFFFF\n' +
      'R27,A,27,Istok,3,,0098DA,FFFFFF\n' +
      'T02,A,2,Tramvaj,0,,FF0000,FFFFFF\n' +
      'E01,A,EKO1,Vukov spomenik - Belvil,3,,0098DA,ffffff\n' +
      'TR40,A,40,Banjica - Zvezdara,11,,,\n',
    'stops.txt': [
      'stop_id,stop_code,stop_name,stop_lat,stop_lon,zone_id,location_type,parent_station',
      stop('S1', 'Daleko', b.x0 - 400),
      stop('S2', 'Blizu', b.x0 - 100),
      stop('S3', 'Славија', b.x0 + 20),
      stop('S4', 'Park "Tašmajdan"', 0),
      stop('S5', 'Kraj', b.x1 - 20),
      stop('S6', 'Istok blizu', b.x1 + 100),
      stop('S7', 'Istok daleko', b.x1 + 400),
      stop('S9', 'Samo tramvaj', 0, 40),
    ].join('\n'),
    'trips.txt': [
      'route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible',
      'R26,RD,a1,Kraj,,0,,sh26,0',
      'R26,RD,a2,Kraj,,0,,sh26,0',
      'R26,S,a3,Kraj,,0,,sh26,0',
      'R26,RD,a4,Kraj,,0,,sh26,0',
      'R26,RD,a5,"Kraj ""noću""",,0,,sh26,0',
      'R27,RD,b1,Istok,,0,,sh27,0',
      'R27,RD,b2,Istok,,0,,sh27,0',
      'T02,RD,tram,Tram,,0,,,0',
      'E01,RD,eko,Belvil,,1,,,0',
      'TR40,N,tro,Zvezdara,,0,,,0',
    ].join('\n'),
    'stop_times.txt': [
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,timepoint',
      ...line26('a1', T, 120),
      ...line26('a2', T + 600, 120),
      ...line26('a3', T, 120),
      ...line26('a4', T + 1200, 180),
      // After midnight, rows out of order.
      ...line26('a5', 90_600, 120).reverse(),
      ...line27('b1', T, 120),
      ...line27('b2', T + 600, 180),
      ...times('tram', [['S9', T, T], ['S4', T + 60, T + 60]]),
      ...times('eko', [['S4', T, T], ['S3', T + 120, T + 120]]),
      ...times('tro', [['S3', T, T], ['S4', T + 100, T + 110], ['S5', T + 200, T + 200]]),
      '',
    ].join('\n'),
    'shapes.txt': [
      'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled',
      shapeRow('sh26', b.x0 - 450, 0),
      shapeRow('sh26', b.x0 - 250, 1),
      shapeRow('sh26', b.x0 - 60, 2),
      shapeRow('sh26', 0, 3),
      shapeRow('sh26', b.x1 - 20, 4),
      shapeRow('sh27', b.x0 + 20, 0),
      shapeRow('sh27', 0, 1),
      shapeRow('sh27', b.x1 + 250, 2),
      shapeRow('sh27', b.x1 + 450, 3),
    ].join('\n'),
  };
}

describe('gtfsSeconds', () => {
  it('reads times past midnight', () => {
    expect(gtfsSeconds('25:10:00')).toBe(90_600);
    expect(gtfsSeconds('4:05:30')).toBe(14_730);
  });
});

describe('importGtfs on a synthetic feed', () => {
  const tr = importGtfs(feed(), box);

  it('keeps feed info and the service calendar', () => {
    expect(tr.feed).toEqual({ version: '24', start: '20250902', end: '20261231' });
    expect(tr.calendar).toEqual({ week: ['N', 'RD', 'RD', 'RD', 'RD', 'RD', 'S'], extra: [['20250502', 'N']] });
  });

  it('maps type 0 to tram, EKO lines to minibus and type 11 to trolley', () => {
    expect(tr.lines.map((l) => [l.id, l.name, l.mode])).toEqual([
      ['E01', 'EKO1', 'minibus'],
      ['R26', '26', 'bus'],
      ['R27', '27', 'bus'],
      ['T02', '2', 'tram'],
      ['TR40', '40', 'trolley'],
    ]);
    expect(tr.lines[1]).toMatchObject({ longName: 'Dorćol - Braće Jerković, preko centra', color: '#0098DA', text: '#FFFFFF' });
    expect(tr.lines[0]!.text).toBe('#FFFFFF');
  });

  it('keeps only in-frame stops of kept patterns, in Latin, with the direction of travel', () => {
    expect(tr.stops.map((s) => s.id)).toEqual(['S3', 'S4', 'S5', 'S9']);
    expect(tr.stops[0]).toMatchObject({ code: '3', name: 'Slavija', dir: [1, 0] });
    expect(tr.stops[0]!.x).toBeCloseTo(b.x0 + 20, 0);
    expect(tr.stops[1]!.name).toBe('Park "Tašmajdan"');
  });

  it('builds a pattern with enter, without exit, and a clipped simplified shape', () => {
    const line = tr.lines.findIndex((l) => l.id === 'R26');
    const p = tr.patterns.find((q) => q.line === line)!;
    expect(p).toMatchObject({ dir: 0, headsign: 'Kraj', stops: [0, 1, 2], enter: true, exit: false });
    expect(p.shape).toHaveLength(4);
    expect(p.shape[0]).toBeCloseTo(b.x0 - 50, 0);
    expect(p.shape[2]).toBeCloseTo(b.x1 - 20, 0);
  });

  it('collapses equal timings into one profile with delta-coded starts per service', () => {
    const line = tr.lines.findIndex((l) => l.id === 'R26');
    const profiles = tr.patterns.find((q) => q.line === line)!.profiles;
    expect(profiles).toHaveLength(2);
    const [a, c] = profiles;
    expect(a!.t).toEqual([0, 0, 60, 90, 150, 150]);
    expect(a!.starts).toEqual({ RD: [T, 600, 90_600 - T - 600], S: [T] });
    expect(a!.exit).toBeUndefined();
    expect(c!.starts).toEqual({ RD: [T + 1200] });
    // The frame is 100 of the 120 m between S2 and S3 away from S2: the crossing is at 5/6 of the gap.
    expect(a!.enter).toBe(-20);
    expect(c!.enter).toBe(-30);
  });

  it('builds a pattern with exit and a positive exit offset proportional to the gap', () => {
    const line = tr.lines.findIndex((l) => l.id === 'R27');
    const p = tr.patterns.find((q) => q.line === line)!;
    expect(p).toMatchObject({ stops: [0, 1, 2], enter: false, exit: true });
    expect(p.shape[0]).toBeCloseTo(b.x0 + 20, 0);
    expect(p.shape[p.shape.length - 2]).toBeCloseTo(b.x1 + 50, 0);
    expect(p.profiles.map((q) => [q.enter, q.exit, q.starts])).toEqual([
      // The frame is 20 of the 120 m between S5 and S6 away from S5: the crossing is at 1/6 of the gap.
      [undefined, 170, { RD: [T] }],
      [undefined, 180, { RD: [T + 600] }],
    ]);
  });

  it('falls back to a polyline through the stops when a trip has no shape', () => {
    const line = tr.lines.findIndex((l) => l.id === 'TR40');
    const p = tr.patterns.find((q) => q.line === line)!;
    expect(p).toMatchObject({ enter: false, exit: false, stops: [0, 1, 2] });
    expect(p.profiles).toEqual([{ t: [0, 0, 100, 110, 200, 200], starts: { N: [T] } }]);
    expect(p.shape.length).toBeGreaterThanOrEqual(4);
  });
});

describe('buildDistrict with GTFS', () => {
  const opts = { id: 't', name: 'T', bbox: box, osmTimestamp: 'x' };

  it('writes an empty transit section without a feed', () => {
    const d = buildDistrict([], opts);
    expect(d.transit).toEqual({ feed: null, calendar: { week: [], extra: [] }, stops: [], lines: [], patterns: [] });
    expect(d.meta.gtfsVersion).toBeNull();
  });

  it('stores the feed, its version and hashes it', () => {
    const d = buildDistrict([], { ...opts, gtfs: feed() });
    expect(d.meta.gtfsVersion).toBe('24');
    expect(d.transit.stops).toHaveLength(4);
    expect(d.meta.version).not.toBe(buildDistrict([], opts).meta.version);
  });
});

const RAW = new URL('../../../../data/raw/gtfs/feed/', import.meta.url);
const REAL = new URL('../../../../data/districts/belgrade-center.json', import.meta.url);

describe.skipIf(!existsSync(RAW))('importGtfs on the real feed', () => {
  it('fits the Belgrade frame', () => {
    const files: Record<string, string> = {};
    for (const f of readdirSync(RAW)) if (f.endsWith('.txt')) files[f] = readFileSync(new URL(f, RAW), 'utf8');
    const tr = importGtfs(files, BELGRADE_BBOX);
    expect(tr.stops.length).toBeGreaterThanOrEqual(120);
    expect(tr.lines.length).toBeGreaterThanOrEqual(90);
    expect(tr.lines.filter((l) => l.mode === 'trolley').length).toBeGreaterThanOrEqual(4);
    const trams = new Set(tr.lines.flatMap((l, i) => (l.mode === 'tram' ? [i] : [])));
    expect(trams.size).toBe(10);
    const tramPatterns = tr.patterns.filter((p) => trams.has(p.line));
    expect(tramPatterns.length).toBeGreaterThanOrEqual(20);
    expect(new Set(tramPatterns.flatMap((p) => p.stops)).size).toBeGreaterThanOrEqual(35);
    expect(tr.patterns.length).toBeGreaterThanOrEqual(150);
    const rd = tr.patterns.flatMap((p) => p.profiles).reduce((n, p) => n + (p.starts['RD']?.length ?? 0), 0);
    expect(rd).toBeGreaterThanOrEqual(15_000);
    expect(JSON.stringify(tr).length).toBeLessThan(900 * 1024);
  });
});

describe('district file', () => {
  it('carries the transit section and stays under 4 MB', () => {
    expect(statSync(REAL).size).toBeLessThan(4 * 1024 * 1024);
    const d = JSON.parse(readFileSync(REAL, 'utf8')) as District;
    expect(d.meta.gtfsVersion).toBe('24');
    expect(d.transit.stops.length).toBeGreaterThanOrEqual(120);
  });
});
