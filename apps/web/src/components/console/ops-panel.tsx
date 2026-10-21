'use client';

import { TAXI_ACTIVITIES } from '@kolo/contracts';
import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { frameBuffer, useLive } from '@/lib/live';
import { ACTIVITY_LABEL, activityTone, FLEET_LABEL, fleetTone, ORDER_LABEL, orderTone } from '@/lib/palette';
import { useDisputes, useOrders, useParks, useVehicles } from '@/lib/queries';
import { useFocusSelect } from '@/lib/use-focus-select';
import { useUi } from '@/lib/ui-store';
import { cn } from '@/lib/utils';
import { fmtRsd, StatusBadge } from './common';

/** Bottom-right operations panel: live orders, fleet, depots and disputes. */
export function OpsPanel() {
  const activeOrders = useLive((s) => s.orders);
  const disputes = useDisputes('OPEN');
  const parks = useParks();
  const vehicles = useVehicles();
  const filter = useUi((s) => s.parkFilter);
  const active = Object.keys(activeOrders).length;
  const fleet = vehicles.data?.filter((v) => !filter || v.parkId === filter) ?? [];
  // Phones start with the lists folded so the map stays visible; wider screens always show them.
  const [open, setOpen] = useState(false);
  return (
    <div className="glass-panel pointer-events-auto w-[440px] p-2 max-md:w-full">
      <Tabs defaultValue="orders" onValueChange={() => setOpen(true)}>
        <div className="flex items-center justify-between gap-1 px-1">
          <TabsList className="max-sm:[&_.count]:hidden">
            <TabsTrigger value="orders">
              Заказы <span className="count tabular text-muted-foreground">{active}</span>
            </TabsTrigger>
            <TabsTrigger value="fleet">
              Флот <span className="count tabular text-muted-foreground">{fleet.length}</span>
            </TabsTrigger>
            <TabsTrigger value="parks">
              Парки <span className="count tabular text-muted-foreground">{parks.data?.length ?? 0}</span>
            </TabsTrigger>
            <TabsTrigger value="disputes">
              Возражения <span className="count tabular text-muted-foreground">{disputes.data?.length ?? 0}</span>
            </TabsTrigger>
          </TabsList>
          <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setOpen((v) => !v)} aria-label={open ? 'Свернуть' : 'Развернуть'}>
            {open ? <ChevronDownIcon /> : <ChevronUpIcon />}
          </Button>
        </div>
        <div className={cn(!open && 'max-md:hidden')}>
          <TabsContent value="orders">
            <OrdersList />
          </TabsContent>
          <TabsContent value="fleet">
            <FleetList />
          </TabsContent>
          <TabsContent value="parks">
            <ParksList />
          </TabsContent>
          <TabsContent value="disputes">
            <DisputesList />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function ListRow({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <li>
      <button type="button" onClick={onClick} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-muted">
        {children}
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}

function OrdersList() {
  const live = useLive((s) => s.orders);
  const recent = useOrders('COMPLETED,CANCELLED,NO_SHOW,EXPIRED');
  const go = useFocusSelect();
  const activeList = useMemo(() => Object.values(live).sort((a, b) => b.createdAt - a.createdAt), [live]);
  return (
    <ScrollArea className="h-[208px] max-md:h-[32dvh]">
      <ul className="flex flex-col px-0.5">
        {activeList.map((o) => (
          <ListRow key={o.id} onClick={() => go.order(o.id, o.pickup)}>
            <div className="w-[68px] shrink-0">
              <div className="font-semibold">{o.code}</div>
              <div className="truncate text-[11px] text-muted-foreground">{o.passengerName}</div>
            </div>
            <div className="min-w-0 flex-1 text-[12px]">
              <div className="truncate">{o.pickup.label}</div>
              <div className="truncate text-muted-foreground">→ {o.dropoff.label}</div>
            </div>
            <StatusBadge tone={orderTone(o.status)}>{ORDER_LABEL[o.status]}</StatusBadge>
          </ListRow>
        ))}
        {recent.data?.slice(0, 20).map((o) => (
          <ListRow key={o.id} onClick={() => go.order(o.id, o.pickup)}>
            <div className="w-[68px] shrink-0">
              <div className="font-semibold text-muted-foreground">{o.code}</div>
              <div className="truncate text-[11px] text-muted-foreground">{o.vehiclePlate ?? '—'}</div>
            </div>
            <div className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{o.dropoff.label}</div>
            <span className="tabular text-[12px] text-muted-foreground">{o.status === 'COMPLETED' ? fmtRsd(o.fareRsd) : ''}</span>
            <StatusBadge tone={orderTone(o.status)}>{ORDER_LABEL[o.status]}</StatusBadge>
          </ListRow>
        ))}
      </ul>
    </ScrollArea>
  );
}

function FleetList() {
  const vehicles = useVehicles();
  const go = useFocusSelect();
  const filter = useUi((s) => s.parkFilter);
  const kpi = useLive((s) => s.kpi);
  // Live activity from the latest frame (kpi ticks once per second and re-renders the list).
  const activities = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of frameBuffer.latest?.vehicles ?? []) {
      if (v[1] === 0 && v[6] >= 0) map.set(v[0], TAXI_ACTIVITIES[v[6]]!);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kpi]);
  const list = vehicles.data?.filter((v) => !filter || v.parkId === filter) ?? [];
  return (
    <ScrollArea className="h-[208px] max-md:h-[32dvh]">
      <ul className="flex flex-col px-0.5">
        {list.map((v) => {
          const activity = activities.get(v.id);
          return (
            <ListRow key={v.id} onClick={() => go.taxi(v.id)}>
              <span className="size-2.5 shrink-0 rounded-full bg-taxi ring-2 ring-taxi/25" />
              <div className="w-24 shrink-0">
                <div className="font-semibold">{v.plate}</div>
                <div className="text-[11px] text-muted-foreground">{v.parkCode}</div>
              </div>
              <div className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{v.driverName}</div>
              {activity && v.fleetStatus === 'ON_LINE' ? (
                <StatusBadge tone={activityTone(activity)}>{ACTIVITY_LABEL[activity]}</StatusBadge>
              ) : (
                <StatusBadge tone={fleetTone(v.fleetStatus)}>{FLEET_LABEL[v.fleetStatus]}</StatusBadge>
              )}
            </ListRow>
          );
        })}
      </ul>
    </ScrollArea>
  );
}

