/** Расписание ОТ: часы Белграда, сербские праздники и сервисные дни GTFS. */

/** Сервисы недели и добавочные даты из calendar_dates (exception_type 1). */
export interface TransitCalendar {
  /** Id сервиса по дню недели, 0 — воскресенье. */
  week: string[];
  /** Пары [дата YYYYMMDD, id сервиса]. */
  extra: [string, string][];
}

export interface BelgradeTime {
  date: string;
  /** 0 — воскресенье. */
  weekday: number;
  secOfDay: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

let belgradeFormat: Intl.DateTimeFormat | undefined;

/** Дата, день недели и секунды суток по Europe/Belgrade (с учётом перехода на летнее время). */
export function belgradeTime(epochMs: number): BelgradeTime {
  belgradeFormat ??= new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Belgrade',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of belgradeFormat.formatToParts(epochMs)) p[part.type] = part.value;
  return {
    date: `${p.year}${p.month}${p.day}`,
    weekday: WEEKDAYS[p.weekday!]!,
    secOfDay: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second),
  };
}

function ymd(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

const DAY = 86_400_000;

/** Православная Пасха (григорианская дата): юлианская по Меёсу плюс 13 дней. */
export function orthodoxEaster(year: number): string {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return ymd(Date.UTC(year, month - 1, day) + 13 * DAY);
}

/** Государственные праздники Сербии года: дата → название; воскресные переносятся на будний день. */
export function serbianHolidays(year: number): Map<string, string> {
  const out = new Map<string, string>();
  const at = (m: number, d: number) => Date.UTC(year, m - 1, d);
  const shifting: [number, string][] = [
    [at(1, 1), 'Новый год'],
    [at(1, 2), 'Новый год'],
    [at(2, 15), 'День государственности'],
    [at(2, 16), 'День государственности'],
    [at(5, 1), 'Праздник труда'],
    [at(5, 2), 'Праздник труда'],
    [at(11, 11), 'День перемирия'],
  ];
  const easter = Date.UTC(year, +orthodoxEaster(year).slice(4, 6) - 1, +orthodoxEaster(year).slice(6, 8));
  out.set(ymd(at(1, 7)), 'Рождество');
  out.set(ymd(easter - 2 * DAY), 'Страстная пятница');
  out.set(ymd(easter + DAY), 'Пасхальный понедельник');
  for (const [ms, name] of shifting) out.set(ymd(ms), name);
  for (const [ms, name] of shifting) {
    if (new Date(ms).getUTCDay() !== 0) continue;
    let next = ms + DAY;
    while (new Date(next).getUTCDay() === 6 || new Date(next).getUTCDay() === 0 || out.has(ymd(next))) next += DAY;
    out.set(ymd(next), name);
  }
  return out;
}

/** Id сервиса на дату: добавочный, иначе праздник — как воскресенье, иначе по дню недели. */
export function serviceFor(date: string, cal: TransitCalendar): string {
  for (const [d, s] of cal.extra) if (d === date) return s;
  const year = Number(date.slice(0, 4));
  const ms = Date.UTC(year, Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)));
  if (serbianHolidays(year).has(date)) return cal.week[0]!;
  return cal.week[new Date(ms).getUTCDay()]!;
}
