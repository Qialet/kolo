'use client';

import type { TransitMode, VehicleKind } from '@kolo/contracts';
import { BusFrontIcon, BusIcon, MapPinIcon, RouteIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { delayInfo, fmtClock, untilLabel, useSimClock } from '@/lib/belgrade';
import { getCity } from '@/lib/city';
import { frameBuffer } from '@/lib/live';
import { useBus, useLine, useStop } from '@/lib/queries';
import { useUi } from '@/lib/ui-store';
import { cn } from '@/lib/utils';
import { fmtDuration, StatusBadge } from './common';
import { InspectorHeader, InspectorSkeleton, Section } from './inspector';

const KIND_LABEL: Record<VehicleKind, string> = { TAXI: 'Такси', CAR: 'Машина', BUS: 'Автобус', TROLLEY: 'Троллейбус', MINIBUS: 'Минибус' };
const MODE_LABEL: Record<TransitMode, string> = { bus: 'Автобусная линия', trolley: 'Троллейбусная линия', minibus: 'Линия минибусов' };

/** Line number on its GTFS colours. */
export function LineBadge({ line, className, onClick }: { line: { name: string; color: string; textColor: string }; className?: string; onClick?: () => void }) {
  const style = { backgroundColor: line.color, color: line.textColor };
  const cls = cn('inline-flex h-6 min-w-8 shrink-0 items-center justify-center rounded-md px-1.5 text-[12px] font-bold tabular', className);
  return onClick ? (
    <button type="button" className={cn(cls, 'transition-opacity hover:opacity-80')} style={style} onClick={onClick}>
      {line.name}
    </button>
  ) : (
    <span className={cls} style={style}>
      {line.name}
    </span>
  );
}

function Scroll({ children }: { children: ReactNode }) {
  return <div className="max-h-64 overflow-y-auto pr-1">{children}</div>;
}

const focusVehicle = (focus: ReturnType<typeof useUi.getState>['focus'], id: string) => {
  const p = frameBuffer.find(id);
  if (p) focus(p[2], p[3], { zoom: 8, follow: id });
};

// ───────────────────────────── vehicle ─────────────────────────────

export function BusInspector({ id }: { id: string }) {
  const { data } = useBus(id);
  const focus = useUi((s) => s.focus);
  const select = useUi((s) => s.select);
  const { clock } = useSimClock();
  if (!data) return <InspectorSkeleton />;
  const delay = delayInfo(data.delaySec);
  return (
    <>
      <InspectorHeader
        icon={<BusFrontIcon className="size-5" />}
        iconClass="text-white"
        iconStyle={{ backgroundColor: data.color, color: data.textColor }}
        eyebrow={`${KIND_LABEL[data.kind]} · линия ${data.lineName}`}
        title={`→ ${data.headsign}`}
        subtitle={`${data.speedKmh} км/ч · ${data.passengers} пассажиров`}
        onFocus={() => focusVehicle(focus, id)}
      />
      <div className="flex items-center gap-2 px-4 pb-2">
        <StatusBadge tone={delay.onTime ? 'success' : delay.late ? 'danger' : 'info'}>{delay.label}</StatusBadge>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => select({ kind: 'line', id: data.lineId })}>
          <RouteIcon data-icon="inline-start" />
          Линия {data.lineName}
        </Button>
      </div>
      <Section title="Следующая остановка">
        <div className="rounded-xl bg-bus/8 p-3">
          <div className="text-[14px] font-semibold">{data.nextStop}</div>
          <div className="mt-1 text-[12px] text-muted-foreground">
            {data.dwellLeftSec > 0 && data.nextStopAt === null
              ? `Последняя остановка в районе · ещё ${data.dwellLeftSec} с`
              : data.dwellLeftSec > 0
              ? `Посадка пассажиров · отправление через ${data.dwellLeftSec} с`
              : data.nextStopAt !== null
                ? `Прибытие в ${fmtClock(data.nextStopAt)}${clock !== null ? ` · ${untilLabel(data.nextStopAt, clock)}` : ''}`
                : `Конечная · ≈ ${fmtDuration(data.etaSec)}`}
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Позиция — по расписанию GSP Beograd: реального GPS у городского транспорта нет.</p>
      </Section>
    </>
  );
}

// ───────────────────────────── stop ─────────────────────────────

