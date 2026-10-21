import { BadRequestException } from '@nestjs/common';
import { CreateOrderInput, SimControlInput } from '@kolo/contracts';
import { toIso } from './time.js';
import { ZodPipe } from './zod.pipe.js';

describe('ZodPipe', () => {
  it('returns parsed data with defaults applied', () => {
    const pipe = new ZodPipe(CreateOrderInput);
    expect(pipe.transform({ pickupAddressId: 'A1', dropoffAddressId: 'A2' })).toEqual({ pickupAddressId: 'A1', dropoffAddressId: 'A2', source: 'DISPATCHER' });
  });

  it('rejects invalid input with a 400', () => {
    const pipe = new ZodPipe(SimControlInput);
    expect(() => pipe.transform({ speed: 100 })).toThrow(BadRequestException);
  });
});

describe('toIso', () => {
  it('converts Postgres timestamptz text to ISO 8601', () => {
    expect(toIso('2026-10-21 12:55:00.12+02')).toBe('2026-10-21T10:55:00.120Z');
    expect(toIso(null)).toBeNull();
  });
});
