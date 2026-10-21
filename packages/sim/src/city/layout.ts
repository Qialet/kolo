import type { StreetClass } from './types.js';

/**
 * Hand-tuned layout of a ~1 km² Belgrade-like district (Vračar flavour):
 * an irregular grid, two four-lane boulevards crossing near the centre,
 * perimeter blocks with courtyards, a park and three partner taxi depots.
 */
export interface StreetSpec {
  name: string;
  coord: number;
  cls?: StreetClass;
}

export const WORLD_HALF = 530;
export const SIDEWALK = 4.5;

/** North–south streets, west to east. */
export const NS_STREETS: StreetSpec[] = [
  { name: 'Takovska', coord: -470 },
  { name: 'Kosovska', coord: -340 },
  { name: 'Resavska', coord: -215 },
  { name: 'Bulevar kralja Milana', coord: -80, cls: 'boulevard' },
  { name: 'Njegoševa', coord: 60 },
  { name: 'Makenzijeva', coord: 190 },
  { name: 'Krunska', coord: 330 },
  { name: 'Beogradska', coord: 470 },
];

/** East–west streets, north to south. */
export const EW_STREETS: StreetSpec[] = [
  { name: 'Dečanska', coord: -470 },
  { name: 'Svetogorska', coord: -330 },
  { name: 'Kneza Miloša', coord: -195 },
  { name: 'Bulevar kralja Aleksandra', coord: -55, cls: 'boulevard' },
  { name: 'Nemanjina', coord: 85 },
  { name: 'Molerova', coord: 215 },
  { name: 'Kursulina', coord: 345 },
  { name: 'Mileševska', coord: 470 },
];

/** Street segments that do not exist (they merge two blocks). */
export const REMOVED_SEGMENTS: { axis: 'NS' | 'EW'; col: number; row: number }[] = [
  // Makenzijeva is interrupted by the park between Svetogorska and Kneza Miloša.
  { axis: 'NS', col: 5, row: 1 },
  // Molerova ends at Kosovska: the Avala depot occupies a double block.
  { axis: 'EW', col: 0, row: 5 },
];

export type SpecialBlock =
  | { kind: 'park'; name: string }
  | { kind: 'depot'; depotId: string; name: string; capacity: number; boxes: number }
  | { kind: 'poi'; poiId: string; name: string; poi: 'mall' | 'hospital' | 'station' | 'university' | 'hotel'; weight: number }
  | { kind: 'market'; poiId: string; name: string; weight: number };

/** Keyed by "blockCol,blockRow" of the block's top-left grid cell (cells are 0..8). */
export const SPECIAL_BLOCKS: Record<string, SpecialBlock> = {
  '5,2': { kind: 'park', name: 'Park Vračar' },
  '1,5': { kind: 'depot', depotId: 'P1', name: 'Avala Fleet', capacity: 16, boxes: 4 },
  '7,1': { kind: 'depot', depotId: 'P2', name: 'Sava Motors', capacity: 10, boxes: 3 },
  '6,7': { kind: 'depot', depotId: 'P3', name: 'Dunav Taxi', capacity: 10, boxes: 2 },
  '4,4': { kind: 'poi', poiId: 'mall', name: 'TC Kolo Plaza', poi: 'mall', weight: 3 },
  '2,3': { kind: 'poi', poiId: 'hospital', name: 'Klinički centar', poi: 'hospital', weight: 2 },
  '5,6': { kind: 'poi', poiId: 'station', name: 'Glavna stanica', poi: 'station', weight: 3 },
  '3,2': { kind: 'poi', poiId: 'university', name: 'Univerzitet', poi: 'university', weight: 2 },
  '4,2': { kind: 'poi', poiId: 'hotel', name: 'Hotel Sava', poi: 'hotel', weight: 2 },
  '6,4': { kind: 'market', poiId: 'market', name: 'Kalenić pijaca', weight: 2 },
};

/** Bus loops as grid waypoints (col,row); consecutive waypoints share a row or a column. */
export const BUS_LINES: { id: string; name: string; waypoints: [number, number][] }[] = [
  { id: '26', name: 'Dorćol – Bulevar', waypoints: [[0, 3], [7, 3], [7, 4], [0, 4], [0, 3]] },
  { id: '31', name: 'Kralja Milana – Krunska', waypoints: [[3, 0], [3, 7], [6, 7], [6, 0], [3, 0]] },
  { id: 'E2', name: 'Kosovska – Njegoševa', waypoints: [[1, 1], [4, 1], [4, 6], [1, 6], [1, 1]] },
];
