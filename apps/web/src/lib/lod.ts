/**
 * Level of detail for the orthographic city view and the spatial chunks static meshes are cut into.
 * Plain module without imports so Node runs its tests directly.
 */

export type Lod = 'near' | 'far';

/** Zoom is pixels per metre: from 2.6 the near models, below 2.2 the far ones, in between the level stays. */
const NEAR_FROM = 2.6;
const FAR_BELOW = 2.2;

export function nextLod(zoom: number, prev: Lod): Lod {
  if (zoom >= NEAR_FROM) return 'near';
  if (zoom < FAR_BELOW) return 'far';
  return prev;
}

/** Side of a square chunk, metres, on a grid from the world origin. */
export const CHUNK = 400;

export interface ChunkCell {
  key: string;
  cx: number;
  cz: number;
  /** Indexes of the points in this cell, ascending. */
  items: number[];
}

export function chunkCells(points: readonly { x: number; z: number }[], size = CHUNK): ChunkCell[] {
  const cells = new Map<string, ChunkCell>();
  points.forEach((p, i) => {
    const cx = Math.floor(p.x / size);
    const cz = Math.floor(p.z / size);
    const key = `${cx}:${cz}`;
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { key, cx, cz, items: [] }));
    cell.items.push(i);
  });
  return [...cells.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Half side of the square the sun's shadow covers around the camera target, metres. */
export function shadowExtent(width: number, height: number, zoom: number): number {
  return Math.min(1400, Math.max(200, (Math.max(width, height) * 0.75) / zoom));
}
