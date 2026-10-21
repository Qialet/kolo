'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FleetStatus, LightMode } from '@kolo/contracts';
import { BusFrontIcon, CarFrontIcon, CarTaxiFrontIcon, CrosshairIcon, NavigationIcon, TrafficConeIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api } from '@/lib/api';
import { getCity } from '@/lib/city';
import { frameBuffer } from '@/lib/live';
import { ACTIVITY_LABEL, activityTone, FLEET_LABEL, fleetTone, ORDER_LABEL, orderTone, palette } from '@/lib/palette';
import { keys, useBus, useLight, useTaxi } from '@/lib/queries';
import { useUi, type Selection } from '@/lib/ui-store';
import { cn } from '@/lib/utils';
import { fmtDuration, fmtMeters, fmtRsd, Row, StatusBadge } from './common';
import { BuildingInspector, DepotInspector, StopInspector } from './inspector-places';
import { OrderInspector } from './order-inspector';

export function Inspector() {
  const selection = useUi((s) => s.selection);
  if (!selection) return null;
  return (
    <aside className="glass-panel pointer-events-auto flex max-h-[calc(100dvh-420px)] min-h-0 w-[360px] flex-col overflow-hidden">
      <InspectorBody selection={selection} />
    </aside>
  );
}

function InspectorBody({ selection }: { selection: Selection }) {
  switch (selection.kind) {
    case 'taxi':
      return <TaxiInspector id={selection.id} />;
    case 'light':
      return <LightInspector id={selection.id} />;
    case 'bus':
      return <BusInspector id={selection.id} />;
    case 'car':
      return <CarInspector id={selection.id} />;
    case 'depot':
      return <DepotInspector id={selection.id} />;
    case 'building':
      return <BuildingInspector id={selection.id} />;
    case 'stop':
      return <StopInspector id={selection.id} />;
    case 'order':
      return <OrderInspector id={selection.id} />;
  }
}

