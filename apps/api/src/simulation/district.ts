import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { District } from '@kolo/sim';

const DISTRICT = join('data', 'districts', 'belgrade-center.json');

/** The district file: DISTRICT_FILE, else data/districts/belgrade-center.json in the nearest parent folder. */
export function resolveDistrictFile(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
  const explicit = env['DISTRICT_FILE'];
  if (explicit) {
    const file = resolve(cwd, explicit);
    if (!existsSync(file)) throw new Error(`DISTRICT_FILE not found: ${file}`);
    return file;
  }
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const file = join(dir, DISTRICT);
    if (existsSync(file)) return file;
    if (dirname(dir) === dir) throw new Error(`District file ${DISTRICT} not found above ${cwd}; set DISTRICT_FILE`);
  }
}

export function loadDistrict(file = resolveDistrictFile()): District {
  return JSON.parse(readFileSync(file, 'utf8')) as District;
}
