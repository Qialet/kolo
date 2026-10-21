// Offline import: raw OSM (data/raw, outside git) → data/districts/belgrade-center.json (in git).
// Run `pnpm --filter @kolo/sim build` first; usage: node scripts/import-district.mjs [osm.json] [out.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BELGRADE_BBOX, buildDistrict } from '../dist/import/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const osmPath = resolve(process.argv[2] ?? `${root}/data/raw/osm/district.json`);
const outPath = resolve(process.argv[3] ?? `${root}/data/districts/belgrade-center.json`);

const osm = JSON.parse(readFileSync(osmPath, 'utf8'));
const district = buildDistrict(osm.elements, {
  id: 'belgrade-center',
  name: 'Beograd — centar',
  bbox: BELGRADE_BBOX,
  osmTimestamp: osm.osm3s?.timestamp_osm_base ?? 'unknown',
});
mkdirSync(dirname(outPath), { recursive: true });
const json = JSON.stringify(district);
writeFileSync(outPath, json);
const { roads, meta, buildings, areas, addresses, pois, depotSites, trees } = district;
console.log(
  `${outPath}: ${(json.length / 1024).toFixed(0)} KB, version ${meta.version}, ` +
    `${roads.nodes.length} nodes, ${roads.edges.length} edges, ${roads.restrictions.length} restrictions; ` +
    `${buildings.length} buildings, ${areas.length} areas, ${trees.length / 2} trees, ${addresses.length} addresses, ${pois.length} POIs, ${depotSites.length} depot lots`,
);
