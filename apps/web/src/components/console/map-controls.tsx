'use client';

import { HomeIcon, MinusIcon, PlusIcon, RotateCcwIcon, RotateCwIcon, TagIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useUi } from '@/lib/ui-store';

function Control({ label, onClick, children, active }: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant={active ? 'secondary' : 'ghost'} size="icon" onClick={onClick} aria-label={label} />}>{children}</TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

export function MapControls() {
  const command = useUi((s) => s.command);
  const labels = useUi((s) => s.labels);
  const toggleLabels = useUi((s) => s.toggleLabels);
  return (
    <div className="glass-panel pointer-events-auto flex flex-col items-center gap-1 p-1.5">
      <Control label="Приблизить" onClick={() => command('zoomIn')}>
        <PlusIcon />
      </Control>
      <Control label="Отдалить" onClick={() => command('zoomOut')}>
        <MinusIcon />
      </Control>
      <Separator className="my-1 w-6" />
      <Control label="Повернуть влево" onClick={() => command('rotateLeft')}>
        <RotateCcwIcon />
      </Control>
      <Control label="Повернуть вправо" onClick={() => command('rotateRight')}>
        <RotateCwIcon />
      </Control>
      <Control label="Весь район" onClick={() => command('home')}>
        <HomeIcon />
      </Control>
      <Separator className="my-1 w-6" />
      <Control label={labels ? 'Скрыть подписи' : 'Показать подписи'} onClick={toggleLabels} active={labels}>
        <TagIcon />
      </Control>
    </div>
  );
}
