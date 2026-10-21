'use client';

import { Building2Icon, BusIcon, MapPinIcon, WarehouseIcon } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { getCity } from '@/lib/city';
import { FLEET_LABEL, fleetTone } from '@/lib/palette';
import { useParks, useVehicles } from '@/lib/queries';
import { useUi } from '@/lib/ui-store';
import { Row, StatusBadge } from './common';
import { InspectorHeader, Section } from './inspector';

export function DepotInspector({ id }: { id: string }) {
  const depot = getCity().depots.find((d) => d.id === id)!;
  const parks = useParks();
  const vehicles = useVehicles();
  const focus = useUi((s) => s.focus);
  const select = useUi((s) => s.select);
  const park = parks.data?.find((p) => p.id === id);
  const cars = vehicles.data?.filter((v) => v.parkId === id) ?? [];
  const parked = park ? park.counts.inPark + park.counts.maintenance : 0;
  return (
    <>
      <InspectorHeader
        icon={<WarehouseIcon className="size-5" />}
        iconClass="bg-depot text-white"
        eyebrow={`Таксопарк · ${id}`}
        title={depot.name}
        subtitle={park ? `${park.partner.name} · ${park.address}` : undefined}
        onFocus={() => focus(depot.yard.x, depot.yard.z, { zoom: 6 })}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Вместимость">
          <div className="flex items-baseline justify-between">
            <span className="tabular text-[22px] font-bold">
              {parked}
              <span className="text-sm font-medium text-muted-foreground">/{park?.capacity ?? depot.slots.length} мест</span>
            </span>
            <span className="text-[12px] text-muted-foreground">{depot.boxes.length} сервисных бокса</span>
          </div>
          <Progress value={park ? (parked / park.capacity) * 100 : 0} className="mt-2" />
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <Stat label="На линии" value={park?.counts.onLine} />
            <Stat label="Ждут водителя" value={park?.counts.inPark} />
            <Stat label="В ремонте" value={park?.counts.maintenance} />
          </div>
        </Section>
        <Separator />
        <Section title={`Автомобили парка · ${cars.length}`}>
          <ul className="flex flex-col">
            {cars.map((v) => (
              <li key={v.id}>
                <button type="button" onClick={() => select({ kind: 'taxi', id: v.id })} className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[13px] hover:bg-muted">
                  <span className="size-2 rounded-full bg-taxi" />
                  <span className="font-medium">{v.plate}</span>
                  <span className="truncate text-muted-foreground">{v.driverName}</span>
                  <StatusBadge tone={fleetTone(v.fleetStatus)} className="ml-auto">
                    {FLEET_LABEL[v.fleetStatus]}
                  </StatusBadge>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="rounded-xl bg-muted/60 px-2 py-2">
      <div className="tabular text-[17px] font-bold">{value ?? '—'}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  residential: 'Жилой дом',
  office: 'Офисное здание',
  poi: 'Точка притяжения',
  garage: 'Сервисные боксы',
  'depot-office': 'Офис таксопарка',
  stall: 'Торговый павильон',
  kiosk: 'Киоск',
  shed: 'Дворовые гаражи',
  outbuilding: 'Дворовый флигель',
};

export function BuildingInspector({ id }: { id: string }) {
  const city = getCity();
  const b = city.buildings.find((x) => x.id === id)!;
  const addr = b.addressId ? city.addressById.get(b.addressId) : undefined;
  const focus = useUi((s) => s.focus);
  const openCreate = useUi((s) => s.openCreateOrder);
  const floors = Math.max(1, Math.round(b.h / 3.2));
  return (
    <>
      <InspectorHeader
        icon={<Building2Icon className="size-5" />}
        iconClass="bg-secondary text-foreground"
        eyebrow={KIND_LABEL[b.kind] ?? 'Здание'}
        title={b.name ?? addr?.label ?? 'Без адреса'}
        subtitle={b.name ? addr?.label : `${floors} этаж(ей) · ${Math.round(b.w * b.d)} м² в плане`}
        onFocus={() => focus(b.x, b.z, { zoom: 8 })}
      />
      <Section title="Адрес и подъезд">
        {addr ? (
          <>
            <Row label="Адрес">{addr.label}</Row>
            <Row label="Точка подачи">у бордюра, {city.streets[addr.street]!.name}</Row>
            <Row label="Этажность">{floors}</Row>
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">Здание стоит во дворе и не имеет отдельной точки подачи.</p>
        )}
      </Section>
      {addr && (
        <>
          <Separator />
          <Section title="Действия">
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" onClick={() => openCreate({ pickupId: addr.id })}>
                <MapPinIcon data-icon="inline-start" />
                Заказ отсюда
              </Button>
              <Button size="sm" variant="outline" onClick={() => openCreate({ dropoffId: addr.id })}>
                Заказ сюда
              </Button>
            </div>
          </Section>
        </>
      )}
    </>
  );
}

export function StopInspector({ id }: { id: string }) {
  const city = getCity();
  const stop = city.busStops.find((s) => s.id === id)!;
  const focus = useUi((s) => s.focus);
  const openCreate = useUi((s) => s.openCreateOrder);
  const lines = useMemo(() => city.busLines.filter((l) => stop.lines.includes(l.id)), [city, stop]);
  return (
    <>
      <InspectorHeader
        icon={<BusIcon className="size-5" />}
        iconClass="bg-bus text-white"
        eyebrow="Остановка ГСП"
        title={stop.name}
        subtitle={`Линии: ${stop.lines.join(', ')}`}
        onFocus={() => focus(stop.x, stop.z, { zoom: 9 })}
      />
      <Section title="Маршруты">
        {lines.map((l) => (
          <Row key={l.id} label={<StatusBadge tone="bus">{l.id}</StatusBadge>}>
            {l.name}
          </Row>
        ))}
      </Section>
      <Separator />
      <Section title="Спрос">
        <p className="mb-2 text-[12px] text-muted-foreground">Около 40% заказов в районе создаётся у остановок — свободные такси дежурят неподалёку.</p>
        <Button size="sm" className="w-full" onClick={() => openCreate({ pickupId: stop.id })}>
          <MapPinIcon data-icon="inline-start" />
          Заказ от остановки
        </Button>
      </Section>
    </>
  );
}
