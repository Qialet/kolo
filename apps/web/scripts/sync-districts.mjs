// Copies data/districts/*.json into public/districts/<id>.<version>.json and writes manifest.json,
// so the browser caches each district version under its own name. Runs before dev and build.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(web, '../../data/districts');
const target = join(web, 'public/districts');
mkdirSync(target, { recursive: true });

const manifest = {};
for (const name of readdirSync(source).filter((f) => f.endsWith('.json'))) {
  const text = readFileSync(join(source, name), 'utf8');
  const { id, version } = JSON.parse(text).meta;
  const file = `${id}.${version}.json`;
  for (const old of readdirSync(target)) if (old.startsWith(`${id}.`) && old !== file) rmSync(join(target, old));
  writeFileSync(join(target, file), text);
  manifest[id] = { file, version };
}
writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`districts: ${Object.values(manifest).map((m) => m.file).join(', ')}`);
