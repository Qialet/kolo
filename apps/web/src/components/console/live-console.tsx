'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { SceneLabels } from '@/components/scene/scene-labels';
import { connectLive, frameBuffer } from '@/lib/live';
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

/** Full-screen live city with floating control panels. */
export function LiveConsole() {
  const [searchOpen, setSearchOpen] = useState(false);
  const selected = useUi((s) => s.selection !== null);
  useEffect(() => {
    connectLive();
    // Handle for automated visual checks (screenshots) in development.
    if (process.env.NODE_ENV !== 'production') Object.assign(window, { __koloUi: useUi, __koloFrames: frameBuffer });
  }, []);
  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[radial-gradient(120%_90%_at_50%_10%,#F4F7FB_0%,#E3E9F1_60%,#D9E0EA_100%)]">
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
      <CreateOrderDialog />
      <CommandSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </main>
  );
}
