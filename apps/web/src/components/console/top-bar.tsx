'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellIcon, ChevronDownIcon, GaugeIcon, PauseIcon, PlayIcon, PlusIcon, SearchIcon, WarehouseIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api } from '@/lib/api';
import { getCity } from '@/lib/city';
import { useLive } from '@/lib/live';
import { keys, useParks, useSimState } from '@/lib/queries';
import { useUi } from '@/lib/ui-store';
import { cn } from '@/lib/utils';
import { KoloLogo } from './common';
import { EventFeed } from './event-feed';

export function TopBar({ onSearch }: { onSearch: () => void }) {
  return (
    <header className="glass-panel pointer-events-auto flex h-14 items-center gap-3 px-3">
      <KoloLogo className="pr-2" />
      <Separator orientation="vertical" className="h-7" />
      <button
        type="button"
        onClick={onSearch}
        className="flex h-9 w-[clamp(220px,28vw,420px)] items-center gap-2 rounded-xl border bg-background/70 px-3 text-sm text-muted-foreground transition-colors hover:bg-background"
      >
        <SearchIcon className="size-4" />
        <span className="flex-1 text-left">Такси, заказы, адреса, парки…</span>
        <Kbd>Ctrl K</Kbd>
      </button>
      <ParkSwitcher />
      <div className="flex-1" />
      <CreateOrderButton />
      <SimControls />
      <LiveClock />
      <Notifications />
      <div className="flex items-center gap-2 pl-1">
        <Avatar className="size-8">
          <AvatarFallback className="bg-foreground text-[11px] font-semibold text-background">ДП</AvatarFallback>
        </Avatar>
        <div className="hidden leading-tight xl:block">
          <div className="text-[13px] font-semibold">Диспетчер</div>
          <div className="text-[11px] text-muted-foreground">Агрегатор Kolo</div>
        </div>
      </div>
    </header>
  );
}

