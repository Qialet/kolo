'use client';

import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import type { Tone } from '@/lib/palette';
import { cn } from '@/lib/utils';

const TONE_CLASS: Record<Tone, string> = {
  taxi: 'bg-taxi/20 text-taxi-foreground',
  bus: 'bg-bus/12 text-bus',
  depot: 'bg-depot/12 text-depot',
  service: 'bg-service/14 text-service',
  success: 'bg-pickup/14 text-pickup',
  danger: 'bg-destructive/12 text-destructive',
  muted: 'bg-muted text-muted-foreground',
  info: 'bg-bus/12 text-bus',
};

export function StatusBadge({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <Badge variant="secondary" className={cn(TONE_CLASS[tone], className)}>
      {children}
    </Badge>
  );
}

export function KoloLogo({ className, wordmarkClassName }: { className?: string; wordmarkClassName?: string }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
        <rect width="32" height="32" rx="9" className="fill-foreground" />
        <circle cx="16" cy="16" r="8.5" fill="none" strokeWidth="3.2" className="stroke-taxi" />
        <circle cx="16" cy="16" r="2.6" className="fill-taxi" />
        <path d="M16 7.5v4M16 20.5v4M7.5 16h4M20.5 16h4" strokeWidth="2" className="stroke-taxi" strokeLinecap="round" />
      </svg>
      <div className={cn('leading-none whitespace-nowrap', wordmarkClassName)}>
        <div className="text-[17px] font-bold tracking-tight">Kolo</div>
        <div className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Fleet control · Beograd</div>
      </div>
    </div>
  );
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

export const fmtMeters = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} км` : `${Math.round(m)} м`);
export const fmtDuration = (sec: number) => {
  if (sec < 60) return `${Math.max(0, Math.round(sec))} с`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m} мин ${Math.round(sec % 60)} с` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
};
export const fmtRsd = (n: number) => `${new Intl.NumberFormat('ru-RU').format(Math.round(n))} RSD`;
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
