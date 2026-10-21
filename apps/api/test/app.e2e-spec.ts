import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

// Needs the local Postgres from .env (see CLAUDE.md).
describe('Kolo API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health', () => request(app.getHttpServer()).get('/api/health').expect(200).expect({ ok: true, service: 'kolo-api' }));

  it('GET /api/fleet/parks lists the three partner depots', async () => {
    const res = await request(app.getHttpServer()).get('/api/fleet/parks').expect(200);
    expect(res.body.map((p: { id: string }) => p.id)).toEqual(['P1', 'P2', 'P3']);
    for (const p of res.body as { x: number | null; z: number | null; capacity: number; counts: { total: number } }[]) {
      expect(typeof p.x).toBe('number');
      expect(typeof p.z).toBe('number');
      expect(p.capacity).toBeGreaterThanOrEqual(p.counts.total);
    }
    expect(res.body.map((p: { counts: { total: number } }) => p.counts.total)).toEqual([24, 18, 18]);
  });

  it('GET /api/sim/state reports the district version', async () => {
    const res = await request(app.getHttpServer()).get('/api/sim/state').expect(200);
    expect(res.body.districtVersion).toMatch(/^[0-9a-f]{8}$/);
  });
});
