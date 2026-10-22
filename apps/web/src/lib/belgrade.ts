'use client';

import { belgradeTime, serbianHolidays } from '@kolo/sim';
import { useEffect, useState } from 'react';
import { frameBuffer } from './live';

const TIME = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Belgrade', hour: '2-digit', minute: '2-digit' });

/** HH:MM in Belgrade. */
export const fmtClock = (ms: number) => TIME.format(ms);

/** Type of the timetable day: weekday, Saturday, Sunday, or a public holiday by name. */
export function dayLabel(ms: number): string {
  const t = belgradeTime(ms);
  const holiday = serbianHolidays(Number(t.date.slice(0, 4))).get(t.date);
  if (holiday) return `праздник · ${holiday}`;
  return t.weekday === 0 ? 'воскресенье' : t.weekday === 6 ? 'суббота' : 'будний день';
}

/** «через N мин» from the simulation clock; «сейчас» within half a minute. */
export function untilLabel(at: number, clock: number): string {
  const min = Math.round((at - clock) / 60_000);
  return min <= 0 ? 'сейчас' : `через ${min} мин`;
}

/** Timetable adherence: on time within a minute either way. */
export function delayInfo(sec: number): { label: string; late: boolean; onTime: boolean } {
  const min = Math.round(Math.abs(sec) / 60);
  if (Math.abs(sec) < 60) return { label: 'по расписанию', late: false, onTime: true };
  return sec > 0 ? { label: `опаздывает на ${min} мин`, late: true, onTime: false } : { label: `раньше на ${min} мин`, late: false, onTime: false };
}

/** The simulation's Belgrade clock from the latest frame and the wall clock, refreshed once a second. */
export function useSimClock(): { clock: number | null; wall: number } {
  const [now, setNow] = useState<{ clock: number | null; wall: number }>({ clock: null, wall: 0 });
  useEffect(() => {
    const tick = () => setNow({ clock: frameBuffer.latest?.clock ?? null, wall: Date.now() });
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);
  return now;
}
