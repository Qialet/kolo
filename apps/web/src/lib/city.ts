import { buildCityFromDistrict, type City, type District } from '@kolo/sim';

/** District the console shows; its file is copied to public/districts by scripts/sync-districts.mjs. */
export const DISTRICT_ID = 'belgrade-center';

let cached: City | null = null;
let loading: Promise<City> | null = null;

/**
 * Loads the district file (manifest always fresh, the versioned file from the browser cache)
 * and builds the same city the server simulates. Once per tab.
 */
export function loadCity(): Promise<City> {
  loading ??= (async () => {
    const manifest = (await (await fetch('/districts/manifest.json', { cache: 'no-store' })).json()) as Record<string, { file: string }>;
    const entry = manifest[DISTRICT_ID];
    if (!entry) throw new Error(`District ${DISTRICT_ID} is missing from the manifest`);
    const res = await fetch(`/districts/${entry.file}`, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`District file ${entry.file}: HTTP ${res.status}`);
    cached = buildCityFromDistrict((await res.json()) as District);
    return cached;
  })();
  loading.catch(() => (loading = null));
  return loading;
}

/** The loaded city; only valid below the console's city gate. */
export function getCity(): City {
  if (!cached) throw new Error('City is not loaded yet');
  return cached;
}
