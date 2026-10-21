'use client';

import { LIGHT_ASPECTS, type PlaceRef } from '@kolo/contracts';
import { useEffect, useMemo, useRef } from 'react';
import { getCity } from '@/lib/city';
import { frameBuffer } from '@/lib/live';
import { ACTIVITY_LABEL, palette } from '@/lib/palette';
import { useBus, useOrder, useParks, useTaxi, useVehicles } from '@/lib/queries';
import { useUi } from '@/lib/ui-store';
import { WorldLabel } from './world-labels';

/** All text over the 3D city, rendered as plain DOM and positioned by LabelProjector. */
export function SceneLabels() {
  const city = useMemo(() => getCity(), []);
  const selection = useUi((s) => s.selection);
  const hovered = useUi((s) => s.hovered);
  const labels = useUi((s) => s.labels);
  const hoveredTaxi = hovered?.startsWith('taxi:') ? hovered.slice(5) : null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {labels && <DepotLabels />}
      {labels && <PoiLabels />}
      {selection?.kind === 'taxi' && <TaxiLabels id={selection.id} />}
      {selection?.kind === 'order' && <OrderLabels id={selection.id} />}
      {selection?.kind === 'bus' && <BusLabel id={selection.id} />}
      {selection?.kind === 'car' && <Tag anchor={{ follow: selection.id, y: 4.5 }} title="Частный автомобиль" />}
      {selection?.kind === 'light' && <LightCountdown nodeId={selection.id} x={city.nodes[selection.id]!.x} z={city.nodes[selection.id]!.z} />}
      {selection?.kind === 'building' && <BuildingPin id={selection.id} />}
      {hoveredTaxi && !(selection?.kind === 'taxi' && selection.id === hoveredTaxi) && <HoverPlate id={hoveredTaxi} />}
    </div>
  );
}

