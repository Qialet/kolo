'use client';

import type { PlaceRef } from '@kolo/contracts';
import { getCity } from './city';
import { frameBuffer } from './live';
import { useUi } from './ui-store';

/** Select an object from a list and fly the camera to it. */
export function useFocusSelect() {
  const select = useUi((s) => s.select);
  const focus = useUi((s) => s.focus);
  return {
    taxi(id: string) {
      select({ kind: 'taxi', id });
      const p = frameBuffer.find(id);
      if (p) focus(p[2], p[3], { zoom: 8, follow: id });
    },
    order(id: string, pickup: PlaceRef) {
      select({ kind: 'order', id });
      focus(pickup.x, pickup.z, { zoom: 6 });
    },
    depot(id: string) {
      select({ kind: 'depot', id });
      const d = getCity().depots.find((x) => x.id === id);
      if (d) focus(d.yard.x, d.yard.z, { zoom: 5 });
    },
  };
}