export function StopInspector({ id }: { id: string }) {
  const stop = getCity().busStops.find((s) => s.id === id)!;
  const { data } = useStop(id);
  const { clock } = useSimClock();
  const focus = useUi((s) => s.focus);
  const select = useUi((s) => s.select);
  const openCreate = useUi((s) => s.openCreateOrder);
  return (
    <>
      <InspectorHeader
        icon={<BusIcon className="size-5" />}
        iconClass="bg-bus text-white"
        eyebrow={`Остановка ГСП · № ${stop.code}`}
        title={stop.name}
        subtitle={data ? `${data.lines.length} линий` : undefined}
        onFocus={() => focus(stop.x, stop.z, { zoom: 9 })}
      />
      {data && (
        <div className="flex flex-wrap gap-1 px-4 pb-2">
          {data.lines.map((l) => (
            <LineBadge key={l.id} line={l} onClick={() => select({ kind: 'line', id: l.id })} />
          ))}
        </div>
      )}
      <Section title="Ближайшие отправления">
        {!data ? (
          <InspectorSkeleton />
        ) : data.departures.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">В ближайший час рейсов нет.</p>
        ) : (
          <Scroll>
            {data.departures.map((d) => {
              const late = Math.round((d.expectedAt - d.scheduledAt) / 60_000);
              return (
                <button
                  type="button"
                  key={`${d.lineId}-${d.scheduledAt}-${d.vehicleId ?? ''}`}
                  className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left hover:bg-muted/60 disabled:hover:bg-transparent"
                  disabled={!d.vehicleId}
                  onClick={() => {
                    if (!d.vehicleId) return;
                    select({ kind: 'bus', id: d.vehicleId });
                    focusVehicle(focus, d.vehicleId);
                  }}
                >
                  <LineBadge line={d} />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{d.headsign}</span>
                  <span className="text-right text-[12px] leading-tight whitespace-nowrap">
                    <span className="font-semibold">{clock !== null ? untilLabel(d.expectedAt, clock) : fmtClock(d.expectedAt)}</span>
                    <span className={cn('block text-[11px]', late >= 1 ? 'text-destructive' : 'text-muted-foreground')}>
                      {late >= 1 ? `+${late} мин · ${fmtClock(d.scheduledAt)}` : fmtClock(d.scheduledAt)}
                    </span>
                  </span>
                </button>
              );
            })}
          </Scroll>
        )}
      </Section>
      <Separator />
      <Section title="Спрос">
        <p className="mb-2 text-[12px] text-muted-foreground">Около 40% заказов в районе создаётся у остановок — свободные такси дежурят неподалёку.</p>
        {data?.pickup === false ? (
          <p className="text-[12px] text-muted-foreground">Такси сюда не подъезжают: остановка на выделенной или транзитной полосе.</p>
        ) : (
          <Button size="sm" className="w-full" disabled={!data} onClick={() => openCreate({ pickupId: stop.id })}>
            <MapPinIcon data-icon="inline-start" />
            Заказ от остановки
          </Button>
        )}
      </Section>
    </>
  );
}

// ───────────────────────────── line ─────────────────────────────

export function LineInspector({ id }: { id: string }) {
  const { data } = useLine(id);
  const { clock } = useSimClock();
  const focus = useUi((s) => s.focus);
  const select = useUi((s) => s.select);
  if (!data) return <InspectorSkeleton />;
  const city = getCity();
  return (
    <>
      <InspectorHeader
        icon={<span className="text-[15px] font-bold">{data.name}</span>}
        iconClass=""
        iconStyle={{ backgroundColor: data.color, color: data.textColor }}
        eyebrow={MODE_LABEL[data.mode]}
        title={data.longName || data.name}
        subtitle={`${data.vehicles.length} машин на линии сейчас`}
        onFocus={() => {
          const route = data.directions[0]?.route;
          const mid = route?.[route.length >> 1];
          if (mid) focus(mid.x, mid.z, { zoom: 3 });
        }}
      />
      <div className="min-h-0 overflow-y-auto">
        {data.directions.map((dir) => (
          <Section key={dir.headsign} title={`→ ${dir.headsign}`}>
            <div className="mb-2 flex gap-3 text-[12px] text-muted-foreground">
              <span>{dir.headwayMin !== null ? `Интервал ≈ ${dir.headwayMin} мин` : 'Реже раза в час'}</span>
              <span>
                {dir.nextDepartureAt !== null ? `Следующий в ${fmtClock(dir.nextDepartureAt)}${clock !== null ? ` (${untilLabel(dir.nextDepartureAt, clock)})` : ''}` : 'В ближайший час рейсов нет'}
              </span>
            </div>
            <ol className="relative ml-1.5 border-l-2 pl-3" style={{ borderColor: data.color }}>
              {dir.stops.map((s, i) => (
                <li key={`${s.id}-${i}`}>
                  <button
                    type="button"
                    className="block w-full truncate rounded px-1 py-0.5 text-left text-[13px] hover:bg-muted/60"
                    onClick={() => {
                      const stop = city.busStops.find((x) => x.id === s.id);
                      select({ kind: 'stop', id: s.id });
                      if (stop) focus(stop.x, stop.z, { zoom: 8 });
                    }}
                  >
                    {s.name}
                  </button>
                </li>
              ))}
            </ol>
          </Section>
        ))}
        {data.vehicles.length > 0 && (
          <Section title="На линии">
            <div className="flex flex-wrap gap-1.5">
              {data.vehicles.map((v) => {
                const delay = delayInfo(v.delaySec);
                return (
                  <button
                    type="button"
                    key={v.id}
                    title={`→ ${v.headsign} · ${delay.label}`}
                    onClick={() => {
                      select({ kind: 'bus', id: v.id });
                      focusVehicle(focus, v.id);
                    }}
                  >
                    <StatusBadge tone={delay.onTime ? 'success' : delay.late ? 'danger' : 'info'}>
                      {v.id} · {delay.onTime ? 'вовремя' : `${v.delaySec > 0 ? '+' : '−'}${Math.round(Math.abs(v.delaySec) / 60)} мин`}
                    </StatusBadge>
                  </button>
                );
              })}
            </div>
          </Section>
        )}
      </div>
    </>
  );
}
