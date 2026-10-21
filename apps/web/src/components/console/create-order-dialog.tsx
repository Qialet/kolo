'use client';

import { useMutation } from '@tanstack/react-query';
import { ChevronsUpDownIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api';
import { getCity } from '@/lib/city';
import { useUi } from '@/lib/ui-store';

interface PlaceOption {
  id: string;
  label: string;
  group: 'Точки притяжения' | 'Остановки' | 'Адреса';
}

function usePlaces(): PlaceOption[] {
  return useMemo(() => {
    const city = getCity();
    const poiIds = new Set(city.pois.map((p) => p.addressId));
    const pois = city.addresses.filter((a) => poiIds.has(a.id)).map((a) => ({ id: a.id, label: a.label, group: 'Точки притяжения' as const }));
    const stops = city.busStops.map((s) => ({ id: s.id, label: `Остановка «${s.name}»`, group: 'Остановки' as const }));
    const addresses = city.addresses
      .filter((a) => !poiIds.has(a.id))
      .map((a) => ({ id: a.id, label: a.label, group: 'Адреса' as const }))
      .sort((a, b) => a.label.localeCompare(b.label, 'sr', { numeric: true }));
    return [...pois, ...stops, ...addresses];
  }, []);
}

function PlacePicker({ value, onChange, placeholder }: { value: string | null; onChange: (id: string) => void; placeholder: string }) {
  const places = usePlaces();
  const [open, setOpen] = useState(false);
  const current = places.find((p) => p.id === value);
  const groups = ['Точки притяжения', 'Остановки', 'Адреса'] as const;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" className="w-full justify-between font-normal" />}>
        <span className={current ? 'truncate' : 'truncate text-muted-foreground'}>{current?.label ?? placeholder}</span>
        <ChevronsUpDownIcon data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent className="w-(--anchor-width) p-0">
        <Command>
          <CommandInput placeholder="Улица, номер, остановка…" />
          <CommandList>
            <CommandEmpty>Ничего не найдено</CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g} heading={g}>
                {places
                  .filter((p) => p.group === g)
                  .map((p) => (
                    <CommandItem
                      key={p.id}
                      value={`${p.label} ${p.id}`}
                      onSelect={() => {
                        onChange(p.id);
                        setOpen(false);
                      }}
                    >
                      {p.label}
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function CreateOrderDialog() {
  const preset = useUi((s) => s.createOrder);
  const close = useUi((s) => s.closeCreateOrder);
  return <Dialog open={!!preset} onOpenChange={(o) => !o && close()}>{preset && <CreateOrderForm key={JSON.stringify(preset)} preset={preset} onDone={close} />}</Dialog>;
}

function CreateOrderForm({ preset, onDone }: { preset: { pickupId?: string; dropoffId?: string }; onDone: () => void }) {
  const [pickup, setPickup] = useState<string | null>(preset.pickupId ?? null);
  const [dropoff, setDropoff] = useState<string | null>(preset.dropoffId ?? null);
  const [name, setName] = useState('');
  const select = useUi((s) => s.select);
  const focus = useUi((s) => s.focus);
  const create = useMutation({
    mutationFn: () => api.createOrder({ pickupAddressId: pickup!, dropoffAddressId: dropoff!, source: 'DISPATCHER', ...(name.trim() ? { passengerName: name.trim() } : {}) }),
    onSuccess: (order) => {
      toast.success(`Заказ ${order.code} создан`, { description: 'Kolo ищет ближайшую свободную машину' });
      select({ kind: 'order', id: order.id });
      focus(order.pickup.x, order.pickup.z, { zoom: 6 });
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Новый заказ</DialogTitle>
        <DialogDescription>Заказ от диспетчерской: система предложит его ближайшему свободному водителю.</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel>Точка A — откуда</FieldLabel>
          <PlacePicker value={pickup} onChange={setPickup} placeholder="Выберите адрес подачи" />
        </Field>
        <Field>
          <FieldLabel>Точка B — куда</FieldLabel>
          <PlacePicker value={dropoff} onChange={setDropoff} placeholder="Выберите адрес назначения" />
          {pickup && dropoff && pickup === dropoff && <FieldDescription>Точки A и B должны различаться.</FieldDescription>}
        </Field>
        <Field>
          <FieldLabel htmlFor="passenger">Пассажир</FieldLabel>
          <Input id="passenger" value={name} onChange={(e) => setName(e.target.value)} placeholder="Необязательно — сгенерируем" />
        </Field>
      </FieldGroup>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Отмена
        </Button>
        <Button disabled={!pickup || !dropoff || pickup === dropoff || create.isPending} onClick={() => create.mutate()}>
          Создать заказ
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
