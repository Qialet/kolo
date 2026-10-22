// Offline import: raw OSM and GTFS (data/raw, outside git) → data/districts/belgrade-center.json (in git).
// Run `pnpm --filter @kolo/sim build` first; usage: node scripts/import-district.mjs [osm.json] [out.json] [gtfs-dir]
// stop_times.txt (~110 MB) is read as one string and walked line by line; the default Node heap is enough.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BELGRADE_BBOX, buildDistrict } from '../dist/import/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const osmPath = resolve(process.argv[2] ?? `${root}/data/raw/osm/district.json`);
const outPath = resolve(process.argv[3] ?? `${root}/data/districts/belgrade-center.json`);
const gtfsDir = resolve(process.argv[4] ?? `${root}/data/raw/gtfs/feed`);

let gtfs;
if (existsSync(gtfsDir)) {
  gtfs = {};
  for (const file of readdirSync(gtfsDir)) if (file.endsWith('.txt')) gtfs[file] = readFileSync(join(gtfsDir, file), 'utf8');
} else console.warn(`No GTFS folder at ${gtfsDir}: the district gets an empty transit section`);

const osm = JSON.parse(readFileSync(osmPath, 'utf8'));
const district = buildDistrict(osm.elements, {
  id: 'belgrade-center',
  name: 'Beograd — centar',
  bbox: BELGRADE_BBOX,
  osmTimestamp: osm.osm3s?.timestamp_osm_base ?? 'unknown',
  gtfs,
});
mkdirSync(dirname(outPath), { recursive: true });
const json = JSON.stringify(district);
writeFileSync(outPath, json);
const { roads, meta, buildings, areas, addresses, pois, depotSites, trees, transit } = district;
const tracks = roads.edges.filter((e) => e.cls === 'tram');
let trackM = 0;
for (const e of tracks) for (let i = 2; i < e.pts.length; i += 2) trackM += Math.hypot(e.pts[i] - e.pts[i - 2], e.pts[i + 1] - e.pts[i - 1]);
const twoWayTracks = osm.elements.filter((e) => e.type === 'way' && e.tags?.railway === 'tram' && !e.tags.service && e.tags.oneway !== 'yes').length;
const rd = transit.patterns.flatMap((p) => p.profiles).reduce((n, p) => n + (p.starts.RD?.length ?? 0), 0);
console.log(
  `${outPath}: ${(json.length / 1024).toFixed(0)} KB, version ${meta.version}, ` +
    `${roads.nodes.length} nodes, ${roads.edges.length} edges, ${roads.restrictions.length} restrictions; ` +
    `${buildings.length} buildings, ${areas.length} areas, ${trees.length / 2} trees, ${addresses.length} addresses, ${pois.length} POIs, ${depotSites.length} depot lots; ` +
    `${tracks.length} tram track edges (${(trackM / 1000).toFixed(1)} km, ${twoWayTracks} two-way tracks skipped); ` +
    `GTFS ${meta.gtfsVersion}: ${transit.stops.length} stops, ${transit.lines.length} lines (${transit.lines.filter((l) => l.mode === 'tram').length} tram), ${transit.patterns.length} patterns, ` +
    `${rd} RD departures, transit ${(JSON.stringify(transit).length / 1024).toFixed(0)} KB`,
);