function ParksList() {
  const parks = useParks();
  const go = useFocusSelect();
  return (
    <ScrollArea className="h-[208px] max-md:h-[32dvh]">
      <ul className="flex flex-col px-0.5">
        {parks.data?.map((p) => (
          <ListRow key={p.id} onClick={() => go.depot(p.id)}>
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-depot text-[11px] font-bold text-white">{p.id}</span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{p.name}</div>
              <div className="truncate text-[11px] text-muted-foreground">{p.partner.name}</div>
            </div>
            <div className="tabular text-right text-[12px]">
              <div>
                <span className="font-semibold">{p.counts.onLine}</span> на линии
              </div>
              <div className="text-muted-foreground">
                {p.counts.inPark + p.counts.maintenance}/{p.capacity} мест · {p.counts.maintenance} рем.
              </div>
            </div>
          </ListRow>
        ))}
      </ul>
    </ScrollArea>
  );
}

function DisputesList() {
  const disputes = useDisputes('OPEN');
  const select = useUi((s) => s.select);
  return (
    <ScrollArea className="h-[208px] max-md:h-[32dvh]">
      <ul className="flex flex-col px-0.5">
        {disputes.data?.map((d) => (
          <ListRow key={d.id} onClick={() => select({ kind: 'order', id: d.orderId })}>
            <span className="size-2 shrink-0 rounded-full bg-destructive" />
            <div className="w-[68px] shrink-0 font-semibold">{d.orderCode}</div>
            <div className="min-w-0 flex-1 truncate text-[12px]">{d.reason}</div>
            <span className="tabular text-[11px] text-muted-foreground">{new Date(d.openedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
          </ListRow>
        ))}
        {!disputes.data?.length && <li className="px-2 py-8 text-center text-[13px] text-muted-foreground">Открытых возражений нет</li>}
      </ul>
    </ScrollArea>
  );
}
