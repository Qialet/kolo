import { buildCity, type City } from '@kolo/sim';

let cached: City | null = null;

/** The same deterministic city the server simulates (built once per tab). */
export function getCity(): City {
  cached ??= buildCity();
  return cached;
}