function ParkSwitcher() {
  const parks = useParks();
  const filter = useUi((s) => s.parkFilter);
  const setFilter = useUi((s) => s.setParkFilter);
  const select = useUi((s) => s.select);
  const focus = useUi((s) => s.focus);
  const current = parks.data?.find((p) => p.id === filter);
  const total = parks.data?.reduce((a, p) => a + p.counts.total, 0) ?? 0;
  const onLine = parks.data?.reduce((a, p) => a + p.counts.onLine, 0) ?? 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className="flex h-10 items-center gap-2.5 rounded-xl border bg-background/70 py-1 pr-2 pl-1 text-left transition-colors hover:bg-background" />
        }
      >
        <span className="grid size-8 place-items-center rounded-lg bg-depot text-[11px] font-bold text-white">{current?.id ?? 'ALL'}</span>
        <span className="leading-tight">
          <span className="block text-[13px] font-semibold">{current?.name ?? 'Все партнёры'}</span>
          <span className="block text-[11px] text-muted-foreground">
            {current ? `${current.counts.onLine} на линии · ${current.counts.inPark}/${current.capacity} в парке` : `${onLine}/${total} машин на линии`}
          </span>
        </span>
        <ChevronDownIcon className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Таксопарки партнёров</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={filter ?? 'all'}
            onValueChange={(v) => {
              const id = v === 'all' ? null : String(v);
              setFilter(id);
              const depot = id ? getCity().depots.find((d) => d.id === id) : undefined;
              if (depot) {
                select({ kind: 'depot', id: depot.id });
                focus(depot.yard.x, depot.yard.z, { zoom: 5 });
              }
            }}
          >
            <DropdownMenuRadioItem value="all">Все партнёры</DropdownMenuRadioItem>
            {parks.data?.map((p) => (
              <DropdownMenuRadioItem key={p.id} value={p.id}>
                <WarehouseIcon />
                {p.name}
                <span className="ml-auto text-xs text-muted-foreground">
                  {p.counts.total}/{p.capacity}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Партнёры содержат парки и сервисные боксы, Kolo распределяет заказы.</DropdownMenuLabel>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CreateOrderButton() {
  const open = useUi((s) => s.openCreateOrder);
  return (
    <Button onClick={() => open()} className="h-9 rounded-xl bg-taxi text-taxi-foreground hover:bg-taxi/85">
      <PlusIcon data-icon="inline-start" />
      Заказ
    </Button>
  );
}

const SPEEDS = ['0.5', '1', '2', '4'];

function SimControls() {
  const state = useSimState();
  const qc = useQueryClient();
  const control = useMutation({
    mutationFn: api.simControl,
    onSuccess: (data) => qc.setQueryData(keys.simState, data),
  });
  const s = state.data;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" className="h-9 rounded-xl" />}>
        {s?.paused ? <PauseIcon data-icon="inline-start" /> : <GaugeIcon data-icon="inline-start" />}
        {s ? (s.paused ? 'Пауза' : `×${s.speed}`) : '—'}
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <PopoverHeader>
          <PopoverTitle>Симуляция города</PopoverTitle>
          <PopoverDescription>Рычаги влияют на всех подключённых диспетчеров.</PopoverDescription>
        </PopoverHeader>
        <div className="flex flex-col gap-4 pt-2">
          <div className="flex items-center justify-between gap-2">
            <ToggleGroup
              value={s ? [String(s.speed)] : []}
              onValueChange={(v) => v[0] && control.mutate({ speed: Number(v[0]) })}
              variant="outline"
              size="sm"
            >
              {SPEEDS.map((x) => (
                <ToggleGroupItem key={x} value={x}>
                  ×{x}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Button size="icon-sm" variant={s?.paused ? 'default' : 'outline'} onClick={() => control.mutate({ paused: !s?.paused })} aria-label="Пауза">
              {s?.paused ? <PlayIcon /> : <PauseIcon />}
            </Button>
          </div>
          <LeverSlider label="Плотность трафика" value={s?.trafficDensity ?? 0.6} max={1} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => control.mutate({ trafficDensity: v })} />
          <LeverSlider label="Спрос на такси" value={s?.demand ?? 1} max={3} format={(v) => `×${v.toFixed(1)}`} onCommit={(v) => control.mutate({ demand: v })} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LeverSlider({ label, value, max, format, onCommit }: { label: string; value: number; max: number; format: (v: number) => string; onCommit: (v: number) => void }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="tabular text-muted-foreground">{format(local)}</span>
      </div>
      <Slider value={local} min={0} max={max} step={0.05} onValueChange={(v) => setLocal(Array.isArray(v) ? v[0]! : (v as number))} onValueCommitted={(v) => onCommit(Array.isArray(v) ? v[0]! : (v as number))} />
    </div>
  );
}

function LiveClock() {
  const connected = useLive((s) => s.connected);
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className={cn('flex h-9 items-center gap-2 rounded-xl px-3 text-[13px] font-semibold', connected ? 'bg-pickup/12 text-pickup' : 'bg-destructive/10 text-destructive')}>
      <span className={cn('size-2 rounded-full', connected ? 'animate-pulse bg-pickup' : 'bg-destructive')} />
      {connected ? 'Live' : 'Нет связи'}
      <span className="tabular text-foreground/80">{now?.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) ?? '--:--'}</span>
    </div>
  );
}

function Notifications() {
  const unread = useLive((s) => s.unread);
  const markRead = useLive((s) => s.markRead);
  return (
    <Popover onOpenChange={(open) => open && markRead()}>
      <PopoverTrigger render={<Button variant="ghost" size="icon-lg" className="relative rounded-xl" aria-label="События" />}>
        <BellIcon />
        {unread > 0 && (
          <span className="tabular absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="end">
        <EventFeed />
      </PopoverContent>
    </Popover>
  );
}
