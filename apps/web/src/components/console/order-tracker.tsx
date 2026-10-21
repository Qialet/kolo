'use client';

import type { OrderDto, OrderEventType } from '@kolo/contracts';
import { CarTaxiFrontIcon, CheckIcon, FlagIcon, MapPinIcon, ReceiptTextIcon, UserCheckIcon, XIcon } from 'lucide-react';
import { ORDER_LABEL, orderTone } from '@/lib/palette';
import { useOrder, useTaxi } from '@/lib/queries';
import { useUi } from '@/lib/ui-store';
import { cn } from '@/lib/utils';
import { fmtDuration, fmtMeters, fmtRsd, StatusBadge } from './common';

const STEPS: { type: OrderEventType; label: string; icon: typeof CheckIcon }[] = [
  { type: 'CREATED', label: 'Заказ создан', icon: ReceiptTextIcon },
  { type: 'ASSIGNED', label: 'Водитель назначен', icon: UserCheckIcon },
  { type: 'ARRIVED', label: 'Подача', icon: MapPinIcon },
  { type: 'PICKED_UP', label: 'В пути', icon: CarTaxiFrontIcon },
  { type: 'COMPLETED', label: 'Завершён', icon: FlagIcon },
];

/** Bottom-left order tracking strip for the selected taxi's order or the selected order. */
export function OrderTracker() {
  const selection = useUi((s) => s.selection);
  const taxiId = selection?.kind === 'taxi' ? selection.id : null;
  const taxi = useTaxi(taxiId);
  const orderId = selection?.kind === 'order' ? selection.id : (taxi.data?.order?.id ?? null);
  const { data } = useOrder(orderId);
  if (!orderId || !data) return null;
  return <Tracker order={data} etaSec={taxi.data?.etaSec} remaining={taxi.data?.remainingMeters} />;
}

function Tracker({ order, etaSec, remaining }: { order: OrderDto; etaSec: number | undefined; remaining: number | undefined }) {
  const select = useUi((s) => s.select);
  const times = new Map<OrderEventType, string>();
  for (const e of order.events ?? []) if (!times.has(e.type)) times.set(e.type, e.at);
  const failed = order.status === 'CANCELLED' || order.status === 'NO_SHOW' || order.status === 'EXPIRED';
  const reached = STEPS.reduce((acc, s, i) => (times.has(s.type) ? i : acc), 0);
  return (
    <div className="glass-panel pointer-events-auto flex items-stretch gap-4 p-3 pr-4">
      <div className="flex flex-col justify-center gap-1 pl-1">
        <div className="flex items-center gap-2 text-[15px] font-bold">
          <CarTaxiFrontIcon className="size-5 text-taxi-foreground" />
          Отслеживание заказа
        </div>
        <div className="text-[12px] text-muted-foreground">
          {order.code} · {order.vehiclePlate ?? 'поиск машины'}
        </div>
      </div>
      <ol className="flex items-start">
        {STEPS.map((s, i) => {
          const done = times.has(s.type);
          const current = i === reached && !failed && order.status !== 'COMPLETED';
          const Icon = failed && i === reached + 1 ? XIcon : done && i < reached ? CheckIcon : s.icon;
          const t = times.get(s.type);
          return (
            <li key={s.type} className="flex items-start">
              {i > 0 && <div className={cn('mt-[17px] h-0.5 w-10', done ? 'bg-foreground' : 'bg-border')} />}
              <div className="flex w-[92px] flex-col items-center text-center">
                <div
                  className={cn(
                    'grid size-9 place-items-center rounded-full border-2 transition-colors',
                    done ? 'border-foreground bg-foreground text-background' : 'border-border bg-background text-muted-foreground',
                    current && 'border-taxi bg-taxi text-taxi-foreground ring-4 ring-taxi/30',
                    failed && i === reached + 1 && 'border-destructive bg-destructive text-white',
                  )}
                >
                  <Icon className="size-4" />
                </div>
                <div className="mt-1.5 text-[12px] leading-tight font-medium">{s.label}</div>
                <div className="tabular text-[11px] text-muted-foreground">
                  {t ? new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : current && etaSec ? `≈ ${fmtDuration(etaSec)}` : ' '}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <button type="button" onClick={() => select({ kind: 'order', id: order.id })} className="flex min-w-56 flex-col justify-center gap-1 rounded-xl bg-muted/60 px-3 py-2 text-left hover:bg-muted">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[14px] font-bold">{order.code}</span>
          <StatusBadge tone={orderTone(order.status)}>{ORDER_LABEL[order.status]}</StatusBadge>
        </div>
        <div className="truncate text-[12px]">→ {order.dropoff.label}</div>
        <div className="text-[11px] text-muted-foreground">
          {fmtRsd(order.fareRsd)}
          {remaining ? ` · осталось ${fmtMeters(remaining)}` : ` · ${fmtMeters(order.distanceMeters)}`}
        </div>
      </button>
    </div>
  );
}
