'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ACTIVE_ORDER_STATUSES, TAXI_ACTIVITIES, type OrderDto } from '@kolo/contracts';
import { ReceiptTextIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { frameBuffer } from '@/lib/live';
import { ACTOR_LABEL, EVENT_LABEL, ORDER_LABEL, orderTone } from '@/lib/palette';
import { keys, useOrder, useVehicles } from '@/lib/queries';
import { useUi } from '@/lib/ui-store';
import { cn } from '@/lib/utils';
import { fmtMeters, fmtRsd, fmtTime, Row, StatusBadge } from './common';
import { InspectorHeader, Route, Section } from './inspector';

export function OrderInspector({ id }: { id: string }) {
  const { data } = useOrder(id);
  const focus = useUi((s) => s.focus);
  if (!data) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-11 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  const active = ACTIVE_ORDER_STATUSES.includes(data.status);
  return (
    <>
      <InspectorHeader
        icon={<ReceiptTextIcon className="size-5" />}
        iconClass="bg-taxi text-taxi-foreground"
        eyebrow={`Заказ · ${data.source}`}
        title={data.code}
        subtitle={`${data.passengerName} · создан ${fmtTime(data.createdAt)}`}
        onFocus={() => focus(data.pickup.x, data.pickup.z, { zoom: 6 })}
      />
      <div className="px-4">
        <StatusBadge tone={orderTone(data.status)}>{ORDER_LABEL[data.status]}</StatusBadge>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Маршрут">
          <Route pickup={data.pickup.label} dropoff={data.dropoff.label} />
          <Row label="Машина">{data.vehiclePlate ?? '—'}</Row>
          <Row label="Расстояние">{fmtMeters(data.distanceMeters)}</Row>
          <Row label={data.status === 'COMPLETED' ? 'Стоимость' : 'Оценка'}>{fmtRsd(data.fareRsd)}</Row>
          {data.cancelReason && <Row label="Причина отмены">{data.cancelReason}</Row>}
        </Section>
        {active && <OrderActions order={data} />}
        <Separator />
        <Section title="История">
          <ol className="relative flex flex-col gap-2.5 border-l pl-4">
            {data.events?.map((e) => (
              <li key={e.id} className="relative">
                <span
                  className={cn(
                    'absolute top-1 -left-[21px] size-2.5 rounded-full ring-2 ring-white',
                    e.type === 'COMPLETED' ? 'bg-pickup' : e.type === 'CANCELLED' || e.type === 'NO_SHOW' || e.type === 'EXPIRED' || e.type === 'DISPUTE_OPENED' ? 'bg-destructive' : e.type === 'OFFER_MISSED' ? 'bg-taxi' : 'bg-foreground/40',
                  )}
                />
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] font-medium">{EVENT_LABEL[e.type] ?? e.type}</span>
                  <span className="tabular text-[11px] text-muted-foreground">{fmtTime(e.at)}</span>
                </div>
                <div className="text-[12px] text-muted-foreground">
                  {e.note}
                  {e.note ? ' · ' : ''}
                  {ACTOR_LABEL[e.actor]}
                </div>
              </li>
            ))}
          </ol>
        </Section>
        <Disputes order={data} />
      </div>
    </>
  );
}

function OrderActions({ order }: { order: OrderDto }) {
  const qc = useQueryClient();
  const vehicles = useVehicles();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.order(order.id) });
  const cancel = useMutation({
    mutationFn: () => api.cancelOrder(order.id, 'Отменено диспетчером'),
    onSuccess: () => {
      toast.success(`${order.code} отменён`);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const assign = useMutation({
    mutationFn: (vehicleId: string) => api.assignOrder(order.id, vehicleId),
    onSuccess: () => {
      toast.success('Машина назначена');
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  // Nearest free taxis from the latest live frame.
  const candidates = useMemo(() => {
    const free = TAXI_ACTIVITIES.indexOf('FREE');
    return (frameBuffer.latest?.vehicles ?? [])
      .filter((v) => v[1] === 0 && v[6] === free)
      .map((v) => ({ id: v[0], d: Math.abs(v[2] - order.pickup.x) + Math.abs(v[3] - order.pickup.z) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.pickup.x, order.pickup.z, order.updatedAt]);
  return (
    <>
      <Separator />
      <Section title="Действия диспетчера">
        {order.status === 'SEARCHING' && (
          <div className="mb-2 flex flex-col gap-1">
            <div className="text-[12px] text-muted-foreground">Назначить вручную — ближайшие свободные:</div>
            {candidates.map((c) => (
              <Button key={c.id} size="sm" variant="outline" className="justify-between" disabled={assign.isPending} onClick={() => assign.mutate(c.id)}>
                <span>{vehicles.data?.find((v) => v.id === c.id)?.plate ?? c.id}</span>
                <span className="text-muted-foreground">{fmtMeters(c.d)}</span>
              </Button>
            ))}
            {!candidates.length && <div className="text-[12px] text-muted-foreground">Свободных машин рядом нет.</div>}
          </div>
        )}
        <Button variant="destructive" size="sm" className="w-full" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
          Отменить заказ
        </Button>
      </Section>
    </>
  );
}

function Disputes({ order }: { order: OrderDto }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.order(order.id) });
    void qc.invalidateQueries({ queryKey: ['disputes'] });
  };
  const open = useMutation({
    mutationFn: () => api.openDispute(order.id, reason),
    onSuccess: () => {
      setReason('');
      toast.success('Возражение зарегистрировано');
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const resolve = useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: 'REFUNDED' | 'REJECTED' }) => api.resolveDispute(id, { resolution }),
    onSuccess: () => {
      toast.success('Возражение закрыто');
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const disputes = order.disputes ?? [];
  if (!disputes.length && order.status !== 'COMPLETED' && order.status !== 'NO_SHOW') return null;
  return (
    <>
      <Separator />
      <Section title="Возражения">
        <div className="flex flex-col gap-2">
          {disputes.map((d) => (
            <div key={d.id} className="rounded-xl border p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{d.reason}</span>
                <StatusBadge tone={d.status === 'OPEN' ? 'danger' : d.status === 'REFUNDED' ? 'success' : 'muted'}>
                  {d.status === 'OPEN' ? 'Открыто' : d.status === 'REFUNDED' ? 'Возврат' : 'Отклонено'}
                </StatusBadge>
              </div>
              {d.status === 'OPEN' && (
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <Button size="xs" onClick={() => resolve.mutate({ id: d.id, resolution: 'REFUNDED' })}>
                    Вернуть деньги
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => resolve.mutate({ id: d.id, resolution: 'REJECTED' })}>
                    Отклонить
                  </Button>
                </div>
              )}
            </div>
          ))}
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Новое возражение пассажира…" className="min-h-14 text-[13px]" />
          <Button size="sm" variant="outline" disabled={reason.trim().length < 2 || open.isPending} onClick={() => open.mutate()}>
            Зарегистрировать возражение
          </Button>
        </div>
      </Section>
    </>
  );
}
