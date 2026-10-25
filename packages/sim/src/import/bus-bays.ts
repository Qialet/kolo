import type { DistrictStop } from '../city/district.js';
import type { Vec2 } from '../geometry.js';
import type { OsmElement } from './osm-roads.js';
import { segmentDistance } from './polygons.js';
import { project } from './project.js';

/** A stop belongs to a bay way this close to it. */
const BAY_REACH = 20;
/** The stop's direction of travel within 60° of the way (or of its reverse). */
const BAY_ALIGN = Math.cos(Math.PI / 3);

/**
 * Marks stops at an OSM bus bay (bus_bay on the road way): right serves traffic along the way, left the
 * opposite direction of a two-way road (on a one-way road it would be the left kerb, where no bus stops), both either.
 */
export function markBusBays(elements: OsmElement[], stops: DistrictStop[]) {
  const nodes = new Map<number, Vec2>();
  for (const e of elements) if (e.type === 'node' && e.lat !== undefined && e.lon !== undefined) nodes.set(e.id, project({ lat: e.lat, lon: e.lon }));
  for (const e of elements) {
    const side = e.type === 'way' ? e.tags?.bus_bay : undefined;
    if (side !== 'right' && side !== 'left' && side !== 'both') continue;
    const oneway = e.tags!.oneway === 'yes';
    const along = side !== 'left';
    const against = !oneway && side !== 'right';
    const pts = e.nodes!.map((id) => nodes.get(id)).filter((p): p is Vec2 => !!p);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-6) continue;
      for (const stop of stops) {
        if (stop.bay || segmentDistance(stop, a, b) > BAY_REACH) continue;
        const cos = (stop.dir[0] * (b.x - a.x) + stop.dir[1] * (b.z - a.z)) / len;
        if ((along && cos >= BAY_ALIGN) || (against && cos <= -BAY_ALIGN)) stop.bay = true;
      }
    }
  }
}
