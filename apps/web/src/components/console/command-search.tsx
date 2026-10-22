'use client';

import { BusIcon, CarTaxiFrontIcon, MapPinIcon, ReceiptTextIcon, RouteIcon, WarehouseIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CommandDialog, Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { getCity } from '@/lib/city';
import { frameBuffer, useLive } from '@/lib/live';
import { useVehicles } from '@/lib/queries';
import { searchItems } from '@/lib/search';
import { useUi } from '@/lib/ui-store';

/** Rows per group: thousands of real addresses would make the palette sluggish. */
const LIMIT = 50;

/** Ctrl/⌘+K palette: taxis, live orders, depots, transit lines, stops and addresses. */
export function CommandSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const vehicles = useVehicles();
  const orders = useLive((s) => s.orders);
  const select = useUi((s) => s.select);
  const focus = useUi((s) => s.focus);
  const city = getCity();
  const sorted = useMemo(() => city.addresses.slice().sort((a, b) => a.label.localeCompare(b.label, 'sr', { numeric: true })), [city]);
  const [query, setQuery] = useState('');
  const taxis = searchItems(vehicles.data ?? [], query, (v) => `${v.plate} ${v.driverName ?? ''} ${v.id}`, LIMIT);
  const liveOrders = searchItems(Object.values(orders), query, (o) => `${o.code} ${o.pickup.label} ${o.dropoff.label} ${o.passengerName}`, LIMIT);
  const depots = searchItems(city.depots, query, (d) => `${d.name} ${d.id} парк`, LIMIT);
  const stops = searchItems(city.busStops, query, (s) => `остановка ${s.name}`, LIMIT);
  const lines = searchItems(city.busLines, query, (l) => `линия ${l.name} ${l.longName}`, LIMIT);
  const addresses = searchItems(sorted, query, (a) => a.label, LIMIT);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const go = (fn: () => void) => {
    fn();
    onOpenChange(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Поиск" description="Такси, заказы, парки, линии, остановки, адреса">
      <Command shouldFilter={false}>
        <CommandInput placeholder="Номер такси, водитель, код заказа, линия, адрес…" value={query} onValueChange={setQuery} />
        <CommandList className="max-h-[420px]">
          <CommandEmpty>Ничего не найдено</CommandEmpty>
          <CommandGroup heading="Такси">
            {taxis.map((v) => (
              <CommandItem
                key={v.id}
                value={`${v.plate} ${v.driverName ?? ''} ${v.id}`}
                onSelect={() =>
                  go(() => {
                    select({ kind: 'taxi', id: v.id });
                    const p = frameBuffer.find(v.id);
                    if (p) focus(p[2], p[3], { zoom: 8, follow: v.id });
                  })
                }
              >
                <CarTaxiFrontIcon />
                {v.plate}
                <span className="text-muted-foreground">{v.driverName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Активные заказы">
            {liveOrders.map((o) => (
              <CommandItem key={o.id} value={`${o.code} ${o.pickup.label} ${o.dropoff.label} ${o.passengerName}`} onSelect={() => go(() => (select({ kind: 'order', id: o.id }), focus(o.pickup.x, o.pickup.z, { zoom: 6 })))}>
                <ReceiptTextIcon />
                {o.code}
                <span className="truncate text-muted-foreground">{o.pickup.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Таксопарки">
            {depots.map((d) => (
              <CommandItem key={d.id} value={`${d.name} ${d.id} парк`} onSelect={() => go(() => (select({ kind: 'depot', id: d.id }), focus(d.yard.x, d.yard.z, { zoom: 5 })))}>
                <WarehouseIcon />
                {d.name}
              </CommandItem>
            ))}
          </CommandGroup>
          {lines.length > 0 && (
            <CommandGroup heading="Линии">
              {lines.map((l) => (
                <CommandItem
                  key={l.id}
                  value={`линия ${l.name} ${l.longName}`}
                  onSelect={() =>
                    go(() => {
                      select({ kind: 'line', id: l.id });
                      const at = city.busStops.filter((s) => s.lines.includes(l.id));
                      if (at.length) focus(at.reduce((a, s) => a + s.x, 0) / at.length, at.reduce((a, s) => a + s.z, 0) / at.length, { zoom: 3 });
                    })
                  }
                >
                  <RouteIcon />
                  <span className="rounded px-1 text-[12px] font-bold" style={{ backgroundColor: l.color, color: l.textColor }}>
                    {l.name}
                  </span>
                  <span className="truncate text-muted-foreground">{l.longName}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {stops.length > 0 && (
          <CommandGroup heading="Остановки">
            {stops.map((s) => (
              <CommandItem key={s.id} value={`остановка ${s.name}`} onSelect={() => go(() => (select({ kind: 'stop', id: s.id }), focus(s.x, s.z, { zoom: 8 })))}>
                <BusIcon />
                {s.name}
              </CommandItem>
            ))}
          </CommandGroup>
          )}
          <CommandGroup heading="Адреса">
            {addresses.map((a) => (
              <CommandItem
                key={a.id}
                value={a.label}
                onSelect={() =>
                  go(() => {
                    if (a.buildingId) select({ kind: 'building', id: a.buildingId });
                    focus(a.x, a.z, { zoom: 8 });
                  })
                }
              >
                <MapPinIcon />
                {a.label}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
