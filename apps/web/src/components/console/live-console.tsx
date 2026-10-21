'use client';

import dynamic from 'next/dynamic';
import type { City } from '@kolo/sim';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SceneLabels } from '@/components/scene/scene-labels';
import { loadCity } from '@/lib/city';
import { connectLive, frameBuffer, useLive } from '@/lib/live';
import { useUi } from '@/lib/ui-store';
import { cn } from '@/lib/utils';
import { CommandSearch } from './command-search';
import { CreateOrderDialog } from './create-order-dialog';
import { Inspector } from './inspector';
import { KpiCards } from './kpi-cards';
import { MapControls } from './map-controls';
import { OpsPanel } from './ops-panel';
import { OrderTracker } from './order-tracker';
import { TopBar } from './top-bar';

const CityCanvas = dynamic(() => import('@/components/scene/city-canvas'), {
  ssr: false,
  loading: () => <div className="grid size-full place-items-center text-sm text-muted-foreground">Строим Белград…</div>,
});

/** Loads the district file in the browser; the console renders once the city is built. */
function useDistrictCity() {
  const [state, setState] = useState<{ city: City | null; error: string | null }>({ city: null, error: null });
  useEffect(() => {
    let alive = true;
    loadCity().then(
      (city) => alive && setState({ city, error: null }),
      (e: unknown) => alive && setState({ city: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/** Offers a reload when the server simulates another version of the district than this tab drew. */
function useDistrictVersionCheck(city: City | null) {
  const serverVersion = useLive((s) => s.districtVersion);
  useEffect(() => {
    if (!city || !serverVersion || serverVersion === city.version) return;
    toast('Карта обновилась на сервере', {
      id: 'district-version',
      description: 'Перезагрузите страницу, чтобы машины ехали по той же карте.',
      duration: Infinity,
      action: { label: 'Перезагрузить', onClick: () => window.location.reload() },
    });
  }, [city, serverVersion]);
}

const BACKDROP = 'relative h-dvh w-full overflow-hidden bg-[radial-gradient(120%_90%_at_50%_10%,#F4F7FB_0%,#E3E9F1_60%,#D9E0EA_100%)]';

/** Full-screen live city with floating control panels. */
export function LiveConsole() {
  const { city, error } = useDistrictCity();
  useDistrictVersionCheck(city);
  useEffect(() => {
    connectLive();
    // Handle for automated visual checks (screenshots) in development.
    if (process.env.NODE_ENV !== 'production') Object.assign(window, { __koloUi: useUi, __koloFrames: frameBuffer });
  }, []);
  if (!city) {
    return (
      <main className={cn(BACKDROP, 'grid place-items-center text-sm text-muted-foreground')}>
        {error ? `Не удалось загрузить карту района: ${error}` : 'Строим Белград…'}
      </main>
    );
  }
  return <ConsoleBody />;
}

function ConsoleBody() {
  const [searchOpen, setSearchOpen] = useState(false);
  const selected = useUi((s) => s.selection !== null);
  return (
    <main className={BACKDROP}>
      <div className="absolute inset-0">
        <CityCanvas />
        <SceneLabels />
      </div>
      <div className="pointer-events-none absolute inset-0 flex flex-col gap-2 p-2 md:gap-3 md:p-3">
        <TopBar onSearch={() => setSearchOpen(true)} />
        <div className="flex min-h-0 flex-1 items-start justify-between gap-2 md:gap-3">
          <KpiCards />
          <div className="flex shrink-0 items-start gap-3">
            <MapControls />
            <Inspector />
          </div>
        </div>
        {/* On phones the inspector is a bottom sheet and takes this row's place. */}
        <div className={cn('flex items-end justify-between gap-3', selected && 'max-md:hidden')}>
          <div className="min-w-0 max-md:hidden">
            <OrderTracker />
          </div>
          <OpsPanel />
        </div>
      </div>
      {/* Map data licence (ODbL) requires visible attribution. */}
      <a
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noreferrer"
        className="absolute bottom-0.5 left-1/2 -translate-x-1/2 rounded bg-white/60 px-1.5 text-[10px] text-muted-foreground"
      >
        © OpenStreetMap contributors
      </a>
      <CreateOrderDialog />
      <CommandSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </main>
  );
}
