// Road geometry audit of the district: defect counts with the worst places, and top-down maps of the roads.
// Run `pnpm --filter @kolo/sim build` first; usage:
//   node scripts/road-audit.mjs [--top 5] [--map name:x:z:size[:px-per-m] ...] [--out dir] [--district file]
// Maps: asphalt strips (grey), junction pads (dark, red outline), lanes (white), connectors (cyan straight,
// magenta left, green right), tracks (brown) and their curves (orange), scenery tracks (light brown), OSM track axes (black dashes), zebras (white), stops (blue).
// They are rasterised by playwright-core with the system Chrome (as the screenshots are).
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { auditRoads, buildCityFromDistrict } from '../dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { values: args } = parseArgs({
  options: {
    top: { type: 'string', default: '5' },
    map: { type: 'string', multiple: true, default: [] },
    out: { type: 'string', default: resolve(root, 'tmp/road-maps') },
    district: { type: 'string', default: resolve(root, 'data/districts/belgrade-center.json') },
  },
});
const district = JSON.parse(readFileSync(args.district, 'utf8'));
const city = buildCityFromDistrict(district);
const audit = auditRoads(city, district);
for (const [check, list] of Object.entries(audit)) {
  console.log(`${check}: ${list.length}`);
  for (const d of list.slice(0, Number(args.top))) console.log(`   (${d.x}, ${d.z}) ${d.size} ${d.note}`);
}
if (args.map.length) await drawMaps(args.map, args.out);

async function drawMaps(maps, out) {
  const P = (p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
  const parts = [];
  for (const a of city.areas) if (a.kind !== 'parking') parts.push(`<path d="M${a.outer.map(P).join('L')}Z" fill="#dfe9d8"/>`);
  for (const b of city.buildings) parts.push(`<path d="M${b.outline.map(P).join('L')}Z" fill="#e9e4f2" stroke="#b9b0cc" stroke-width="0.3"/>`);
  for (const r of city.roads) {
    const left = offset(r.points, -r.left);
    const right = offset(r.points, r.right);
    const fill = r.layer < 0 ? 'none' : r.layer > 0 ? '#8a94a8' : '#9aa0a8';
    parts.push(`<path d="M${[...left, ...right.reverse()].map(P).join('L')}Z" fill="${fill}" stroke="${r.layer < 0 ? '#c33' : 'none'}" stroke-width="0.3"/>`);
  }
  for (const pad of city.pads) parts.push(`<path d="M${pad.outline.map(P).join('L')}Z${pad.island ? `M${pad.island.map(P).join('L')}Z` : ''}" fill-rule="evenodd" fill="#7d8590" fill-opacity="0.85" stroke="#d33" stroke-width="0.25"/>`);
  for (const l of city.lanes) {
    const rail = city.segments[l.seg].rail;
    parts.push(`<polyline points="${l.line.points.map(P).join(' ')}" fill="none" stroke="${rail ? '#8b4a12' : '#fff'}" stroke-width="${rail ? 0.9 : 0.25}"/>`);
  }
  const turnColour = { S: '#2bd', L: '#e5c', R: '#5c5' };
  for (const c of city.connectors) {
    const rail = city.segments[city.lanes[c.from].seg].rail;
    parts.push(`<polyline points="${c.line.points.map(P).join(' ')}" fill="none" stroke="${rail ? '#f07a00' : turnColour[c.turn]}" stroke-width="${rail ? 0.6 : 0.2}"/>`);
  }
  for (const e of district.roads.edges) {
    if (e.cls !== 'tram') continue;
    const pts = [];
    for (let i = 0; i < e.pts.length; i += 2) pts.push(`${e.pts[i]},${e.pts[i + 1]}`);
    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="#000" stroke-width="0.2" stroke-dasharray="0.8 0.8"/>`);
  }
  for (const t of city.tracks) if (t.scenery) parts.push(`<polyline points="${t.points.map(P).join(' ')}" fill="none" stroke="#b07a4a" stroke-width="0.9"/>`);
  for (const c of city.crossings) {
    const d = { x: Math.sin(c.heading), z: Math.cos(c.heading) };
    const r = { x: -d.z, z: d.x };
    const corner = (t, u) => ({ x: c.x + r.x * t + d.x * u, z: c.z + r.z * t + d.z * u });
    const box = [corner(-c.left, -1.4), corner(c.right, -1.4), corner(c.right, 1.4), corner(-c.left, 1.4)];
    parts.push(`<path d="M${box.map(P).join('L')}Z" fill="#fff" fill-opacity="0.8" stroke="#333" stroke-width="0.15"/>`);
  }
  for (const s of city.busStops) parts.push(`<circle cx="${s.x}" cy="${s.z}" r="1.2" fill="#24c"/>`);
  const body = parts.join('');

  const require = createRequire(resolve(root, 'package.json'));
  const { chromium } = require('playwright-core');
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  for (const spec of maps) {
    const [name, x, z, size, ppm = '3'] = spec.split(':');
    const S = Number(size);
    const px = Math.round(S * Number(ppm));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="${x - S / 2} ${z - S / 2} ${S} ${S}" style="background:#f4f4f6">${body}<text x="${x - S / 2 + S * 0.01}" y="${z - S / 2 + S * 0.03}" font-size="${S * 0.025}">${name} (${x}, ${z}) ${S} m</text></svg>`;
    await page.setViewportSize({ width: px, height: px });
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    await page.screenshot({ path: resolve(out, `${name}.png`) });
    console.log(`map ${resolve(out, `${name}.png`)}`);
  }
  await browser.close();
}

/** Polyline shifted d metres to the right (mitred, as the scene draws its strips). */
function offset(points, d) {
  const normals = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    normals.push({ x: -(b.z - a.z) / l, z: (b.x - a.x) / l });
  }
  return points.map((p, i) => {
    const n1 = normals[Math.max(0, i - 1)];
    const n2 = normals[Math.min(normals.length - 1, i)];
    const m = { x: n1.x + n2.x, z: n1.z + n2.z };
    const l = Math.hypot(m.x, m.z) || 1;
    const k = Math.max(0.5, (m.x * n1.x + m.z * n1.z) / l);
    return { x: p.x + (m.x / l / k) * d, z: p.z + (m.z / l / k) * d };
  });
}
