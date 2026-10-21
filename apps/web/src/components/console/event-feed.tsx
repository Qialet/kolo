'use client';

import type { LiveEventSeverity } from '@kolo/contracts';
import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon, OctagonAlertIcon } from 'lucide-react';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useLive } from '@/lib/live';
import { useUi } from '@/lib/ui-store';
import { cn } from '@/lib/utils';

const ICON: Record<LiveEventSeverity, typeof InfoIcon> = {
  info: InfoIcon,
  success: CheckCircle2Icon,
  warning: AlertTriangleIcon,
  danger: OctagonAlertIcon,
};
const TONE: Record<LiveEventSeverity, string> = {
  info: 'text-bus bg-bus/10',
  success: 'text-pickup bg-pickup/12',
  warning: 'text-taxi-foreground bg-taxi/25',
  danger: 'text-destructive bg-destructive/10',
};

/** Live operational feed: orders, fleet changes, breakdowns, disputes. */
export function EventFeed() {
  const events = useLive((s) => s.events);
  const select = useUi((s) => s.select);
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="text-sm font-semibold">Лента событий</div>
        <div className="text-xs text-muted-foreground">{events.length} последних</div>
      </div>
      {events.length === 0 ? (
        <Empty className="py-10">
          <EmptyHeader>
            <EmptyTitle>Пока тихо</EmptyTitle>
            <EmptyDescription>События города появятся здесь в реальном времени.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="h-[420px]">
          <ul className="flex flex-col p-1.5">
            {events.map((e) => {
              const Icon = ICON[e.severity];
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-muted"
                    onClick={() => {
                      if (e.orderId) select({ kind: 'order', id: e.orderId });
                      else if (e.vehicleId) select({ kind: 'taxi', id: e.vehicleId });
                    }}
                  >
                    <span className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg', TONE[e.severity])}>
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{e.title}</span>
                      {e.detail && <span className="block truncate text-xs text-muted-foreground">{e.detail}</span>}
                    </span>
                    <span className="tabular shrink-0 text-[11px] text-muted-foreground">
                      {new Date(e.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}
