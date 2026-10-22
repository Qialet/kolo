import { describe, expect, it } from 'vitest';
import { belgradeTime, orthodoxEaster, serbianHolidays, serviceFor, type TransitCalendar } from './calendar.js';

const cal: TransitCalendar = {
  week: ['N', 'RD', 'RD', 'RD', 'RD', 'RD', 'S'],
  extra: [],
};

/** Праздничные даты года с понедельника по субботу. */
function workdayHolidays(year: number): string[] {
  return [...serbianHolidays(year).keys()].filter((d) => {
    const wd = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))).getUTCDay();
    return wd !== 0;
  });
}

describe('orthodoxEaster', () => {
  it('matches known dates', () => {
    expect(orthodoxEaster(2024)).toBe('20240505');
    expect(orthodoxEaster(2025)).toBe('20250420');
    expect(orthodoxEaster(2026)).toBe('20260412');
    expect(orthodoxEaster(2027)).toBe('20270502');
  });
});

describe('serbianHolidays', () => {
  it('2024 Monday-Saturday holidays', () => {
    const want = ['0101', '0102', '0215', '0216', '0501', '0502', '0503', '0506', '1111'].map((d) => '2024' + d);
    expect(workdayHolidays(2024).filter((d) => want.includes(d)).sort()).toEqual(want);
  });
  it('2025 holidays with Sunday substitution', () => {
    const h = serbianHolidays(2025);
    for (const d of ['0101', '0102', '0107', '0215', '0217', '0418', '0421', '0501', '0502']) {
      expect(h.has('2025' + d)).toBe(true);
    }
  });
  it('2023 New Year on Sunday moves to 3 January', () => {
    const h = serbianHolidays(2023);
    expect(h.has('20230102')).toBe(true);
    expect(h.has('20230103')).toBe(true);
  });
  it('does not treat Holy Saturday as a holiday and names in Russian', () => {
    const h = serbianHolidays(2025);
    expect(h.has('20250419')).toBe(false);
    expect(h.get('20250101')).toBe('Новый год');
    expect(h.get('20250107')).toBe('Рождество');
    expect(h.get('20250418')).toBe('Страстная пятница');
    expect(h.get('20250421')).toBe('Пасхальный понедельник');
  });
});

describe('belgradeTime', () => {
  it('handles the spring DST jump', () => {
    const t = belgradeTime(Date.parse('2026-03-29T01:30:00Z'));
    expect(t.date).toBe('20260329');
    expect(t.weekday).toBe(0);
    expect(t.secOfDay).toBe(3 * 3600 + 1800);
  });
  it('handles the autumn DST fallback', () => {
    const t = belgradeTime(Date.parse('2026-10-25T01:30:00Z'));
    expect(t.secOfDay).toBe(2 * 3600 + 1800);
  });
  it('rolls the date over at local midnight', () => {
    const t = belgradeTime(Date.parse('2026-10-22T22:30:00Z'));
    expect(t.date).toBe('20261023');
    expect(t.secOfDay).toBe(30 * 60);
  });
});

describe('serviceFor', () => {
  it('weekday, holiday, saturday', () => {
    expect(serviceFor('20261022', cal)).toBe('RD');
    expect(serviceFor('20261111', cal)).toBe('N');
    expect(serviceFor('20270107', cal)).toBe('N');
    expect(serviceFor('20261024', cal)).toBe('S');
  });
  it('extra dates win', () => {
    expect(serviceFor('20261022', { ...cal, extra: [['20261022', 'X']] })).toBe('X');
  });
});
