'use client';

import { CarTaxiFrontIcon, ClockIcon, ListOrderedIcon, WalletIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useLive } from '@/lib/live';
import { cn } from '@/lib/utils';
import { fmtDuration, fmtRsd } from './common';

function Kpi({ icon, iconClass, title, value, hint }: { icon: ReactNode; iconClass: string; title: string; value: ReactNode; hint: ReactNode }) {
  return (
    <div className="glass-panel pointer-events-auto flex min-w-48 items-center gap-3 px-3.5 py-3">
      <div className={cn('grid size-11 shrink-0 place-items-center rounded-xl', iconClass)}>{icon}</div>
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-muted-foreground">{title}</div>
        <div className="tabular text-[22px] leading-tight font-bold tracking-tight">{value}</div>
        <div className="truncate text-[11px] text-muted-foreground">{hint}</div>
      </div>
    </div>
  );
}

export function KpiCards() {
  const kpi = useLive((s) => s.kpi);
  if (!kpi) {
    return (
      <div className="flex gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[76px] w-48 rounded-2xl" />
        ))}
      </div>
    );
  }
  const onLine = kpi.taxis.total - kpi.taxis.inPark - kpi.taxis.maintenance;
  const finished = kpi.orders.completed + kpi.orders.cancelled + kpi.orders.noShow + kpi.orders.expired;
  const success = finished ? Math.round((kpi.orders.completed / finished) * 1000) / 10 : 100;
  return (
    <div className="flex flex-wrap gap-3">
      <Kpi
        icon={<CarTaxiFrontIcon className="size-5" />}
        iconClass="bg-taxi text-taxi-foreground"
        title="Такси на линии"
        value={
          <>
            {onLine}
            <span className="text-sm font-medium text-muted-foreground">/{kpi.taxis.total}</span>
          </>
        }
        hint={`${kpi.taxis.free} свободны · ${kpi.taxis.busy} заняты · ${kpi.taxis.maintenance} в ремонте`}
      />
      <Kpi
        icon={<ListOrderedIcon className="size-5" />}
        iconClass="bg-bus/12 text-bus"
        title="Активные заказы"
        value={kpi.orders.active}
        hint={`${kpi.orders.searching} в поиске · ${kpi.orders.openDisputes} возражений`}
      />
      <Kpi
        icon={<ClockIcon className="size-5" />}
        iconClass="bg-pickup/12 text-pickup"
        title="Время подачи"
        value={kpi.avgPickupEtaSec ? fmtDuration(kpi.avgPickupEtaSec) : '—'}
        hint={`${success}% успешных · трафик ${kpi.avgSpeedKmh} км/ч`}
      />
      <Kpi
        icon={<WalletIcon className="size-5" />}
        iconClass="bg-depot/12 text-depot"
        title="Выручка смены"
        value={fmtRsd(kpi.revenueRsd)}
        hint={`${kpi.orders.completed} поездок · ${kpi.orders.cancelled + kpi.orders.noShow} отмен/неявок`}
      />
    </div>
  );
}