export function InspectorHeader({
  icon,
  iconClass,
  eyebrow,
  title,
  subtitle,
  onFocus,
}: {
  icon: ReactNode;
  iconClass: string;
  eyebrow: string;
  title: ReactNode;
  subtitle?: ReactNode;
  onFocus?: () => void;
}) {
  const select = useUi((s) => s.select);
  return (
    <div className="flex items-start gap-3 p-4 pb-3">
      <div className={cn('grid size-11 shrink-0 place-items-center rounded-xl', iconClass)}>{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{eyebrow}</div>
        <div className="truncate text-[17px] leading-tight font-bold">{title}</div>
        {subtitle && <div className="truncate text-[12px] text-muted-foreground">{subtitle}</div>}
      </div>
      {onFocus && (
        <Button variant="outline" size="icon-sm" onClick={onFocus} aria-label="Показать на карте">
          <CrosshairIcon />
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" onClick={() => select(null)} aria-label="Закрыть">
        <XIcon />
      </Button>
    </div>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</div>
        {aside}
      </div>
      {children}
    </div>
  );
}

function InspectorSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <Skeleton className="h-11 w-2/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

// ───────────────────────────── taxi ─────────────────────────────

const FLEET_ACTIONS: { status: FleetStatus; label: string }[] = [
  { status: 'ON_LINE', label: 'На линию' },
  { status: 'IN_PARK', label: 'В парк' },
  { status: 'MAINTENANCE', label: 'В сервис' },
];

function TaxiInspector({ id }: { id: string }) {
  const { data } = useTaxi(id);
  const focus = useUi((s) => s.focus);
  const select = useUi((s) => s.select);
  const qc = useQueryClient();
  const setStatus = useMutation({
    mutationFn: (status: FleetStatus) => api.setFleetStatus(id, status),
    onSuccess: (_d, status) => {
      toast.success(`${data?.plate ?? id}: ${FLEET_LABEL[status]}`);
      void qc.invalidateQueries({ queryKey: keys.taxi(id) });
      void qc.invalidateQueries({ queryKey: keys.parks });
    },
    onError: (e) => toast.error(e.message),
  });
  const cancel = useMutation({
    mutationFn: (orderId: string) => api.cancelOrder(orderId, 'Отменено диспетчером'),
    onSuccess: () => toast.success('Заказ отменён'),
    onError: (e) => toast.error(e.message),
  });
  if (!data) return <InspectorSkeleton />;
  const order = data.order;
  const toPickup = data.activity === 'TO_PICKUP' || data.activity === 'AT_PICKUP';
  return (
    <>
      <InspectorHeader
        icon={<CarTaxiFrontIcon className="size-5" />}
        iconClass="bg-taxi text-taxi-foreground"
        eyebrow={`Такси · ${data.parkName}`}
        title={data.plate}
        subtitle={`${data.model} · ${data.driverName ?? 'без водителя'}${data.driverRating ? ` · ★ ${data.driverRating.toFixed(2)}` : ''}`}
        onFocus={() => focus(data.x, data.z, { zoom: 9, follow: id })}
      />
      <div className="flex flex-wrap gap-1.5 px-4">
        <StatusBadge tone={activityTone(data.activity)}>{ACTIVITY_LABEL[data.activity]}</StatusBadge>
        <StatusBadge tone={fleetTone(data.fleetStatus)}>{FLEET_LABEL[data.fleetStatus]}</StatusBadge>
        <StatusBadge tone="muted">{data.speedKmh} км/ч</StatusBadge>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {data.routeTarget && (
          <Section title={toPickup ? 'Подача к клиенту' : data.activity === 'ON_TRIP' ? 'Поездка' : 'Маршрут'}>
            <div className="rounded-xl bg-muted/60 p-3">
              <div className="flex items-center gap-2 text-[13px] font-medium">
                <NavigationIcon className="size-4 text-muted-foreground" />
                <span className="truncate">{data.routeTarget.label}</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[11px] text-muted-foreground">Осталось</div>
                  <div className="tabular text-[15px] font-semibold">{fmtMeters(data.remainingMeters)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground">В пути ещё</div>
                  <div className="tabular text-[15px] font-semibold">≈ {fmtDuration(data.etaSec)}</div>
                </div>
              </div>
              {order && (toPickup || data.activity === 'ON_TRIP') && <Progress value={Math.max(3, data.progress * 100)} className="mt-3" />}
            </div>
          </Section>
        )}
        {order && (
          <>
            <Separator />
            <Section title="Заказ" aside={<StatusBadge tone={orderTone(order.status)}>{ORDER_LABEL[order.status]}</StatusBadge>}>
              <button type="button" className="w-full text-left" onClick={() => select({ kind: 'order', id: order.id })}>
                <Route pickup={order.pickup.label} dropoff={order.dropoff.label} />
              </button>
              <Row label="Код">{order.code}</Row>
              <Row label="Пассажир">{order.passengerName}</Row>
              <Row label="Стоимость">{fmtRsd(order.fareRsd)}</Row>
              <Button variant="destructive" size="sm" className="mt-2 w-full" disabled={cancel.isPending} onClick={() => cancel.mutate(order.id)}>
                Отменить заказ
              </Button>
            </Section>
          </>
        )}
        <Separator />
        <Section title="Смена">
          <Row label="Поездок">{data.tripsToday}</Row>
          <Row label="Заработано">{fmtRsd(data.earningsRsd)}</Row>
          <Row label="Парк">{data.parkName}</Row>
        </Section>
        <Separator />
        <Section title="Статус автомобиля">
          <div className="grid grid-cols-3 gap-1.5">
            {FLEET_ACTIONS.map((a) => (
              <Button
                key={a.status}
                size="sm"
                variant={data.fleetStatus === a.status ? 'default' : 'outline'}
                disabled={setStatus.isPending || data.fleetStatus === a.status}
                onClick={() => setStatus.mutate(a.status)}
              >
                {a.label}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">С пассажиром смена статуса выполнится после завершения поездки.</p>
        </Section>
      </div>
    </>
  );
}

export function Route({ pickup, dropoff }: { pickup: string; dropoff: string }) {
  return (
    <div className="relative mb-1 flex flex-col gap-2 rounded-xl border p-2.5 pl-8 text-[13px]">
      <span className="absolute top-3.5 left-3 size-2.5 rounded-full bg-pickup" />
      <span className="absolute top-[22px] bottom-[22px] left-[15.5px] w-px bg-border" />
      <span className="absolute bottom-3.5 left-3 size-2.5 rounded-[3px] bg-dropoff" />
      <span className="truncate font-medium">{pickup}</span>
      <span className="truncate font-medium">{dropoff}</span>
    </div>
  );
}

// ───────────────────────────── traffic light ─────────────────────────────

const MODES: { mode: LightMode; label: string }[] = [
  { mode: 'AUTO', label: 'Авто' },
  { mode: 'FLASHING', label: 'Жёлтый мигающий' },
  { mode: 'HOLD_NS', label: 'Держать С–Ю' },
  { mode: 'HOLD_EW', label: 'Держать З–В' },
];

const ASPECT_LABEL: Record<string, string> = { RED: 'Красный', RED_AMBER: 'Красный + жёлтый', GREEN: 'Зелёный', AMBER: 'Жёлтый', FLASHING: 'Мигает жёлтый' };

function LightInspector({ id }: { id: number }) {
  const { data } = useLight(id);
  const node = getCity().nodes[id]!;
  const focus = useUi((s) => s.focus);
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: (input: Parameters<typeof api.setLight>[1]) => api.setLight(id, input),
    onSuccess: (d) => {
      qc.setQueryData(keys.light(id), d);
      toast.success('Светофор обновлён');
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <>
      <InspectorHeader
        icon={<TrafficConeIcon className="size-5" />}
        iconClass="bg-foreground text-background"
        eyebrow="Светофорный объект"
        title={node.name}
        subtitle={data ? `Цикл ${data.cycleSec} с · фаза красный+жёлтый перед зелёным` : undefined}
        onFocus={() => focus(node.x, node.z, { zoom: 9 })}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Фазы сейчас">
          <div className="grid grid-cols-2 gap-2">
            <AxisCard nodeId={id} axis={0} label="Север – Юг" queue={data?.queueNs} />
            <AxisCard nodeId={id} axis={1} label="Запад – Восток" queue={data?.queueEw} />
          </div>
        </Section>
        <Separator />
        <Section title="Режим">
          <ToggleGroup value={data ? [data.mode] : []} onValueChange={(v) => v[0] && update.mutate({ mode: v[0] as LightMode })} variant="outline" size="sm" className="flex-wrap">
            {MODES.map((m) => (
              <ToggleGroupItem key={m.mode} value={m.mode}>
                {m.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Section>
        <Separator />
        <Section title="Длительность зелёного">
          {data && (
            <div className="flex flex-col gap-2">
              <GreenStepper label="Север – Юг" value={data.greenNs} onChange={(v) => update.mutate({ greenNs: v })} />
              <GreenStepper label="Запад – Восток" value={data.greenEw} onChange={(v) => update.mutate({ greenEw: v })} />
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

/** Aspect and live countdown of one axis, ticking every animation frame. */
function AxisCard({ nodeId, axis, label, queue }: { nodeId: number; axis: 0 | 1; label: string; queue: number | undefined }) {
  const dot = useRef<HTMLSpanElement>(null);
  const name = useRef<HTMLDivElement>(null);
  const secs = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const aspects = ['RED', 'RED_AMBER', 'GREEN', 'AMBER', 'FLASHING'];
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const st = frameBuffer.latest?.lights[nodeId];
      if (!st || !dot.current || !name.current || !secs.current) return;
      const aspect = aspects[st[axis]]!;
      const left = st[axis + 2]!;
      const elapsed = (performance.now() - frameBuffer.latestAt) / 1000;
      const color = aspect === 'GREEN' ? palette.green : aspect === 'RED' || aspect === 'RED_AMBER' ? palette.red : palette.amber;
      dot.current.style.background = color;
      dot.current.style.boxShadow = `0 0 12px ${color}`;
      name.current.textContent = ASPECT_LABEL[aspect] ?? aspect;
      secs.current.textContent = left < 0 ? '∞' : `${Math.max(0, Math.ceil(left - elapsed))} с`;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [nodeId, axis]);
  return (
    <div className="rounded-xl bg-muted/60 p-3">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className="mt-1.5 flex items-center gap-2">
        <span ref={dot} className="size-3 rounded-full" />
        <div ref={secs} className="tabular text-[22px] leading-none font-bold" />
      </div>
      <div ref={name} className="mt-1 text-[12px] font-medium" />
      <div className="mt-1 text-[11px] text-muted-foreground">В очереди: {queue ?? '—'}</div>
    </div>
  );
}

function GreenStepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[13px]">
      <span>{label}</span>
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="icon-xs" onClick={() => onChange(Math.max(8, value - 4))} aria-label="Меньше">
          −
        </Button>
        <span className="tabular w-12 text-center font-semibold">{value} с</span>
        <Button variant="outline" size="icon-xs" onClick={() => onChange(Math.min(90, value + 4))} aria-label="Больше">
          +
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────────── bus & car ─────────────────────────────

function BusInspector({ id }: { id: string }) {
  const { data } = useBus(id);
  const focus = useUi((s) => s.focus);
  if (!data) return <InspectorSkeleton />;
  return (
    <>
      <InspectorHeader
        icon={<BusFrontIcon className="size-5" />}
        iconClass="bg-bus text-white"
        eyebrow={`Автобус · линия ${data.line}`}
        title={data.lineName}
        subtitle={`${data.speedKmh} км/ч · ${data.passengers} пассажиров`}
        onFocus={() => {
          const p = frameBuffer.find(id);
          if (p) focus(p[2], p[3], { zoom: 8, follow: id });
        }}
      />
      <Section title="Следующая остановка">
        <div className="rounded-xl bg-bus/8 p-3">
          <div className="text-[14px] font-semibold">{data.nextStop}</div>
          <div className="mt-1 text-[12px] text-muted-foreground">
            {data.dwellLeftSec > 0 ? `Посадка пассажиров · отправление через ${data.dwellLeftSec} с` : `Прибытие ≈ ${fmtDuration(data.etaSec)}`}
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Автобусы останавливаются в кобальтовых карманах; рядом с остановками чаще всего заказывают такси.</p>
      </Section>
    </>
  );
}

function CarInspector({ id }: { id: string }) {
  const focus = useUi((s) => s.focus);
  const pose = frameBuffer.find(id);
  return (
    <>
      <InspectorHeader
        icon={<CarFrontIcon className="size-5" />}
        iconClass="bg-muted text-foreground"
        eyebrow="Городской трафик"
        title="Частный автомобиль"
        subtitle={pose ? `${Math.round(pose[5] * 3.6)} км/ч` : undefined}
        onFocus={() => pose && focus(pose[2], pose[3], { zoom: 9, follow: id })}
      />
      <Section title="Описание">
        <p className="text-[13px] text-muted-foreground">Фоновые машины создают пробки и соблюдают светофоры. Плотность трафика настраивается в панели симуляции.</p>
      </Section>
    </>
  );
}