function Tag({ anchor, title, status }: { anchor: Parameters<typeof WorldLabel>[0]['anchor']; title: string; status?: string | undefined }) {
  return (
    <WorldLabel anchor={anchor} className="pb-2">
      <div className="flex items-center gap-1.5 rounded-lg bg-white px-2 py-1 text-[11px] font-semibold whitespace-nowrap shadow-lg ring-1 ring-black/5">
        {title}
        {status && <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">{status}</span>}
      </div>
    </WorldLabel>
  );
}

export function Pin({ place, kind }: { place: PlaceRef; kind: 'A' | 'B' | 'target' }) {
  const bg = kind === 'A' ? palette.pickup : kind === 'B' ? palette.dropoff : palette.depot;
  return (
    <WorldLabel anchor={{ x: place.x, y: 3.4, z: place.z }}>
      <div className="flex max-w-60 items-center gap-1.5 rounded-xl bg-white py-1 pr-2.5 pl-1 text-[11px] font-medium shadow-lg ring-1 ring-black/5">
        <span className="grid size-5 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-white" style={{ background: bg }}>
          {kind === 'target' ? '◎' : kind}
        </span>
        <span className="truncate">{place.label}</span>
      </div>
    </WorldLabel>
  );
}

function TaxiLabels({ id }: { id: string }) {
  const { data } = useTaxi(id);
  return (
    <>
      <Tag anchor={{ follow: id, y: 4.5 }} title={data?.plate ?? id} status={data ? ACTIVITY_LABEL[data.activity] : undefined} />
      {data?.order && <Pin place={data.order.pickup} kind="A" />}
      {data?.order && <Pin place={data.order.dropoff} kind="B" />}
      {!data?.order && data?.routeTarget && <Pin place={data.routeTarget} kind="target" />}
    </>
  );
}

function OrderLabels({ id }: { id: string }) {
  const { data } = useOrder(id);
  if (!data) return null;
  const live = data.vehicleId && ['ASSIGNED', 'ARRIVED', 'IN_PROGRESS'].includes(data.status);
  return (
    <>
      <Pin place={data.pickup} kind="A" />
      <Pin place={data.dropoff} kind="B" />
      {live && <Tag anchor={{ follow: data.vehicleId!, y: 4.5 }} title={data.vehiclePlate ?? data.vehicleId!} status={data.code} />}
    </>
  );
}

function BusLabel({ id }: { id: string }) {
  const { data } = useBus(id);
  return <Tag anchor={{ follow: id, y: 6 }} title={`Автобус ${data?.line ?? ''}`} status={data ? `→ ${data.nextStop}` : undefined} />;
}

function HoverPlate({ id }: { id: string }) {
  const vehicles = useVehicles();
  const plate = vehicles.data?.find((v) => v.id === id)?.plate ?? id;
  return (
    <WorldLabel anchor={{ follow: id, y: 4 }} className="pb-1">
      <div className="rounded-md bg-foreground px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-background">{plate}</div>
    </WorldLabel>
  );
}

function BuildingPin({ id }: { id: string }) {
  const city = getCity();
  const b = city.buildings.find((x) => x.id === id);
  const addr = b?.addressId ? city.addressById.get(b.addressId) : undefined;
  if (!addr) return null;
  return <Pin place={{ addressId: addr.id, label: addr.label, x: addr.x, z: addr.z }} kind="target" />;
}

function DepotLabels() {
  const city = getCity();
  const parks = useParks();
  const select = useUi((s) => s.select);
  return (
    <>
      {city.depots.map((d) => {
        const park = parks.data?.find((p) => p.id === d.id);
        return (
          <WorldLabel key={d.id} anchor={{ x: d.yard.x, y: 8, z: d.yard.z }} interactive>
            <button
              type="button"
              onClick={() => select({ kind: 'depot', id: d.id })}
              className="flex items-center gap-1.5 rounded-full bg-depot py-1 pr-2.5 pl-1 text-[11px] font-semibold whitespace-nowrap text-white shadow-md"
            >
              <span className="rounded-full bg-white/25 px-1.5">{d.id}</span>
              {d.name}
              {park && (
                <span className="tabular text-white/80">
                  {park.counts.inPark + park.counts.maintenance}/{park.capacity}
                </span>
              )}
            </button>
          </WorldLabel>
        );
      })}
    </>
  );
}

function PoiLabels() {
  const city = getCity();
  const select = useUi((s) => s.select);
  const pois = useMemo(() => city.buildings.filter((b) => b.kind === 'poi' && b.name), [city]);
  return (
    <>
      {pois.map((p) => (
        <WorldLabel key={p.id} anchor={{ x: p.x, y: p.h + 3, z: p.z }} interactive>
          <button
            type="button"
            onClick={() => select({ kind: 'building', id: p.id })}
            className="rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap shadow ring-1 ring-black/5"
          >
            {p.name}
          </button>
        </WorldLabel>
      ))}
    </>
  );
}

/** Countdown over the selected junction, ticking locally between frames. */
function LightCountdown({ nodeId, x, z }: { nodeId: number; x: number; z: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const st = frameBuffer.latest?.lights[nodeId];
      const el = ref.current;
      if (!el || !st) return;
      const elapsed = (performance.now() - frameBuffer.latestAt) / 1000;
      const part = (aspect: number, left: number, label: string) => {
        const name = LIGHT_ASPECTS[aspect];
        const dot = name === 'GREEN' ? palette.green : name === 'RED' || name === 'RED_AMBER' ? palette.red : palette.amber;
        const secs = left < 0 ? '∞' : `${Math.max(0, Math.ceil(left - elapsed))} с`;
        return `<span style="display:inline-flex;align-items:center;gap:6px"><i style="width:9px;height:9px;border-radius:9px;background:${dot};box-shadow:0 0 8px ${dot}"></i>${label} ${secs}</span>`;
      };
      el.innerHTML = part(st[0], st[2], 'С–Ю') + part(st[1], st[3], 'З–В');
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [nodeId]);
  return (
    <WorldLabel anchor={{ x, y: 8, z }}>
      <div ref={ref} className="tabular flex gap-3 rounded-full bg-foreground px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-background shadow-lg" />
    </WorldLabel>
  );
}
